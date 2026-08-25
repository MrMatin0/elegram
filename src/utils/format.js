/**
 * Pure formatting helpers. No imports on purpose: this module is covered by the
 * unit tests, which must run without a configured environment.
 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

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
  const bits = [];
  if (days) bits.push(`${days} روز`);
  if (hours) bits.push(`${hours} ساعت`);
  if (minutes) bits.push(`${minutes} دقیقه`);
  if (!bits.length) bits.push(`${total % 60} ثانیه`);
  return bits.join(' و ');
}

/** Clamps any input to an integer percentage. */
export function percent(received, total) {
  const done = Number(received);
  const size = Number(total);
  if (!Number.isFinite(done) || !Number.isFinite(size) || size <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((done / size) * 100)));
}

export function progressBar(pct, width = 14) {
  const value = Number(pct);
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const filled = Math.round((clamped / 100) * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(Math.max(0, width - filled));
}

export function faDate(date = new Date(), timeZone) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return '';
  const options = { dateStyle: 'medium', timeStyle: 'short' };
  try {
    return value.toLocaleString('fa-IR', timeZone ? { ...options, timeZone } : options);
  } catch {
    // An invalid IANA zone must not cost us the whole caption.
    return value.toLocaleString('fa-IR', options);
  }
}

/** Escapes the three characters Telegram's HTML parse mode cares about. */
export function esc(text = '') {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Truncate *before* escaping, otherwise a cut can slice an entity in half. */
export function truncate(text, max) {
  const value = String(text ?? '');
  const limit = Number(max);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}\u2026`;
}

/**
 * Joins lines while staying under a hard limit, dropping whole lines instead of
 * slicing the result — a blind slice can cut an HTML tag and break parseMode.
 */
export function joinWithin(lines, limit, separator = '\n') {
  const max = Number(limit);
  if (!Number.isFinite(max) || max <= 0) return '';
  const kept = [];
  let length = 0;
  for (const line of lines) {
    if (line == null) continue;
    const value = String(line);
    const cost = (kept.length ? separator.length : 0) + value.length;
    if (length + cost > max) break;
    kept.push(value);
    length += cost;
  }
  return kept.join(separator);
}
