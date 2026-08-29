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
import { AlbumBuffer } from '../services/albums.js';
import { MirrorService } from '../services/mirror.js';
import { FirstCommentService } from '../services/comment.js';
import { idStr, isExpiring, isSelfDestruct } from '../services/mediaInfo.js';
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
  const firstComment = new FirstCommentService(client, store, archiver, {
    delayMs: config.firstCommentDelayMs,
    attempts: config.firstCommentAttempts,
    pollMs: config.firstCommentPollMs,
    timeoutMs: config.firstCommentTimeoutMs,
    sendGapMs: config.firstCommentSendGapMs,
    join: config.firstCommentJoin,
    warm: config.firstCommentWarm,
    timezone: config.timezone,
    myId,
  });
  ctx.archiver = archiver;
  ctx.queue = queue;
  ctx.mirror = mirror;
  ctx.firstComment = firstComment;

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

  /** Media archiving: TTL always, plus every chat that is auto-saved or mirrored. */
  const onIncoming = (msg, chatKey) => {
    if (!msg?.media) return;
    if (seen.add(`${chatKey || '?'}|${msg.id}`)) return;

    // TTL media is archived unconditionally and jumps the queue: the whole
    // point of this project is winning the race against the self-destruct timer.
    if (isSelfDestruct(msg)) {
      enqueue([msg], true);
      return;
    }
    // A mirrored chat implies its media: a deleted photo is worth as much as a
    // deleted sentence.
    if (!store.isWatched(chatKey)) return;
    if (msg.groupedId != null) {
      albums.push(`${chatKey}|${idStr(msg.groupedId)}`, msg);
      return;
    }
    enqueue([msg], isExpiring(msg));
  };

  /**
   * A candidate for the first comment. The service does every check itself
   * (configured channel? a real post? not one of our own commands? already
   * commented on?), so both directions can hand it everything they see.
   *
   * `noteCopy` comes first and is the fast path: a post's auto-forwarded copy in
   * the linked discussion group is an ordinary message on this very stream, and
   * it is the message a comment has to reply to. Recognising it here means the
   * comment goes out the moment the copy lands, instead of after a lookup that
   * can only answer later.
   */
  const onPost = (msg) => {
    try {
      firstComment.noteCopy(msg);
      void firstComment.onPost(msg);
    } catch (error) {
      log.error('خطای پردازش کامنت اول:', errText(error));
    }
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
      // The mirror copy is sent first so the original is on the record before
      // any (slower) media download starts.
      if (store.isMirror(chatKey)) void mirror.capture(msg);
      onPost(msg);
      onIncoming(msg, chatKey);
    } catch (error) {
      log.error('خطای پردازش پیام:', errText(error));
    }
  };

  /**
   * Our own messages, for the sake of one feature only.
   *
   * A post *you* publish in *your own* channel arrives with `out: true`, so the
   * incoming builder above never sees it — and a channel you run is exactly the
   * one you want the first comment on. Nothing else reads this stream.
   */
  const handleOutgoing = (event) => {
    try {
      const msg = event.message;
      if (!msg || msg.service) return;
      onPost(msg);
    } catch (error) {
      log.error('خطای پردازش پست خودی:', errText(error));
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
  subscribe('NewMessage(outgoing)', events.NewMessage, { outgoing: true }, handleOutgoing);

  // Both subscriptions are attempted, always. Chaining them with `&&` meant a
  // build missing only `EditedMessage` never even tried to register the delete
  // handler — losing the one feature that cannot be recovered after the fact.
  const watchesEdits = subscribe('EditedMessage', events.EditedMessage, {}, handleEdited);
  const watchesDeletes = subscribe('DeletedMessage', events.DeletedMessage, {}, handleDeleted);
  const watching = watchesEdits && watchesDeletes;

  ctx.dispose = () => {
    for (const [callback, builder] of subscriptions) client.removeEventHandler(callback, builder);
    subscriptions.length = 0;
    albums.dispose();
    queue.close('خاموشی سرویس');
  };

  log.ok('هندلرها فعال شدند — منتطر پیام‌ها…');
  if (store.mirrorCount) {
    log.info(`آینه فعال روی ${store.mirrorCount} چت${watching ? '' : ' (بدون رهگیری ویرایش/حذف)'}`);
  }
  if (store.firstCommentCount) {
    log.info(`کامنت اول فعال روی ${store.firstCommentCount} کانال${firstComment.available ? '' : ' (غیرفعال: سازنده‌های TL در دسترس نیست)'}`);
  }
  // In the background and never fatal: every round trip paid here is one the
  // first comment does not pay while a post is racing.
  void firstComment.warmUp().catch((error) => {
    log.debug('آماده‌سازی کامنت اول ناموفق بود:', errText(error));
  });
  return { archiver, queue, albums, mirror, firstComment };
}
