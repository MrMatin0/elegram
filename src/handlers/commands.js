import * as cards from '../ui/cards.js';
import { humanBytes } from '../utils/format.js';
import { idStr, isSelfDestruct, mediaKind, mediaSize } from '../services/mediaInfo.js';
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

  /**
   * Collects every sibling of an album.
   *
   * v1 asked for a hand-built id range via `getMessages({ ids })`, which pulls
   * up to 21 mostly-nonexistent ids and throws on some peers. Walking history
   * around the anchor is both cheaper and correct.
   */
  async function collectAlbum(msg, anchor) {
    const groupId = idStr(anchor?.groupedId);
    if (!groupId) return [anchor];

    const found = new Map([[anchor.id, anchor]]);
    try {
      const peer = await peerOf(msg);
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

  const handlers = {
    '/ping': async (msg) => {
      const sentAt = (Number(msg.date) || 0) * 1000;
      const latency = sentAt ? Math.max(0, Date.now() - sentAt) : 0;
      await edit(msg, cards.pingCard({ latency, uptime: Date.now() - ctx.startedAt }));
    },

    '/help': async (msg) => edit(msg, cards.helpCard()),

    '/status': async (msg) => {
      const stats = queue.stats;
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
      }));
    },

    '/auto': async (msg, args) => {
      const chatKey = idStr(msg.chatId);
      // Saved Messages is the archive destination; auto-saving it would loop.
      if (myId && myId === chatKey) {
        await edit(msg, cards.savedGuard());
        return;
      }
      const state = (args[0] || '').toLowerCase();
      if (state !== 'on' && state !== 'off') {
        await edit(msg, cards.autoUsage());
        return;
      }
      const on = state === 'on';
      const title = chatLabel(msg, chatKey);
      const wasOn = store.isAuto(chatKey);
      if (wasOn === on) {
        await edit(msg, cards.autoAlready(title, on));
        return;
      }
      store.setAuto(chatKey, title, on);
      await edit(msg, on ? cards.autoOn(title) : cards.autoOff(title));
    },

    '/autolist': async (msg) => edit(msg, cards.autoList(store.autoEntries())),

    '/cancel': async (msg) => {
      const dropped = queue.clear('لغو دستی توسط کاربر');
      await edit(msg, cards.cancelCard(dropped));
    },

    '/save': async (msg) => {
      const reply = await msg.getReplyMessage().catch(() => null);
      if (!reply) {
        await edit(msg, cards.notReply());
        return;
      }

      const targets = reply.groupedId ? await collectAlbum(msg, reply) : [reply];
      const media = targets.filter((item) => item?.media);
      if (!media.length) {
        await edit(msg, cards.noMedia());
        return;
      }
      media.sort((a, b) => a.id - b.id);

      const head = media[0];
      const urgent = media.some(isSelfDestruct);
      await edit(msg, cards.queuedCard({
        kind: mediaKind(head) ?? 'رسانه \u{1F4CE}',
        size: humanBytes(media.reduce((sum, item) => sum + mediaSize(item), 0)),
        pos: queue.positionFor({ priority: urgent }),
        urgent,
      }));

      // Failures are already surfaced on the status message by the archiver.
      await queue
        .add({ messages: media, statusMsg: msg, explicit: true }, { priority: urgent })
        .catch(() => {});
    },
  };

  handlers['/start'] = handlers['/help'];

  return async function handle(event) {
    const msg = event.message;
    if (!msg) return;
    const parts = String(msg.message || '').trim().split(/\s+/);
    // Strip a trailing @username so `/status@me` still routes.
    const cmd = (parts[0] || '').toLowerCase().replace(/@[\w_]+$/, '');
    const run = handlers[cmd];
    if (!run) return;
    await run(msg, parts.slice(1));
  };
}
