import { config } from '../config.js';
import * as cards from '../ui/cards.js';
import { humanBytes } from '../utils/format.js';
import { isSelfDestruct, mediaKind } from '../services/mediaInfo.js';

export function createCommandHandler(ctx) {
  const { client, store, queue, me } = ctx;

  const edit = (msg, text) => msg.edit({ text, parseMode: 'html', linkPreview: false }).catch(() => {});

  async function collectAlbum(peer, anchor) {
    const ids = [];
    for (let i = anchor.id - 20; i <= anchor.id + 20; i += 1) {
      if (i > 0) ids.push(i);
    }
    const batch = await client.getMessages(peer, { ids }).catch(() => []);
    const gid = String(anchor.groupedId);
    return (batch || []).filter(
      (m) => m && m.media && m.groupedId && String(m.groupedId) === gid,
    );
  }

  return async function handle(event) {
    const msg = event.message;
    const parts = (msg.message || '').trim().split(/\s+/);
    const cmd = parts[0].toLowerCase().replace(/@\w+$/, '');
    const args = parts.slice(1);
    const chatKey = String(msg.chatId);

    switch (cmd) {
      case '/ping': {
        const latency = Math.max(0, Date.now() - msg.date * 1000);
        await edit(msg, cards.pingCard({ latency, uptime: Date.now() - ctx.startedAt }));
        return;
      }
      case '/help':
      case '/start':
        await edit(msg, cards.helpCard());
        return;
      case '/status': {
        await edit(msg, cards.statusCard({
          uptime: Date.now() - ctx.startedAt,
          rss: process.memoryUsage().rss,
          node: process.version,
          archived: store.data.stats.archived,
          bytes: store.data.stats.bytes,
          pending: queue.pending,
          running: queue.running,
          autos: Object.keys(store.data.autoSave).length,
        }));
        return;
      }
      case '/auto': {
        if (String(me.id) === chatKey) {
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
        let targets = [reply];
        if (reply.groupedId) {
          targets = await collectAlbum(msg.inputChat ?? msg.chatId, reply);
          if (!targets.length) targets = [reply];
        }
        const media = targets.filter((m) => m && m.media);
        if (!media.length) {
          await edit(msg, cards.noMedia());
          return;
        }
        media.sort((a, b) => a.id - b.id);
        const head = media[0];
        const urgent = isSelfDestruct(head);
        await edit(msg, cards.queuedCard({
          kind: mediaKind(head) || 'رسانه 📎',
          size: humanBytes(head.file?.size || 0),
          pos: queue.pending + 1,
          urgent,
        }));
        await queue.add(
          { messages: media, statusMsg: msg, explicit: true },
          { priority: urgent },
        );
        return;
      }
      default:
        return;
    }
  };
}
