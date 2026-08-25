import path from 'node:path';
import { NewMessage } from 'teleproto/events';
import { config } from '../config.js';
import { Archiver } from '../services/archiver.js';
import { TaskQueue } from '../services/queue.js';
import { AlbumBuffer } from '../services/albums.js';
import { isSelfDestruct, isExpiring } from '../services/mediaInfo.js';
import { createCommandHandler } from './commands.js';
import { log, errText } from '../utils/logger.js';

const SEEN_LIMIT = 2000;

// Commands are ordinary outgoing messages, so the builder can filter them
// before we ever see them instead of us re-checking `out` by hand.
const COMMAND_PATTERN = /^\s*\/[a-z]/i;

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
    if (!msg?.media || alreadyHandled(msg)) return;
    const chatKey = msg.chatId != null ? String(msg.chatId) : '';
    // Saved Messages is the archive destination, never a source.
    if (me?.id != null && chatKey === String(me.id)) return;
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

  // Two builders, each with its own filter, so the library sorts commands from
  // media for us. Callbacks guard themselves: teleproto has no chain-level
  // error hook, and a throw inside a handler must not reach the update loop.
  const commandFilter = new NewMessage({ outgoing: true, pattern: COMMAND_PATTERN });
  const handleCommand = async (event) => {
    try {
      await onCommand(event);
    } catch (error) {
      log.error('خطای اجرای دستور:', errText(error));
    }
  };

  const mediaFilter = new NewMessage({ incoming: true });
  const handleMedia = (event) => {
    try {
      const msg = event.message;
      if (!msg || msg.service) return;
      onIncoming(msg);
    } catch (error) {
      log.error('خطای پردازش رسانه:', errText(error));
    }
  };

  // `addEventHandler(callback, builder)` is the whole subscription model in
  // teleproto. There is no `client.updates` chain to hang handlers off, so the
  // previous wiring registered nothing at all and every command went unheard.
  client.addEventHandler(handleCommand, commandFilter);
  client.addEventHandler(handleMedia, mediaFilter);

  ctx.dispose = () => {
    // Removal needs the exact same callback *and* builder references.
    client.removeEventHandler(handleCommand, commandFilter);
    client.removeEventHandler(handleMedia, mediaFilter);
    albums.dispose();
    queue.clear('خاموشی سرویس');
  };

  log.ok('هندلرها فعال شدند — منتظر پیام‌ها…');
}
