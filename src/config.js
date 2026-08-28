import 'dotenv/config';
import path from 'node:path';
import { LOG_LEVELS } from './utils/logger.js';

/**
 * Problems are collected instead of thrown at import time, so an entry point
 * can report *every* misconfiguration at once and exit cleanly instead of
 * dying on the first bad variable.
 */
const problems = [];

const raw = (key) => {
  const value = process.env[key];
  return typeof value === 'string' ? value.trim() : '';
};

/** True when the variable exists at all, however empty its value is. */
const isSet = (key) => typeof process.env[key] === 'string';

function text(key, { required = false, fallback = '' } = {}) {
  const value = raw(key);
  if (!value) {
    if (required) problems.push(`متغیر محیطی ${key} تنظیم نشده است.`);
    return fallback;
  }
  return value;
}

function integer(key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, required = false } = {}) {
  const value = raw(key);
  if (!value) {
    if (required) problems.push(`متغیر محیطی ${key} تنظیم نشده است.`);
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    problems.push(`متغیر محیطی ${key} باید عددی صحیح بین ${min} و ${max} باشد (مقدار فعلی: ${value}).`);
    return fallback;
  }
  return parsed;
}

function choice(key, fallback, allowed) {
  const value = raw(key).toLowerCase();
  if (!value) return fallback;
  if (!allowed.includes(value)) {
    problems.push(`متغیر محیطی ${key} باید یکی از این مقادیر باشد: ${allowed.join('، ')} (مقدار فعلی: ${value}).`);
    return fallback;
  }
  return value;
}

function boolean(key, fallback) {
  const value = raw(key).toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  problems.push(`متغیر محیطی ${key} باید true یا false باشد (مقدار فعلی: ${value}).`);
  return fallback;
}

/**
 * An opt-out string: setting the variable to nothing (or to whitespace) is a
 * deliberate "turn this off", while leaving it unset keeps the default.
 *
 * The previous form read `process.env` twice to tell those two cases apart,
 * which also meant a whitespace-only value silently fell back to the default.
 */
function optOut(key, fallback) {
  return isSet(key) ? raw(key) : fallback;
}

/** A bad IANA zone used to silently degrade every date in every caption. */
function timezone(key, fallback) {
  const value = text(key, { fallback });
  try {
    new Intl.DateTimeFormat('fa-IR', { timeZone: value });
    return value;
  } catch {
    problems.push(`متغیر محیطی ${key} یک منطقه زمانی معتبر نیست (مقدار فعلی: ${value}). از ${fallback} استفاده می‌شود.`);
    return fallback;
  }
}

/**
 * A bot token, shaped `<botId>:<secret>`.
 *
 * Validated here rather than at first use: a typo in the token means the panel
 * silently never appears, and "silently" is the part worth fixing.
 */
function botToken(key) {
  const value = raw(key);
  if (!value) return '';
  if (!/^\d{6,}:[\w-]{20,}$/.test(value)) {
    problems.push(`متغیر محیطی ${key} شکل معتبر توکن ربات را ندارد (باید مثل 123456:ABC-DEF… باشد).`);
    return '';
  }
  return value;
}

/** A numeric Telegram user id. Anything else is a typo worth naming. */
function userId(key) {
  const value = raw(key);
  if (!value) return '';
  if (!/^\d{5,20}$/.test(value)) {
    problems.push(`متغیر محیطی ${key} باید شناسه عددی تلگرام باشد (مقدار فعلی: ${value}).`);
    return '';
  }
  return value;
}

const dataDir = path.resolve(text('DATA_DIR', { fallback: './data' }));

export const config = Object.freeze({
  apiId: integer('API_ID', 0, { min: 1, required: true }),
  apiHash: text('API_HASH', { required: true }),
  session: text('SESSION'),

  storagePeer: text('STORAGE_PEER', { fallback: 'me' }),
  dataDir,
  tmpDir: path.join(dataDir, 'tmp'),

  // Glass buttons are bot-only, so the control panel needs its own identity.
  // Without a token everything else still works; there is just no panel.
  botToken: botToken('BOT_TOKEN'),
  // Defaults to the logged-in account: the panel is yours and nobody else's.
  panelOwner: userId('PANEL_OWNER'),

  port: integer('PORT', 3000, { min: 1, max: 65535 }),
  deviceModel: text('DEVICE_MODEL', { fallback: 'Elegram Desktop' }),
  systemVersion: text('SYSTEM_VERSION', { fallback: `${process.platform} ${process.arch}` }),

  concurrency: integer('CONCURRENCY', 2, { min: 1, max: 8 }),
  albumWindowMs: integer('ALBUM_WINDOW_MS', 1200, { min: 200, max: 15000 }),
  uploadWorkers: integer('UPLOAD_WORKERS', 4, { min: 1, max: 16 }),
  maxConcurrentDownloads: integer('MAX_CONCURRENT_DOWNLOADS', 4, { min: 1, max: 16 }),
  // teleproto sleeps through any FLOOD_WAIT shorter than this by itself; longer
  // ones still throw and are handled by our own retry/backoff.
  floodSleepThreshold: integer('FLOOD_SLEEP_THRESHOLD', 60, { min: 0, max: 600 }),

  // How long to wait after a post before commenting. 0 is "the moment it lands",
  // which is the whole point; a few seconds is for channels where looking human
  // matters more than being first.
  firstCommentDelayMs: integer('FIRST_COMMENT_DELAY_MS', 0, { min: 0, max: 600000 }),
  // Telegram copies the post into the linked group *after* publishing it, so the
  // first lookup can legitimately find nothing. This is how many times we ask.
  firstCommentAttempts: integer('FIRST_COMMENT_ATTEMPTS', 5, { min: 1, max: 20 }),
  // You may read a linked discussion group without joining it, but not write in
  // it. Without this, commenting on a channel you only follow always fails.
  firstCommentJoin: boolean('FIRST_COMMENT_JOIN', true),

  timezone: timezone('TIMEZONE', 'Asia/Tehran'),
  logLevel: choice('LOG_LEVEL', 'info', LOG_LEVELS),
  // An empty DONE_REACTION disables the cosmetic "done" reaction entirely.
  doneReaction: optOut('DONE_REACTION', '\u{1F44D}'),
  catchUp: boolean('CATCH_UP', true),
});

export function configIssues({ requireSession = false } = {}) {
  const issues = [...problems];
  if (requireSession && !config.session) {
    issues.push('متغیر SESSION خالی است. ابتدا دستور `npm run login` را اجرا کن.');
  }
  return issues;
}

/** Safe to log: never exposes API_HASH, SESSION or BOT_TOKEN. */
export function configSummary() {
  return {
    apiId: config.apiId,
    storagePeer: config.storagePeer,
    dataDir: config.dataDir,
    port: config.port,
    concurrency: config.concurrency,
    uploadWorkers: config.uploadWorkers,
    timezone: config.timezone,
    logLevel: config.logLevel,
    hasSession: Boolean(config.session),
    hasBotToken: Boolean(config.botToken),
    panelOwner: config.panelOwner || 'self',
    firstCommentDelayMs: config.firstCommentDelayMs,
    firstCommentJoin: config.firstCommentJoin,
  };
}
