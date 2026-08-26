import * as cards from '../ui/cards.js';
import { cmd } from '../constants.js';
import { humanBytes } from '../utils/format.js';
import { idStr, isSelfDestruct, mediaKind, mediaSize } from '../services/mediaInfo.js';
import { CHAT_FAILURES, resolveChat, resolveLinkedMessage } from '../services/lookup.js';
import { log, errText } from '../utils/logger.js';

// A Telegram album holds at most 10 items, so a narrow id window is enough.
const ALBUM_SPAN = 10;

/** The only two words that are a state and never a chat target. */
const STATES = new Set(['on', 'off']);

export function createCommandHandler(ctx) {
  const { client, store, queue, me, archiver, version } = ctx;
  const myId = idStr(me?.id);

  /**
   * Every answer is written to the archive chat.
   *
   * Nothing is ever posted back into the source chat, and the command itself is
   * already gone by the time this runs, so a group is left with no trace of us
   * whatsoever — including our own queue/download/upload chatter.
   */
  const say = async (text) => {
    if (!text) return null;
    try {
      return await archiver.sendText(text);
    } catch (error) {
      log.warn('نوشتن کارت وضعیت در آرشیو ناموفق بود:', errText(error));
      return null;
    }
  };

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

  /**
   * `.mirror [<username|chat_id>] [on|off]`
   *
   * Naming a target is what makes the command usable from anywhere: Saved
   * Messages, another group, a DM. With no target it means "this chat", which is
   * how it has always worked. The target is resolved through `getEntity`, which
   * doubles as the authorization check — a chat this session cannot reach is
   * reported instead of being subscribed to and silently producing nothing.
   */
  const resolveTarget = async (msg, args) => {
    const first = String(args[0] ?? '').trim();
    const named = Boolean(first) && !STATES.has(first.toLowerCase());
    const state = String((named ? args[1] : args[0]) ?? '').toLowerCase();
    if (state && !STATES.has(state)) return { usage: true };

    const on = state !== 'off';
    if (!named) {
      const chatKey = idStr(msg.chatId);
      return { on, target: { chatKey, title: chatLabel(msg, chatKey) } };
    }
    const found = await resolveChat(client, first);
    if (found.failure) return { on, input: first, failure: found.failure };
    return { on, input: first, target: found };
  };

  const handlers = {
    [cmd('ping')]: async (msg) => {
      const sentAt = (Number(msg.date) || 0) * 1000;
      const latency = sentAt ? Math.max(0, Date.now() - sentAt) : 0;
      await say(cards.pingCard({ latency, uptime: Date.now() - ctx.startedAt }));
    },

    [cmd('help')]: async () => say(cards.helpCard()),

    [cmd('status')]: async () => {
      const stats = queue.stats;
      // Read through ctx: the mirror is wired up alongside this handler.
      const mirror = ctx.mirror?.stats ?? { captured: 0, edits: 0, deletions: 0 };
      await say(cards.statusCard({
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
        mirrors: store.mirrorCount,
        mirrored: mirror.captured,
        mirrorEdits: mirror.edits,
        mirrorDeletes: mirror.deletions,
        mirrorMapped: store.mirrorMapSize,
      }));
    },

    /**
     * Live mirroring of a chat: every message is archived as-is on arrival, and
     * any later edit or delete is reported against that archived copy.
     */
    [cmd('mirror')]: async (msg, args) => {
      const resolved = await resolveTarget(msg, args);
      if (resolved.usage) {
        await say(cards.mirrorUsage());
        return;
      }
      if (resolved.failure) {
        await say(resolved.failure === CHAT_FAILURES.ACCESS
          ? cards.chatNoAccess(resolved.input)
          : cards.chatNotFound(resolved.input));
        return;
      }

      const { chatKey, title } = resolved.target;
      // Saved Messages is the archive destination; mirroring it would loop.
      if (!chatKey || (myId && myId === chatKey)) {
        await say(cards.savedGuard('mirror'));
        return;
      }
      if (store.isMirror(chatKey) === resolved.on) {
        await say(cards.mirrorAlready(title, resolved.on));
        return;
      }
      store.setMirror(chatKey, title, resolved.on);
      await say(resolved.on ? cards.mirrorOn(title) : cards.mirrorOff(title));
    },

    [cmd('mirrorlist')]: async () => say(cards.mirrorList(store.mirrorEntries())),

    [cmd('cancel')]: async () => {
      const dropped = queue.clear('لغو دستی توسط کاربر');
      await say(cards.cancelCard(dropped));
    },

    /**
     * Two ways to name a target:
     *   `.save`        — replying to the media (works wherever we may post)
     *   `.save <link>` — the post link, for channels with forwarding disabled,
     *                    where there is nothing of ours to reply to.
     */
    [cmd('save')]: async (msg, args) => {
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
    // Delete first, talk later: a management command must never linger in the
    // source chat while we do slow network work, and it must not survive a
    // failure either.
    await removeMessage(msg);
    await run(msg, parts.slice(1));
  };
}
