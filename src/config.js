import 'dotenv/config';
import path from 'node:path';

const problems = [];

const rawValue = (key) => {
  const value = process.env[key];
  return typeof value === 'string' ? value.trim() : '';
};

function text(key, { required = false, fallback = '' } = {}) {
  const value = rawValue(key);
  if (!value) {
    if (required) problems.push(`متغیر محیطی ${key} تنظیم نشده است.`);
    return fallback;
  }
  return value;
}

function integer(key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, required = false } = {}) {
  const value = rawValue(key);
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

export const config = Object.freeze({
  apiId: integer('API_ID', 0, { min: 1, required: true }),
  apiHash: text('API_HASH', { required: true }),
  session: text('SESSION'),
  storagePeer: text('STORAGE_PEER', { fallback: 'me' }),
  port: integer('PORT', 3000, { min: 1, max: 65535 }),
  dataDir: path.resolve(text('DATA_DIR', { fallback: './data' })),
  deviceModel: text('DEVICE_MODEL', { fallback: 'Elegram Desktop' }),
  concurrency: integer('CONCURRENCY', 2, { min: 1, max: 8 }),
  albumWindowMs: integer('ALBUM_WINDOW_MS', 1200, { min: 200, max: 15000 }),
  timezone: text('TIMEZONE', { fallback: 'Asia/Tehran' }),
});

/**
 * Config problems are collected instead of killing the process at import time,
 * so entry points can report every issue at once and exit gracefully.
 */
export function configIssues({ requireSession = false } = {}) {
  const issues = [...problems];
  if (requireSession && !config.session) {
    issues.push('متغیر SESSION خالی است. ابتدا دستور `npm run login` را اجرا کن.');
  }
  return issues;
}
