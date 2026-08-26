// teleproto declares no "exports" map, so Node resolves this subpath as a real
// directory — and ESM refuses directory imports (ERR_UNSUPPORTED_DIR_IMPORT).
// The explicit `/index.js` is the form that actually resolves.
//
// A *namespace* import is deliberate: an older teleproto build may ship without
// `EditedMessage`/`DeletedMessage`, and a missing **named** export is a hard
// link-time failure in ESM — it would take the whole bot down instead of just
// disabling one feature. Here a missing builder is a warning at startup.
import * as events from 'teleproto/events/index.js';
import { COMMAND_PATTERN } from '../constants.js';
import { Archiver } from '../services/archiver.js';
import { TaskQueue } from '../services/queue.js';
import { MirrorService } from '../services/mirror.js';
import { idStr, isSelfDestruct } from '../services/mediaInfo.js';
import { LruSet } from '../utils/lru.js';
import { createCommandHandler } from './commands.js';
import { log, errText } from '../utils/logger.js';

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
  const mirror = new MirrorService(client, store, archiver, {
    timezone: config.timezone,
    myId,
  });
  ctx.archiver = archiver;
  ctx.queue = queue;
  ctx.mirror = mirror;

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

  // Every callback guards itself: teleproto has no chain-level error hook and a
  // throw inside a handler must never reach the update loop.
  const handleCommand = async (event) => {
    try {
      await onCommand(event);
    } catch (error) {
      log.error('خطای اجرای دستور:', errText(error));
    }
  };

  const handleIncoming = (event) => {
    try {
      const msg = event.message;
      if (!msg || msg.service) return;
      const chatKey = idStr(msg.chatId);
      // Saved Messages is the archive destination, never a source.
      if (myId && chatKey === myId) return;
      if (seen.add(`${chatKey || '?'}|${msg.id}`)) return;

      // A mirrored chat owns its whole stream: text and media alike are stored
      // as-is by the mirror, which also keeps the id mapping edits and deletes
      // need. Nothing else may archive the same message on top of that.
      if (store.isMirror(chatKey)) {
        void mirror.capture(msg);
        return;
      }
      // Everywhere else, TTL media is still archived unconditionally and jumps
      // the queue: winning the race against a self-destruct timer is the whole
      // point of this project.
      if (msg.media && isSelfDestruct(msg)) enqueue([msg], true);
    } catch (error) {
      log.error('خطای پردازش پیام:', errText(error));
    }
  };

  const handleEdited = (event) => {
    try {
      void mirror.onEdit(event.message);
    } catch (error) {
      log.error('خطای پردازش ویرایش:', errText(error));
    }
  };

  const handleDeleted = (event) => {
    try {
      // `updateDeleteMessages` (users, basic groups) carries no peer at all, so
      // chatId is often empty here — the mirror falls back to its id index.
      const ids = event.deletedIds ?? event.originalUpdate?.messages ?? [];
      void mirror.onDelete(ids, idStr(event.chatId));
    } catch (error) {
      log.error('خطای پردازش حذف:', errText(error));
    }
  };

  // `addEventHandler(callback, builder)` is the entire subscription model in
  // teleproto — there is no `client.updates` chain to hang handlers off — and
  // removal needs the exact same callback *and* builder references, so every
  // pair is kept for dispose().
  const subscriptions = [];
  const subscribe = (label, Builder, options, callback) => {
    if (typeof Builder !== 'function') {
      log.warn(`[events] ${label} در این نسخه teleproto موجود نیست؛ این بخش غیرفعال ماند.`);
      return false;
    }
    const builder = new Builder(options);
    client.addEventHandler(callback, builder);
    subscriptions.push([callback, builder]);
    return true;
  };

  // Commands are ordinary outgoing messages, so let the builder filter them out
  // before we ever see them instead of re-checking `out` by hand.
  subscribe('NewMessage(commands)', events.NewMessage, { outgoing: true, pattern: COMMAND_PATTERN }, handleCommand);
  subscribe('NewMessage(incoming)', events.NewMessage, { incoming: true }, handleIncoming);

  // Both subscriptions are attempted, always. Chaining them with `&&` meant a
  // build missing only `EditedMessage` never even tried to register the delete
  // handler — losing the one feature that cannot be recovered after the fact.
  const watchesEdits = subscribe('EditedMessage', events.EditedMessage, {}, handleEdited);
  const watchesDeletes = subscribe('DeletedMessage', events.DeletedMessage, {}, handleDeleted);
  const watching = watchesEdits && watchesDeletes;

  ctx.dispose = () => {
    for (const [callback, builder] of subscriptions) client.removeEventHandler(callback, builder);
    subscriptions.length = 0;
    queue.close('خاموشی سرویس');
  };

  log.ok('هندلرها فعال شدند — منتظر پیام‌ها…');
  if (store.mirrorCount) {
    log.info(`آینه فعال روی ${store.mirrorCount} چت${watching ? '' : ' (بدون رهگیری ویرایش/حذف)'}`);
  }
  return { archiver, queue, mirror };
}
