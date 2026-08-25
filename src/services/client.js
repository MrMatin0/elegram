import { TelegramClient, Logger, errors } from 'teleproto';
// teleproto publishes an "exports" map, so subpaths are the *documented* ones:
// `teleproto/sessions`, `teleproto/events`, `teleproto/errors`. Appending
// `/index.js` is not in the map and Node rejects it outright with
// ERR_PACKAGE_PATH_NOT_EXPORTED — which is exactly why v1 never booted.
import { StringSession } from 'teleproto/sessions';
import { log, errText, currentLogLevel } from '../utils/logger.js';

const AUTH_FAILURES = new Set([
  'AuthKeyUnregisteredError',
  'AuthKeyDuplicatedError',
  'AuthKeyInvalidError',
  'SessionRevokedError',
  'SessionExpiredError',
  'UserDeactivatedError',
  'UserDeactivatedBanError',
]);

/** Maps our log level onto teleproto's, so one env var controls both. */
function teleprotoLevel(level) {
  return level === 'silent' ? 'none' : level;
}

/** Routes teleproto's internal logging through our own formatter. */
function buildBaseLogger() {
  try {
    if (typeof Logger !== 'function') return undefined;
    const logger = new Logger(teleprotoLevel(currentLogLevel()));
    logger.handler = ({ level, message, error }) => {
      const line = `[tg] ${message ?? errText(error)}`;
      if (level === 'error') log.error(line);
      else if (level === 'warn') log.warn(line);
      else if (level === 'info') log.info(line);
      else log.debug(line);
    };
    return logger;
  } catch (error) {
    log.debug('[client] baseLogger در دسترس نیست:', errText(error));
    return undefined;
  }
}

export function createClient(config, { appVersion = '2.0.0' } = {}) {
  return new TelegramClient(new StringSession(config.session), config.apiId, config.apiHash, {
    deviceModel: config.deviceModel,
    systemVersion: config.systemVersion,
    appVersion,
    connectionRetries: 10,
    retryDelay: 2000,
    autoReconnect: true,
    requestRetries: 3,
    // Short flood waits are slept through by the client itself; longer ones
    // still throw and hit our own backoff in utils/retry.js.
    floodSleepThreshold: config.floodSleepThreshold,
    maxConcurrentDownloads: config.maxConcurrentDownloads,
    baseLogger: buildBaseLogger(),
  });
}

/** True when the saved session is dead and no amount of retrying will help. */
export function isAuthFailure(error) {
  if (!error) return false;
  const Unauthorized = errors?.UnauthorizedError;
  if (typeof Unauthorized === 'function' && error instanceof Unauthorized) return true;
  if (AUTH_FAILURES.has(error.constructor?.name)) return true;
  return /AUTH_KEY_|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/i.test(errText(error));
}

export class SessionError extends Error {}

/**
 * Connects, verifies authorization, and optionally replays missed updates.
 * Every failure mode gets a message a non-developer can act on.
 */
export async function connect(client, { catchUp = true } = {}) {
  try {
    await client.connect();
  } catch (error) {
    if (isAuthFailure(error)) {
      throw new SessionError(`SESSION رد شد (${errText(error)}). دوباره \`npm run login\` را اجرا کن.`);
    }
    throw error;
  }

  let authorized = false;
  try {
    authorized = await client.isUserAuthorized();
  } catch (error) {
    if (isAuthFailure(error)) {
      throw new SessionError(`SESSION باطل شده است (${errText(error)}). دوباره \`npm run login\` را اجرا کن.`);
    }
    throw error;
  }
  if (!authorized) {
    throw new SessionError('SESSION نامعتبر یا منقضی است. دوباره `npm run login` را اجرا کن.');
  }

  const me = await client.getMe();

  if (catchUp) {
    // StringSession keeps no update cursor on disk, so this is a best-effort
    // replay of whatever Telegram still has buffered for us.
    try {
      await client.catchUp();
    } catch (error) {
      log.warn('[client] بازیابی به‌روزرسانی‌های ازدست‌رفته ناموفق بود:', errText(error));
    }
  }

  return me;
}
