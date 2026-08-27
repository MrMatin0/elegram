import * as cards from '../ui/cards.js';
import { cmd } from '../constants.js';
import { humanBytes } from '../utils/format.js';
import { idStr, isSelfDestruct, mediaKind, mediaSize } from '../services/mediaInfo.js';
import { resolveLinkedMessage, resolveTargetChat } from '../services/lookup.js';
import { isNotModified } from '../utils/retry.js';
import { log, errText } from '../utils/logger.js';

// A Telegram album holds at most 10 items, so a narrow id window is enough.
const ALBUM_SPAN = 10;

export function createCommandHandler(ctx) {
  const { client, store, queue, me, archiver, version } = ctx;
  const myId = idStr(me?.id);

  // editMessage(entity, { message, text }): `message` is the *target id*, the
  // new body goes in `text`. There is no `id` option — passing the text as
  // `message` made the library look for a message id in a string, so every
  // edit was rejected and every command looked dead.
  const edit = (msg, text) =>
    client
      .editMessage(msg.peerId ?? msg.chatId, {
        message: msg.id,
        text,
        parseMode: 'html',
        linkPreview: false,
      })
      .catch((error) => {
        if (!isNotModified(error)) log.warn('ویرایش پیام دستور ناموفق بود:', errText(error));
      });

  const peerOf = async (msg) => {
    try {
      return (await msg.getInputChat?.()) ?? msg.peerId ?? msg.chatId;
    } catch {
      return msg.peerId ?? msg.chatId;
    }
  };

  const chatLabel = (msg, chatKey) =>
    msg.chat?.title || msg.chat?.firstName || msg.chat?.username || `چت ${chatKey}`;

  /** Deletes our own command for everyone. A failed cleanup never stops a save. */
  const removeMessage = async (msg) => {
    if (!msg?.id) return;
    try {
      if (typeof msg.delete === 'function') await msg.delete({ revoke: true });
      else await client.deleteMessages(msg.peerId ?? msg.chatId, [msg.id], { revoke: true });
    } catch (error) {
      log.debug('حذف پیام دستور ناموفق بود:', errText(error));
    }
  };

  /**
   * True when the command already sits in the archive chat, so editing it in
   * place leaves the card exactly where the user reads their archive.
   *
   * A custom STORAGE_PEER is a different chat by definition; only the default
   * (`me` = Saved Messages) can be compared against our own id.
   */
  const inArchiveChat = (msg) => {
    const chatKey = idStr(msg?.chatId);
    if (!chatKey || !myId) return false;
    if (archiver?.dest && archiver.dest !== 'me') return false;
    return chatKey === myId;
  };

  /**
   * Opens (or updates) the card for a `.save`.
   *
   * Inside the archive chat the command message *becomes* the card, as before.
   * Anywhere else — groups, channels, other DMs — the command has already been
   * deleted, so a fresh card is opened in the archive chat instead: a shared
   * group never sees our queue/download/upload chatter.
   *
   * @returns the message the archiver may keep editing, or null.
   */
  const openCard = async (msg, text, local) => {
    if (local) {
      await edit(msg, text);
      return msg;
    }
    try {
      return await archiver.sendText(text);
    } catch (error) {
      log.warn('نوشتن کارت وضعیت در آرشیو ناموفق بود:', errText(error));
      return null;
    }
  };

  /**
   * Collects every sibling of an album.
   *
   * v1 asked for a hand-built id range via `getMessages({ ids })`, which pulls
   * up to 21 mostly-nonexistent ids and throws on some peers. Walking history
   * around the anchor is both cheaper and correct.
   */
  async function collectAlbum(peer, anchor) {
    const groupId = idStr(anchor?.groupedId);
    if (!groupId) return [anchor];

    const found = new Map([[anchor.id, anchor]]);
    try {
      for await (const item of client.iterMessages(peer, {
        limit: ALBUM_SPAN * 3,
        offsetId: anchor.id + ALBUM_SPAN + 1,
        minId: Math.max(0, anchor.id - ALBUM_SPAN - 1),
      })) {
        if (item?.media && idStr(item.groupedId) === groupId) found.set(item.id, item);
      }
    } catch (error) {
      log.warn('خواندن آلبوم ناموفق بود؛ فقط همان پیام آرشیو می‌شود.', errText(error));
    }
    return [...found.values()].sort((a, b) => a.id - b.id);
  }

  /** Persist + confirm, shared by both directions of a toggle. */
  const applyToggle = async (msg, spec, on, chatKey, title, username = '') => {
    if (myId && myId === chatKey) {
      await edit(msg, cards.savedGuard(spec.name));
      return;
    }
    if (spec.is(chatKey) === on) {
      await edit(msg, spec.already(title, on, chatKey));
      return;
    }
    spec.set(chatKey, title, on, username);
    await edit(msg, on ? spec.on(title, chatKey) : spec.off(title, chatKey));
  };

  /** `.auto on|off` — the chat the command was sent in. */
  const toggleHere = (msg, spec, on) => {
    const chatKey = idStr(msg.chatId);
    return applyToggle(msg, spec, on, chatKey, chatLabel(msg, chatKey), msg.chat?.username ?? '');
  };

  /**
   * `.auto @channel` / `.auto off -100…` — a chat named by argument.
   *
   * For `off` a key already in the list outranks any lookup: a channel we were
   * kicked from cannot be resolved anymore, and that is exactly when removing it
   * from the list has to keep working.
   */
  const toggleThere = async (msg, spec, on, raw) => {
    const found = await resolveTargetChat(client, raw, {
      store,
      bucket: spec.bucket,
      preferStored: !on,
    });
    if (found.failure) {
      await edit(msg, cards.targetError(spec.name, found.failure, raw));
      return;
    }
    await applyToggle(msg, spec, on, found.chatKey, found.title, found.username);
  };

  /**
   * `.auto` and `.mirror` are the same three-state toggle over different
   * storage, so the flow (validate, refuse a no-op, persist, confirm) is written
   * once. Three shapes are accepted:
   *
   *   `.mirror on` | `.mirror off`         this chat
   *   `.mirror <target>`                   that chat — `on` is implied
   *   `.mirror on|off <target>`            that chat, spelled out
   *
   * The target forms are not sugar: `.mirror on` must be typed *inside* the chat
   * it turns on, which a broadcast channel and any read-only group forbid. Those
   * are precisely the chats worth mirroring, so they get named from the outside.
   */
  const toggleChat = (msg, args, spec) => {
    const head = (args[0] || '').toLowerCase();
    const explicit = head === 'on' || head === 'off';
    const target = (explicit ? args.slice(1) : args).join(' ').trim();
    // A bare target is an opt-in: `.mirror @channel` means turn it on.
    if (target) return toggleThere(msg, spec, explicit ? head === 'on' : true, target);
    if (!explicit) return edit(msg, spec.usage());
    return toggleHere(msg, spec, head === 'on');
  };

  const AUTO = {
    name: 'auto',
    bucket: 'autoSave',
    is: (chatKey) => store.isAuto(chatKey),
    set: (chatKey, title, on, username) => store.setAuto(chatKey, title, on, username),
    usage: cards.autoUsage,
    already: cards.autoAlready,
    on: cards.autoOn,
    off: cards.autoOff,
  };

  const MIRROR = {
    name: 'mirror',
    bucket: 'mirror',
    is: (chatKey) => store.isMirror(chatKey),
    set: (chatKey, title, on, username) => store.setMirror(chatKey, title, on, username),
    usage: cards.mirrorUsage,
    already: cards.mirrorAlready,
    on: cards.mirrorOn,
    off: cards.mirrorOff,
  };

  const handlers = {
    [cmd('ping')]: async (msg) => {
      const sentAt = (Number(msg.date) || 0) * 1000;
      const latency = sentAt ? Math.max(0, Date.now() - sentAt) : 0;
      await edit(msg, cards.pingCard({ latency, uptime: Date.now() - ctx.startedAt }));
    },

    [cmd('help')]: async (msg) => edit(msg, cards.helpCard()),

    [cmd('status')]: async (msg) => {
      const stats = queue.stats;
      // Read through ctx: the mirror is wired up alongside this handler.
      const mirror = ctx.mirror?.stats ?? { captured: 0, edits: 0, deletions: 0 };
      await edit(msg, cards.statusCard({
        uptime: Date.now() - ctx.startedAt,
        rss: process.memoryUsage().rss,
        node: process.version,
        version,
        dest: archiver?.dest || 'me',
        archived: store.data.stats.archived,
        bytes: store.data.stats.bytes,
        failed: store.data.stats.failed,
        pending: stats.pending,
        running: stats.running,
        autos: store.autoCount,
        mirrors: store.mirrorCount,
        mirrored: mirror.captured,
        mirrorEdits: mirror.edits,
        mirrorDeletes: mirror.deletions,
      }));
    },

    [cmd('auto')]: (msg, args) => toggleChat(msg, args, AUTO),

    [cmd('autolist')]: async (msg) => edit(msg, cards.autoList(store.autoEntries())),

    /**
     * Live mirroring of a chat: every message is copied to the archive on
     * arrival, and any later edit or delete is reported against that copy.
     */
    [cmd('mirror')]: (msg, args) => toggleChat(msg, args, MIRROR),

    [cmd('mirrorlist')]: async (msg) => edit(msg, cards.mirrorList(store.mirrorEntries())),

    [cmd('cancel')]: async (msg) => {
      const dropped = queue.clear('لغو دستی توسط کاربر');
      await edit(msg, cards.cancelCard(dropped));
    },

    /**
     * Two ways to name a target:
     *   `.save`        — replying to the media (works wherever we may post)
     *   `.save <link>` — the post link, for channels with forwarding disabled,
     *                    where there is nothing of ours to reply to.
     *
     * Outside the archive chat the command is deleted before any network work
     * and every card is written to the archive chat, so a group is left clean.
     */
    [cmd('save')]: async (msg, args) => {
      const local = inArchiveChat(msg);
      // Delete first, talk later: the trace must vanish even if the save fails.
      if (!local) await removeMessage(msg);
      const say = (text) => openCard(msg, text, local);

      const argument = args.join(' ').trim();
      let anchor = null;
      let peer = null;

      if (argument) {
        // An explicit link outranks a reply: it is the more deliberate target.
        const found = await resolveLinkedMessage(client, argument);
        if (found.failure) {
          await say(cards.linkError(found.failure));
          return;
        }
        anchor = found.message;
        peer = found.peer;
      } else {
        anchor = await msg.getReplyMessage().catch(() => null);
        if (anchor) peer = await peerOf(msg);
      }

      if (!anchor) {
        await say(cards.notReply());
        return;
      }

      const targets = anchor.groupedId ? await collectAlbum(peer, anchor) : [anchor];
      const media = targets.filter((item) => item?.media);
      if (!media.length) {
        await say(cards.noMedia());
        return;
      }
      media.sort((a, b) => a.id - b.id);

      const head = media[0];
      const urgent = media.some(isSelfDestruct);
      const statusMsg = await say(cards.queuedCard({
        kind: mediaKind(head) ?? 'رسانه \u{1F4CE}',
        size: humanBytes(media.reduce((sum, item) => sum + mediaSize(item), 0)),
        pos: queue.positionFor({ priority: urgent }),
        urgent,
      }));

      // Failures are already surfaced on the status message by the archiver.
      await queue
        .add({ messages: media, statusMsg, explicit: true }, { priority: urgent })
        .catch(() => {});
    },
  };

  handlers[cmd('start')] = handlers[cmd('help')];

  return async function handle(event) {
    const msg = event.message;
    if (!msg) return;
    const parts = String(msg.message || '').trim().split(/\s+/);
    // Strip a trailing @username so `.status@me` still routes.
    const name = (parts[0] || '').toLowerCase().replace(/@[\w_]+$/, '');
    const run = handlers[name];
    if (!run) return;
    await run(msg, parts.slice(1));
  };
}
