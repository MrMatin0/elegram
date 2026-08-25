// Documented subpath — see the note in services/client.js about why
// `teleproto/events/index.js` cannot work.
import { NewMessage } from 'teleproto/events';
import { Archiver } from '../services/archiver.js';
import { TaskQueue } from '../services/queue.js';
import { AlbumBuffer } from '../services/albums.js';
import { idStr, isExpiring, isSelfDestruct } from '../services/mediaInfo.js';
import { LruSet } from '../utils/lru.js';
import { createCommandHandler } from './commands.js';
import { log, errText } from '../utils/logger.js';

// Commands are ordinary outgoing messages, so let the builder filter them out
// before we ever see them instead of re-checking `out` by hand.
const COMMAND_PATTERN = /^\s*\/[a-zA-Z]/;

export function registerHandlers(ctx, config) {
  const { client, store, me } = ctx;
  const myId = idStr(me?.id);

  const archiver = new Archiver(client, store, {
    tmpDir: config.tmpDir,
    dest: config.storagePeer,
    timezone: config.timezone,
    uploadWorkers: config.uploadWorkers,
    doneReaction: config.doneReaction,
  });
  const queue = new TaskQueue((job) => archiver.runJob(job), config.concurrency);
  ctx.archiver = archiver;
  ctx.queue = queue;

  const onCommand = createCommandHandler(ctx);

  // Telegram happily replays an update after a reconnect; without this a file
  // gets archived twice.
  const seen = new LruSet(2048);

  /**
   * Fire-and-forget jobs must swallow their own rejection: an unhandled
   * rejection from a failed archive would otherwise take the whole process out.
   */
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
    if (!msg?.media) return;
    const chatKey = idStr(msg.chatId);
    if (seen.add(`${chatKey || '?'}|${msg.id}`)) return;
    // Saved Messages is the archive destination, never a source.
    if (myId && chatKey === myId) return;

    // TTL media is archived unconditionally and jumps the queue: the whole
    // point of this project is winning the race against the self-destruct timer.
    if (isSelfDestruct(msg)) {
      enqueue([msg], true);
      return;
    }
    if (!store.isAuto(chatKey)) return;
    if (msg.groupedId != null) {
      albums.push(`${chatKey}|${idStr(msg.groupedId)}`, msg);
      return;
    }
    enqueue([msg], isExpiring(msg));
  };

  // Two builders with their own filters, so the library sorts commands from
  // media for us. Both callbacks guard themselves: teleproto has no chain-level
  // error hook and a throw inside a handler must not reach the update loop.
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

  // `addEventHandler(callback, builder)` is the entire subscription model in
  // teleproto — there is no `client.updates` chain to hang handlers off.
  client.addEventHandler(handleCommand, commandFilter);
  client.addEventHandler(handleMedia, mediaFilter);

  ctx.dispose = () => {
    // Removal needs the exact same callback *and* builder references.
    client.removeEventHandler(handleCommand, commandFilter);
    client.removeEventHandler(handleMedia, mediaFilter);
    albums.dispose();
    queue.close('خاموشی سرویس');
  };

  log.ok('هندلرها فعال شدند — منتظر پیام‌ها…');
  return { archiver, queue, albums };
}
