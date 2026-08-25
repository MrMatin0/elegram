import path from 'node:path';
import { NewMessage } from 'telegram/events/index.js';
import { config } from '../config.js';
import { Archiver } from '../services/archiver.js';
import { TaskQueue } from '../services/queue.js';
import { AlbumBuffer } from '../services/albums.js';
import { isSelfDestruct } from '../services/mediaInfo.js';
import { createCommandHandler } from './commands.js';
import { log } from '../utils/logger.js';

export function registerHandlers(ctx) {
  const { client, store, me } = ctx;

  const archiver = new Archiver(client, store, {
    tmpDir: path.join(path.resolve(config.dataDir), 'tmp'),
    dest: config.storagePeer,
  });
  const queue = new TaskQueue((job) => archiver.runJob(job), 2);
  const albums = new AlbumBuffer(900);
  ctx.archiver = archiver;
  ctx.queue = queue;

  const onCommand = createCommandHandler(ctx);

  const enqueue = (messages, priority = false) => queue.add({ messages }, { priority });

  const onIncoming = async (msg) => {
    if (!msg.media) return;
    const chatKey = String(msg.chatId ?? '');
    if (isSelfDestruct(msg)) {
      enqueue([msg], true);
      return;
    }
    if (!store.isAuto(chatKey)) return;
    if (msg.groupedId) {
      albums.push(`${chatKey}|${msg.groupedId}`, msg, (items) => {
        items.sort((a, b) => a.id - b.id);
        enqueue(items);
      });
    } else {
      enqueue([msg]);
    }
  };

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg || msg.service) return;
    try {
      if (msg.out) {
        const text = (msg.message || '').trim();
        if (text.startsWith('/')) await onCommand(event);
        return;
      }
      if (me.id != null && String(msg.chatId) === String(me.id)) return;
      await onIncoming(msg);
    } catch (e) {
      log.error('event error:', e?.message || e);
    }
  }, new NewMessage({}));

  log.ok('هندلرها فعال شدند — منتظر پیام‌ها…');
}
