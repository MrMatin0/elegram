import * as cards from '../ui/cards.js';
import { humanBytes } from '../utils/format.js';
import { isSelfDestruct, mediaKind } from '../services/mediaInfo.js';
import { log, errText } from '../utils/logger.js';

// A Telegram album holds at most 10 items, so a narrow id window is enough.
const ALBUM_SPAN = 10;

export function createCommandHandler(ctx) {
  const { client, store, queue, me, archiver } = ctx;

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
        log.warn('ویرایش پیام دستور ناموفق بود:', errText(error));
      });

  async function peerOf(msg) {
    try {
      return (await msg.getInputChat?.()) ?? msg.chatId;
    } catch {
      return msg.chatId;
    }
  }

  async function collectAlbum(msg, anchor) {
    const groupId = anchor.groupedId != null ? String(anchor.groupedId) : '';
    if (!groupId) return [anchor];
    const ids = [];
    for (let id = Math.max(1, anchor.id - ALBUM_SPAN); id <= anchor.id + ALBUM_SPAN; id += 1) {
      ids.push(id);
    }
    const batch = await client.getMessages(await peerOf(msg), { ids }).catch((error) => {
      log.warn('خواندن آلبوم ناموفق بود:', errText(error));
      return [];
    });
    const found = (batch || []).filter(
      (item) => item && item.media && item.groupedId != null && String(item.groupedId) === groupId,
    );
    return found.length ? found : [anchor];
  }

  return async function handle(event) {
    const msg = event.message;
    const parts = (msg.message || '').trim().split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase().replace(/@\w+$/, '');
    const args = parts.slice(1);
    const chatKey = msg.chatId != null ? String(msg.chatId) : '';

    switch (cmd) {
      case '/ping': {
        const sentAt = (Number(msg.date) || 0) * 1000;
        const latency = sentAt ? Math.max(0, Date.now() - sentAt) : 0;
        await edit(msg, cards.pingCard({ latency, uptime: Date.now() - ctx.startedAt }));
        return;
      }

      case '/help':
      case '/start': {
        await edit(msg, cards.helpCard());
        return;
      }

      case '/status': {
        await edit(msg, cards.statusCard({
          uptime: Date.now() - ctx.startedAt,
          rss: process.memoryUsage().rss,
          node: process.version,
          dest: archiver?.dest || 'me',
          archived: store.data.stats.archived,
          bytes: store.data.stats.bytes,
          pending: queue.pending,
          running: queue.running,
          autos: Object.keys(store.data.autoSave).length,
        }));
        return;
      }

      case '/auto': {
        if (me?.id != null && String(me.id) === chatKey) {
          await edit(msg, cards.savedGuard());
          return;
        }
        const state = (args[0] || '').toLowerCase();
        if (state !== 'on' && state !== 'off') {
          await edit(msg, cards.autoUsage());
          return;
        }
        const title = msg.chat?.title || msg.chat?.firstName || `چت ${chatKey}`;
        store.setAuto(chatKey, title, state === 'on');
        await edit(msg, state === 'on' ? cards.autoOn(title) : cards.autoOff(title));
        return;
      }

      case '/autolist': {
        await edit(msg, cards.autoList(store.data.autoSave));
        return;
      }

      case '/save': {
        const reply = await msg.getReplyMessage().catch(() => null);
        if (!reply) {
          await edit(msg, cards.notReply());
          return;
        }
        const targets = reply.groupedId ? await collectAlbum(msg, reply) : [reply];
        const media = targets.filter((item) => item && item.media);
        if (!media.length) {
          await edit(msg, cards.noMedia());
          return;
        }
        media.sort((a, b) => a.id - b.id);
        const head = media[0];
        const urgent = media.some(isSelfDestruct);
        await edit(msg, cards.queuedCard({
          kind: mediaKind(head) || 'رسانه 📎',
          size: humanBytes(head.file?.size || 0),
          pos: queue.pending + 1,
          urgent,
        }));
        // Errors are already surfaced on the status message by the archiver.
        await queue.add({ messages: media, statusMsg: msg, explicit: true }, { priority: urgent })
          .catch(() => {});
        return;
      }

      default:
        return;
    }
  };
}
