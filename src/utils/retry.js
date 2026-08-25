import { log, errText } from './logger.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Extracts the wait window (seconds) from a Telegram FLOOD_WAIT error. */
export function floodWaitSeconds(error) {
  if (!error) return null;
  const message = error.errorMessage || error.message || '';
  if (!/FLOOD/i.test(message)) return null;
  const match = /FLOOD(?:_PREMIUM)?_WAIT_(\d+)/i.exec(message);
  if (match) return Number(match[1]);
  return Number.isFinite(error.seconds) ? Number(error.seconds) : null;
}

const isTransient = (error) =>
  /TIMEOUT|Not connected|Connection closed|socket|ECONN|EPIPE|disconnect/i.test(errText(error));

/**
 * Runs a Telegram call, backing off on FLOOD_WAIT and transient network errors.
 * Long flood windows are re-thrown instead of blocking the queue for minutes.
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
      if (attempt < retries && isTransient(error)) {
        const backoff = 1000 * 2 ** attempt;
        log.warn(`[${label}] خطای موقت: ${errText(error)} — تلاش مجدد در ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      throw error;
    }
  }
}
