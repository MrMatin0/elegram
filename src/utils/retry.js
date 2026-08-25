import { log, errText } from './logger.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

/**
 * teleproto throws a typed `FloodWaitError`/`SlowModeWaitError` carrying a
 * numeric `.seconds`. We duck-type instead of importing `teleproto/errors` so
 * this module stays testable without the dependency installed — and so an
 * error class added in a future teleproto release still gets handled.
 */
export function floodWaitSeconds(error) {
  if (!error || typeof error !== 'object') return null;
  const label = `${error.constructor?.name ?? ''} ${errText(error)}`;
  if (!/FLOOD|SLOWMODE_WAIT|SlowModeWait/i.test(label)) return null;
  const direct = Number(error.seconds);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const parsed = /_WAIT_(\d+)/i.exec(label);
  return parsed ? Number(parsed[1]) : null;
}

/** Editing a message to the text it already has is a 400, not a failure. */
export function isNotModified(error) {
  return /MESSAGE_NOT_MODIFIED|MessageNotModified/i.test(`${error?.constructor?.name ?? ''} ${errText(error)}`);
}

/** Socket-level hiccups: worth another attempt, unlike a malformed request. */
export function isTransient(error) {
  return /TIMEOUT|Timed?Out|Not connected|Connection closed|socket|ECONN|EPIPE|ETIMEDOUT|EAI_AGAIN|disconnect|ServerError|500|503/i
    .test(`${error?.constructor?.name ?? ''} ${errText(error)}`);
}

/** A wrong request never becomes right by being sent again. */
export function isPermanent(error) {
  return /BadRequestError|ForbiddenError|NotFoundError/i.test(error?.constructor?.name ?? '');
}

/**
 * Runs a Telegram call, backing off on FLOOD_WAIT and transient network errors.
 * Long flood windows are re-thrown rather than parking a queue slot for minutes.
 */
export async function withRetry(task, { retries = 2, label = 'telegram', maxWaitSeconds = 120 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      const flood = floodWaitSeconds(error);
      if (flood != null) {
        if (flood > maxWaitSeconds || attempt >= retries) throw error;
        log.warn(`[${label}] FLOOD_WAIT ${flood}s — صبر و تلاش مجدد…`);
        await sleep((flood + 1) * 1000);
        continue;
      }
      if (attempt < retries && !isPermanent(error) && isTransient(error)) {
        const backoff = 1000 * 2 ** attempt;
        log.warn(`[${label}] خطای موقت: ${errText(error)} — تلاش مجدد در ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      throw error;
    }
  }
}
