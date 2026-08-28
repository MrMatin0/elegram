/**
 * The companion bot transport.
 *
 * Why a second identity at all: glass buttons are bot-only. A user account may
 * not attach `replyInlineMarkup` to a message — Telegram does not even return an
 * error, it silently drops the markup — and only a bot receives the
 * `callback_query` a tap produces. So the self account keeps every privilege
 * that matters (reading protected chats, catching TTL media, archiving as you)
 * and the bot is used purely as a rendering surface for the control panel.
 *
 * Deliberately dependency-free: Node 20+ ships `fetch`, and the Bot API is a
 * flat JSON/HTTP interface. Adding a framework here would buy nothing but a
 * supply chain.
 */
import { log, errText } from '../utils/logger.js';

const API_ROOT = 'https://api.telegram.org';
const POLL_TIMEOUT_S = 25;
const CALL_TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

export class BotApiError extends Error {
  constructor(message, { code = 0, retryAfter = 0, method = '' } = {}) {
    super(message);
    this.name = 'BotApiError';
    this.code = Number(code) || 0;
    this.retryAfter = Number(retryAfter) || 0;
    this.method = method;
  }

  /** No amount of retrying fixes a revoked token or a wrong one. */
  get fatal() {
    return this.code === 401 || this.code === 403 || this.code === 404;
  }
}

/** Editing a message to identical text is a 400 — and a complete non-event. */
export const isNotModified = (error) => /not modified/i.test(String(error?.message ?? ''));

/** The user blocked the bot, or never started it. Nothing to shout about. */
export const isUnreachable = (error) =>
  /bot was blocked|user is deactivated|chat not found/i.test(String(error?.message ?? ''));

export class BotApi {
  constructor(token, { pollTimeout = POLL_TIMEOUT_S, allowedUpdates = ['message', 'callback_query'] } = {}) {
    this.token = String(token ?? '').trim();
    this.pollTimeout = Math.max(0, Number(pollTimeout) || 0);
    this.allowedUpdates = allowedUpdates;
    this.me = null;
    this.offset = 0;
    this._stopped = true;
    this._loop = null;
    this._inflight = new Set();
  }

  get ready() {
    return Boolean(this.me) && !this._stopped;
  }

  get username() {
    return this.me?.username ?? '';
  }

  // ------------------------------------------------------------------ transport

  /**
   * One Bot API call.
   *
   * `429` is honoured to the second (Telegram tells us exactly how long to wait);
   * a transport hiccup gets a short exponential retry; anything the API calls an
   * error is raised as a `BotApiError` so callers can branch on `code`.
   */
  async call(method, payload = {}, { timeoutMs = CALL_TIMEOUT_MS, retries = 2 } = {}) {
    if (!this.token) throw new BotApiError('BOT_TOKEN تنظیم نشده است.', { method });

    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      this._inflight.add(controller);
      try {
        const response = await fetch(`${API_ROOT}/bot${this.token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        if (body?.ok) return body.result;

        const retryAfter = Number(body?.parameters?.retry_after) || 0;
        const error = new BotApiError(body?.description || `HTTP ${response.status}`, {
          code: body?.error_code ?? response.status,
          retryAfter,
          method,
        });
        if (retryAfter && attempt < retries && !this._stopped) {
          log.debug(`[bot] ${method} محدود شد؛ ${retryAfter} ثانیه صبر…`);
          await sleep(retryAfter * 1000);
          continue;
        }
        throw error;
      } catch (error) {
        if (error instanceof BotApiError) throw error;
        if (this._stopped) throw new BotApiError('سرویس متوقف شد.', { method });
        if (attempt >= retries) throw new BotApiError(errText(error) || 'خطای شبکه', { method });
        await sleep(400 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
        this._inflight.delete(controller);
      }
    }
  }

  getMe() {
    return this.call('getMe');
  }

  setCommands(commands) {
    return this.call('setMyCommands', { commands }).catch((error) => {
      log.debug('[bot] ثبت فهرست دستورها ناموفق بود:', errText(error));
      return null;
    });
  }

  sendMessage(chatId, text, keyboard = null) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  editMessageText(chatId, messageId, text, keyboard = null) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  /**
   * Every callback query must be answered, even with nothing to say: an
   * unanswered tap leaves a spinner on the button for a full 15 seconds.
   */
  answerCallback(id, { text = '', alert = false } = {}) {
    return this.call('answerCallbackQuery', {
      callback_query_id: id,
      ...(text ? { text, show_alert: Boolean(alert) } : {}),
    }).catch((error) => {
      log.debug('[bot] پاسخ به کلیک ناموفق بود:', errText(error));
      return null;
    });
  }

  deleteMessage(chatId, messageId) {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => null);
  }

  // ------------------------------------------------------------------- updating

  /**
   * Starts long polling. Resolves once `getMe` succeeded, so a bad token fails
   * loudly at boot instead of silently never drawing a panel.
   */
  async start(onUpdate) {
    if (!this.token) throw new BotApiError('BOT_TOKEN تنظیم نشده است.');
    this._stopped = false;
    this.me = await this.getMe();
    // A backlog of taps from while we were down would replay stale routes against
    // fresh state. `offset: -1` acknowledges everything without processing it.
    try {
      const last = await this.call('getUpdates', { offset: -1, timeout: 0 }, { retries: 0 });
      if (Array.isArray(last) && last.length) this.offset = last[last.length - 1].update_id + 1;
    } catch (error) {
      log.debug('[bot] پاک‌سازی صف آپدیت‌ها ناموفق بود:', errText(error));
    }
    this._loop = this._poll(onUpdate);
    return this.me;
  }

  async _poll(onUpdate) {
    let failures = 0;
    while (!this._stopped) {
      try {
        const updates = await this.call(
          'getUpdates',
          { offset: this.offset, timeout: this.pollTimeout, allowed_updates: this.allowedUpdates },
          { timeoutMs: (this.pollTimeout + 15) * 1000, retries: 0 },
        );
        failures = 0;
        for (const update of updates ?? []) {
          this.offset = update.update_id + 1;
          if (this._stopped) break;
          // One bad update must never kill the loop: the panel would go dark
          // while the archiver kept running, which is the worst of both worlds.
          try {
            await onUpdate(update);
          } catch (error) {
            log.error('[bot] پردازش آپدیت ناموفق بود:', errText(error));
          }
        }
      } catch (error) {
        if (this._stopped) break;
        if (error instanceof BotApiError && error.fatal) {
          log.error('[bot] توکن ربات پذیرفته نشد؛ پنل غیرفعال شد:', errText(error));
          this._stopped = true;
          break;
        }
        if (error instanceof BotApiError && error.code === 409) {
          // Another process (or a webhook) owns this token. Backing off forever
          // would be politer than fighting it, but a restart loop is worse.
          log.warn('[bot] یک نمونه دیگر با همین توکن در حال اجراست (409).');
        }
        failures += 1;
        const wait = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 6));
        log.debug(`[bot] دریافت آپدیت ناموفق بود؛ ${Math.round(wait / 1000)} ثانیه صبر:`, errText(error));
        await sleep(wait);
      }
    }
  }

  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    for (const controller of this._inflight) controller.abort();
    this._inflight.clear();
    await Promise.resolve(this._loop).catch(() => {});
    this._loop = null;
  }
}
