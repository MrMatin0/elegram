import path from 'node:path';
import { NewMessage } from 'telegram/events/index.js';
import { config } from '../config.js';
import { Archiver } from '../services/archiver.js';
import { TaskQueue } from '../services/queue.js';
import { AlbumBuffer } from '../services/albums.js';
import { isSelfDestruct, isExpiring } from '../services/mediaInfo.js';
import { createCommandHandler } from './commands.js';
import { log, errText } from '../utils/logger.js';

const SEEN_LIMIT = 2000;

export function registerHandlers(ctx) {
  const { client, store, me } = ctx;

  const archiver = new Archiver(client, store, {
    tmpDir: path.join(config.dataDir, 'tmp'),
    dest: config.storagePeer,
  });
  const queue = new TaskQueue((job) => archiver.runJob(job), config.concurrency);
  ctx.archiver = archiver;
  ctx.queue = queue;

  const onCommand = createCommandHandler(ctx);

  // Telegram can replay an update; without this a media file gets archived twice.
  const seen = new Set();
  const alreadyHandled = (msg) => {
    const key = `${msg.chatId ?? '?'}|${msg.id}`;
    if (seen.has(key)) return true;
    seen.add(key);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value);
    return false;
  };

  // Fire-and-forget jobs must swallow their rejection, otherwise a failed
  // archive becomes an unhandled rejection and takes the process down.
  const enqueue = (messages, priority = false) => {
    queue.add({ messages }, { priority }).catch((error) => {
      log.error('آرشیو خودکار ناموفق:', errText(error));
    });
  };

  const albums = new AlbumBuffer({
    windowMs: config.albumWindowMs,
    onFlush: (items) => {
      items.sort((a, b) => a.id - b.id);
      enqueue(items, items.some(isExpiring));
    },
  });

  const onIncoming = (msg) => {
    if (!msg.media || alreadyHandled(msg)) return;
    const chatKey = msg.chatId != null ? String(msg.chatId) : '';
    if (isSelfDestruct(msg)) {
      enqueue([msg], true);
      return;
    }
    if (!store.isAuto(chatKey)) return;
    if (msg.groupedId != null) {
      albums.push(`${chatKey}|${msg.groupedId}`, msg);
      return;
    }
    enqueue([msg], isExpiring(msg));
  };

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg || msg.service) return;
    try {
      if (msg.out) {
        if ((msg.message || '').trim().startsWith('/')) await onCommand(event);
        return;
      }
      if (me?.id != null && String(msg.chatId) === String(me.id)) return;
      onIncoming(msg);
    } catch (error) {
      log.error('خطای پردازش رویداد:', errText(error));
    }
  }, new NewMessage({}));

  ctx.dispose = () => {
    albums.dispose();
    queue.clear('خاموشی سرویس');
  };

  log.ok('هندلرها فعال شدند — منتظر پیام‌ها…');
}
