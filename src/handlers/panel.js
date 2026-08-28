/**
 * The panel controller: taps in, state out, screens rendered.
 *
 * Split of responsibilities, on purpose:
 *   ui/glass.js   what a button is, how a route is encoded in 64 bytes
 *   ui/panel.js   what a screen looks like — pure, no I/O
 *   services/bot.js  the HTTP transport and the long-poll loop
 *   this file      the only place that reads live state and mutates it
 *
 * One panel message per chat is reused for every screen: navigation edits it in
 * place instead of dropping a new card on every tap, which is what makes it feel
 * like an app rather than a chat log.
 */
import * as panel from '../ui/panel.js';
import * as cards from '../ui/cards.js';
import { ACTION, SCREEN, unpack } from '../ui/glass.js';
import { ICON } from '../ui/theme.js';
import { BotApi, isNotModified, isUnreachable } from '../services/bot.js';
import { mediaFromLink } from '../services/save.js';
import { resolveTargetChat } from '../services/lookup.js';
import { idStr, isSelfDestruct, mediaKind, mediaSize } from '../services/mediaInfo.js';
import { parseCommentInput } from '../utils/comment.js';
import { humanBytes } from '../utils/format.js';
import { log, errText, LOG_LEVELS, setLogLevel, currentLogLevel } from '../utils/logger.js';

const PROMPTS = Object.freeze({ a: 'auto', m: 'mirror', s: 'save', f: 'comment' });
const BUCKET_SCREEN = Object.freeze({ [SCREEN.AUTO]: 'autoSave', [SCREEN.MIRROR]: 'mirror' });
const CONCURRENCY_RANGE = Object.freeze({ min: 1, max: 8 });

const COMMANDS = [
  { command: 'panel', description: 'پنل کنترل' },
  { command: 'status', description: 'وضعیت و آمار' },
  { command: 'queue', description: 'صف آرشیو' },
  { command: 'id', description: 'شناسه من' },
  { command: 'help', description: 'راهنما' },
];

const freshState = () => ({
  screen: SCREEN.HOME,
  from: SCREEN.HOME,
  page: 0,
  chatKey: '',
  awaiting: null,
  confirm: null,
  notice: null,
  messageId: 0,
});

/**
 * Starts the glass panel, or explains why it stays dark.
 *
 * Returns null instead of throwing: a missing or rejected bot token must never
 * take down the archiver, which is the part that actually cannot be replaced.
 */
export async function startPanel(ctx, config, { bot: injected = null } = {}) {
  if (!config.botToken && !injected) {
    log.info('[panel] BOT_TOKEN تنطیم نشده؛ پنل شیشه‌ای غیرفعال است.');
    return null;
  }

  const { client, store, queue, archiver } = ctx;
  // Injectable so the whole routing layer can be driven in a test without a
  // token, a socket, or a single HTTP request.
  const bot = injected ?? new BotApi(config.botToken);
  const owner = String(config.panelOwner || idStr(ctx.me?.id) || '');
  const sessions = new Map();
  // Remembered so the reaction toggle can put back exactly what was configured
  // instead of inventing a thumbs-up nobody asked for.
  const configuredReaction = config.doneReaction || '\u{1F44D}';

  const stateOf = (chatId) => {
    const key = String(chatId);
    if (!sessions.has(key)) sessions.set(key, freshState());
    return sessions.get(key);
  };

  const isOwner = (from) => !owner || String(from?.id ?? '') === owner;

  // ------------------------------------------------------------------ snapshot

  const entryOf = (chatKey) =>
    store.entry?.('autoSave', chatKey)
    ?? store.entry?.('mirror', chatKey)
    ?? store.entry?.('firstComment', chatKey)
    ?? null;

  const buildView = (state) => ({
    screen: state.screen,
    from: state.from,
    page: state.page,
    awaiting: state.awaiting,
    confirm: state.confirm,
    notice: state.notice,
    system: {
      uptime: Date.now() - ctx.startedAt,
      rss: process.memoryUsage().rss,
      node: process.version,
      version: ctx.version,
      socket: Boolean(client?.connected),
      dest: archiver?.dest || 'me',
    },
    archive: {
      archived: store.data.stats.archived,
      bytes: store.data.stats.bytes,
      failed: store.data.stats.failed,
      since: store.data.stats.since,
    },
    queue: { ...queue.stats, concurrency: queue.concurrency },
    auto: store.autoEntries(),
    mirror: store.mirrorEntries(),
    comment: store.firstCommentEntries(),
    mirrorStats: ctx.mirror?.stats ?? { captured: 0, edits: 0, deletions: 0 },
    commentStats: ctx.firstComment?.stats ?? { posted: 0, failed: 0, skipped: 0 },
    settings: {
      concurrency: queue.concurrency,
      doneReaction: archiver?.doneReaction ?? '',
      logLevel: currentLogLevel(),
      storagePeer: archiver?.dest || config.storagePeer,
      uploadWorkers: config.uploadWorkers,
      maxConcurrentDownloads: config.maxConcurrentDownloads,
      albumWindowMs: config.albumWindowMs,
      firstCommentDelayMs: config.firstCommentDelayMs,
      timezone: config.timezone,
      catchUp: config.catchUp,
    },
    chat: state.chatKey
      ? {
        key: state.chatKey,
        entry: entryOf(state.chatKey),
        auto: store.isAuto(state.chatKey),
        mirror: store.isMirror(state.chatKey),
        comment: store.isFirstComment(state.chatKey),
      }
      : null,
  });

  // ------------------------------------------------------------------ rendering

  /**
   * Draws the current screen into the chat's panel message.
   *
   * `relocate` re-sends the panel and drops the old one: after the user typed
   * something, the panel has to be the last message again, and a bot cannot
   * delete an incoming message in a private chat to close the gap any other way.
   */
  const present = async (chatId, state, { relocate = false } = {}) => {
    const { text, keyboard } = panel.render(buildView(state));
    try {
      if (state.messageId && !relocate) {
        await bot.editMessageText(chatId, state.messageId, text, keyboard);
      } else {
        const previous = state.messageId;
        const sent = await bot.sendMessage(chatId, text, keyboard);
        state.messageId = sent?.message_id ?? 0;
        if (previous && relocate) void bot.deleteMessage(chatId, previous);
      }
    } catch (error) {
      if (isNotModified(error)) return;
      if (isUnreachable(error)) {
        log.debug('[panel] چت در دسترس نیست:', errText(error));
        return;
      }
      // A stale message id (deleted by the user, older than 48h) is the common
      // case here, and it is always fixable by opening a fresh panel.
      log.debug('[panel] ویرایش پنل ناموفق بود؛ کارت تازه فرستاده می‌شود:', errText(error));
      state.messageId = 0;
      try {
        const sent = await bot.sendMessage(chatId, text, keyboard);
        state.messageId = sent?.message_id ?? 0;
      } catch (retryError) {
        log.warn('[panel] ارسال پنل ناموفق بود:', errText(retryError));
      }
    } finally {
      // A notice is a toast, not a state: it must not survive the next tap.
      state.notice = null;
    }
  };

  const notify = (state, icon, text) => {
    state.notice = { icon, text };
  };

  // -------------------------------------------------------------------- actions

  const titleFor = (chatKey) => entryOf(chatKey)?.title || chatKey;

  const toggleBucket = (bucketScreen, chatKey) => {
    const on = bucketScreen === SCREEN.AUTO ? store.isAuto(chatKey) : store.isMirror(chatKey);
    const entry = entryOf(chatKey);
    const title = entry?.title || chatKey;
    const username = entry?.username || '';
    if (bucketScreen === SCREEN.AUTO) store.setAuto(chatKey, title, !on, username);
    else store.setMirror(chatKey, title, !on, username);
    return !on;
  };

  /** Adds a chat to a bucket from a typed target. */
  const addTarget = async (state, kind, raw) => {
    const bucket = kind === 'auto' ? 'autoSave' : 'mirror';
    const found = await resolveTargetChat(client, raw, { store, bucket });
    if (found.failure) {
      notify(state, ICON.no, 'این یوزرنیم یا شناسه را نشناختم.');
      return;
    }
    const already = kind === 'auto' ? store.isAuto(found.chatKey) : store.isMirror(found.chatKey);
    if (already) {
      notify(state, ICON.info, `«${found.title}» از قبل در لیست بود.`);
    } else {
      if (kind === 'auto') store.setAuto(found.chatKey, found.title, true, found.username);
      else store.setMirror(found.chatKey, found.title, true, found.username);
      notify(state, ICON.ok, `«${found.title}» اضافه شد.`);
    }
    state.screen = kind === 'auto' ? SCREEN.AUTO : SCREEN.MIRROR;
    state.page = 0;
  };

  /**
   * Adds — or rewrites — the first comment of a channel from typed input.
   *
   * The parser is the same pure function `.comment` uses, so `@channel` on the
   * first line with the body under it behaves identically in both places.
   */
  const addComment = async (state, raw) => {
    const { target, text } = parseCommentInput(raw);
    if (!target) {
      notify(state, ICON.no, 'خط اول باید کانال باشد.');
      state.screen = SCREEN.COMMENT;
      return;
    }
    const found = await resolveTargetChat(client, target, { store, bucket: 'firstComment' });
    if (found.failure) {
      notify(state, ICON.no, 'این کانال را نشناختم.');
      state.screen = SCREEN.COMMENT;
      return;
    }
    const existing = store.firstCommentEntry(found.chatKey);
    const body = text || String(existing?.text ?? '');
    if (!body) {
      notify(state, ICON.think, 'متن کامنت را در خط بعدی بنویس.');
      state.screen = SCREEN.COMMENT;
      return;
    }
    store.setFirstComment(found.chatKey, found.title, true, found.username, body);
    notify(state, ICON.ok, `«${found.title}» ${existing ? 'متنش عوض شد' : 'اضافه شد'}.`);
    state.screen = SCREEN.COMMENT;
    state.page = 0;
  };

  /** Queues a post link, exactly like `.save <link>` from the account itself. */
  const saveLink = async (state, raw) => {
    const found = await mediaFromLink(client, raw);
    if (found.failure) {
      notify(state, ICON.no, 'این لینک را نتوانستم باز کنم.');
      return;
    }
    if (found.empty) {
      notify(state, ICON.block, 'در آن پیام رسانه‌ای نبود.');
      return;
    }
    const { media } = found;
    const urgent = media.some(isSelfDestruct);
    const bytes = media.reduce((sum, item) => sum + mediaSize(item), 0);
    let statusMsg = null;
    try {
      statusMsg = await archiver.sendText(cards.queuedCard({
        kind: mediaKind(media[0]) ?? 'رسانه',
        size: humanBytes(bytes),
        pos: queue.positionFor({ priority: urgent }),
        urgent,
      }));
    } catch (error) {
      log.warn('[panel] نوشتن کارت صف ناموفق بود:', errText(error));
    }
    // Failures are reported on the status card by the archiver itself.
    queue.add({ messages: media, statusMsg, explicit: true }, { priority: urgent }).catch(() => {});
    notify(state, ICON.ok, `${media.length} رسانه به صف رفت.`);
    state.screen = SCREEN.QUEUE;
  };

  const bumpConcurrency = (state, direction) => {
    const next = queue.concurrency + (direction === '+' ? 1 : -1);
    const clamped = Math.min(CONCURRENCY_RANGE.max, Math.max(CONCURRENCY_RANGE.min, next));
    if (clamped === queue.concurrency) {
      notify(state, ICON.info, `همزمانی باید بین ${CONCURRENCY_RANGE.min} و ${CONCURRENCY_RANGE.max} باشد.`);
      return;
    }
    queue.setConcurrency(clamped);
    notify(state, ICON.ok, `همزمانی روی ${clamped} تنطیم شد.`);
  };

  const cycleLogLevel = (state) => {
    const levels = LOG_LEVELS;
    const index = levels.indexOf(currentLogLevel());
    const next = levels[(index + 1) % levels.length];
    setLogLevel(next);
    notify(state, ICON.ok, `سطح لاگ: ${next}`);
  };

  const toggleReaction = (state) => {
    if (archiver.doneReaction) {
      archiver.doneReaction = '';
      notify(state, ICON.ok, 'ری‌اکشن خاموش شد.');
    } else {
      archiver.doneReaction = configuredReaction;
      notify(state, ICON.ok, `ری‌اکشن روشن شد: ${configuredReaction}`);
    }
  };

  // -------------------------------------------------------------------- routing

  const route = async (chatId, state, data) => {
    const { screen, action, args, arg } = unpack(data);

    // Any navigation cancels a pending prompt: tapping a button is a clearer
    // statement of intent than a half-finished text answer.
    if (state.awaiting && !(screen === SCREEN.TOOLS && action === ACTION.CANCEL)) state.awaiting = null;

    switch (screen) {
      case SCREEN.NOOP:
        return 'noop';

      case SCREEN.CLOSE:
        await bot.deleteMessage(chatId, state.messageId);
        sessions.set(String(chatId), freshState());
        return 'closed';

      case SCREEN.AUTO:
      case SCREEN.MIRROR: {
        state.screen = screen;
        state.confirm = null;
        state.chatKey = '';
        if (action === ACTION.PAGE) state.page = Number(arg) || 0;
        else if (action === ACTION.PROMPT) {
          state.awaiting = screen === SCREEN.AUTO ? 'auto' : 'mirror';
        } else if (action !== ACTION.REFRESH) state.page = 0;
        break;
      }

      /**
       * The first-comment list. Its `off` is a two-step confirm like every other
       * removal, and its `add` doubles as `edit`: the prompt stores whatever body
       * comes back, replacing the previous one.
       */
      case SCREEN.COMMENT: {
        state.screen = SCREEN.COMMENT;
        state.chatKey = '';
        if (action === ACTION.PAGE) {
          state.page = Number(arg) || 0;
          state.confirm = null;
        } else if (action === ACTION.PROMPT) {
          state.awaiting = 'comment';
          state.confirm = null;
        } else if (action === ACTION.DROP) {
          state.confirm = arg ? { kind: 'comment', key: arg } : null;
        } else if (action === ACTION.CONFIRM) {
          const title = store.firstCommentEntry(arg)?.title || arg;
          store.setFirstComment(arg, title, false);
          state.confirm = null;
          state.page = 0;
          notify(state, ICON.ok, `کامنت اول «${title}» خاموش شد.`);
        } else {
          state.confirm = null;
          if (action !== ACTION.REFRESH) state.page = 0;
        }
        break;
      }

      case SCREEN.CHAT: {
        // args[0] means two different things by design, and mixing them up is the
        // one bug that would send "back" to the wrong list: on a toggle it is the
        // *feature* being flipped, everywhere else it is the list we came from.
        const key = args[1] || '';
        state.screen = SCREEN.CHAT;
        state.chatKey = key;
        if (action === ACTION.TOGGLE) {
          const bucket = BUCKET_SCREEN[args[0]] ? args[0] : SCREEN.AUTO;
          const on = toggleBucket(bucket, key);
          const what = bucket === SCREEN.AUTO ? 'سیو خودکار' : 'آینه';
          notify(state, on ? ICON.ok : ICON.info, `${what} برای «${titleFor(key)}» ${on ? 'روشن' : 'خاموش'} شد.`);
          state.confirm = null;
          break;
        }
        state.from = BUCKET_SCREEN[args[0]] ? args[0] : SCREEN.AUTO;
        if (action === ACTION.DROP) {
          state.confirm = { kind: 'drop' };
        } else if (action === ACTION.CONFIRM) {
          const title = titleFor(key);
          store.setAuto(key, title, false);
          store.setMirror(key, title, false);
          store.setFirstComment(key, title, false);
          state.confirm = null;
          state.chatKey = '';
          state.screen = state.from;
          state.page = 0;
          notify(state, ICON.ok, `«${title}» از لیست‌ها حذف شد.`);
        } else {
          state.confirm = null;
        }
        break;
      }

      case SCREEN.QUEUE: {
        state.screen = SCREEN.QUEUE;
        if (action === ACTION.DROP) state.confirm = { kind: 'clear' };
        else if (action === ACTION.CONFIRM) {
          const dropped = queue.clear('پاک‌سازی از پنل');
          state.confirm = null;
          notify(state, dropped ? ICON.broom : ICON.info, dropped ? `${dropped} کار از صف حذف شد.` : 'صف خالی بود.');
        } else state.confirm = null;
        break;
      }

      case SCREEN.SETTINGS: {
        state.screen = SCREEN.SETTINGS;
        if (action === ACTION.BUMP) bumpConcurrency(state, arg);
        else if (action === ACTION.TOGGLE) toggleReaction(state);
        else if (action === ACTION.SET) cycleLogLevel(state);
        break;
      }

      case SCREEN.TOOLS: {
        state.screen = SCREEN.TOOLS;
        if (action === ACTION.PROMPT) state.awaiting = PROMPTS[arg] ?? null;
        else if (action === ACTION.CANCEL) state.awaiting = null;
        break;
      }

      case SCREEN.STATS:
      case SCREEN.HELP: {
        state.screen = screen;
        state.confirm = null;
        break;
      }

      default: {
        state.screen = SCREEN.HOME;
        state.confirm = null;
        state.chatKey = '';
        state.page = 0;
      }
    }
    return 'render';
  };

  // -------------------------------------------------------------------- updates

  const onCallback = async (query) => {
    if (!isOwner(query.from)) {
      await bot.answerCallback(query.id, { text: 'این پنل خصوصی است.', alert: true });
      return;
    }
    const chatId = query.message?.chat?.id;
    if (!chatId) return;
    const state = stateOf(chatId);
    // Adopt whatever message the tap came from: the panel may have been reopened.
    if (query.message?.message_id) state.messageId = query.message.message_id;

    let outcome = 'render';
    try {
      outcome = await route(chatId, state, query.data);
    } catch (error) {
      log.error('[panel] اجرای دکمه ناموفق بود:', errText(error));
      notify(state, ICON.no, 'انجام نشد؛ لاگ را ببین.');
    }
    await bot.answerCallback(query.id);
    if (outcome === 'render') await present(chatId, state);
  };

  const onMessage = async (message) => {
    const chatId = message.chat?.id;
    if (!chatId) return;
    if (!isOwner(message.from)) {
      await bot.sendMessage(chatId, `${ICON.shield} این پنل خصوصی است.`).catch(() => {});
      return;
    }

    const state = stateOf(chatId);
    const text = String(message.text ?? '').trim();
    const command = /^\/([a-z_]+)/i.exec(text)?.[1]?.toLowerCase();

    if (command) {
      state.awaiting = null;
      state.confirm = null;
      if (command === 'help') state.screen = SCREEN.HELP;
      else if (command === 'queue') state.screen = SCREEN.QUEUE;
      else if (command === 'status') state.screen = SCREEN.STATS;
      else if (command === 'id') {
        notify(state, ICON.id, `شناسه تو: ${message.from?.id ?? '؟'}`);
        state.screen = SCREEN.HOME;
      } else state.screen = SCREEN.HOME;
      await present(chatId, state, { relocate: true });
      return;
    }

    if (!state.awaiting) {
      notify(state, ICON.idea, 'برای کار با پنل از دکمه‌ها استفاده کن.');
      await present(chatId, state, { relocate: true });
      return;
    }

    const pending = state.awaiting;
    state.awaiting = null;
    try {
      if (pending === 'save') await saveLink(state, text);
      else if (pending === 'comment') await addComment(state, text);
      else await addTarget(state, pending, text);
    } catch (error) {
      log.error('[panel] پردازش ورودی ناموفق بود:', errText(error));
      notify(state, ICON.no, 'انجام نشد؛ لاگ را ببین.');
    }
    await present(chatId, state, { relocate: true });
  };

  const onUpdate = async (update) => {
    if (update.callback_query) return onCallback(update.callback_query);
    if (update.message) return onMessage(update.message);
    return undefined;
  };

  try {
    await bot.start(onUpdate);
  } catch (error) {
    log.error('[panel] راه‌اندازی ربات پنل ناموفق بود:', errText(error));
    await bot.stop().catch(() => {});
    return null;
  }

  void bot.setCommands(COMMANDS);
  log.ok(`[panel] پنل شیشه‌ای آماده است: @${bot.username || '?'} \u2022 مالک ${owner || 'همه'}`);

  return {
    bot,
    owner,
    get username() {
      return bot.username;
    },
    get ready() {
      return bot.ready;
    },
    stop: () => bot.stop(),
  };
}
