import { config } from '../config.js';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function humanBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), UNITS.length - 1);
  const scaled = value / 1024 ** index;
  return `${scaled.toFixed(index === 0 ? 0 : 1)} ${UNITS[index]}`;
}

export function humanDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const bits = [];
  if (days) bits.push(`${days} روز`);
  if (hours) bits.push(`${hours} ساعت`);
  if (minutes) bits.push(`${minutes} دقیقه`);
  if (!bits.length) bits.push(`${seconds} ثانیه`);
  return bits.join(' و ');
}

export function progressBar(pct, width = 14) {
  const value = Number(pct);
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const filled = Math.round((clamped / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

export function faDate(date = new Date(), timeZone = config.timezone) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return '';
  const options = { dateStyle: 'medium', timeStyle: 'short' };
  try {
    return value.toLocaleString('fa-IR', { ...options, timeZone });
  } catch {
    return value.toLocaleString('fa-IR', options);
  }
}

export function esc(text = '') {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Truncates raw text before it is HTML escaped, so entities never get cut in half. */
export function truncate(text, max) {
  const value = String(text ?? '');
  if (max <= 0) return '';
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Joins lines while staying under a hard limit, dropping whole lines instead of
 * slicing the result — a blind slice can cut an HTML tag and break parseMode.
 */
export function joinWithin(lines, limit, separator = '\n') {
  const kept = [];
  let length = 0;
  for (const line of lines) {
    if (line == null) continue;
    const value = String(line);
    const cost = (kept.length ? separator.length : 0) + value.length;
    if (length + cost > limit) break;
    kept.push(value);
    length += cost;
  }
  return kept.join(separator);
}
