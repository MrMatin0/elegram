export function humanBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), units.length - 1);
  return `${(b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function humanDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const bits = [];
  if (d) bits.push(`${d} روز`);
  if (h) bits.push(`${h} ساعت`);
  if (m) bits.push(`${m} دقیقه`);
  if (!bits.length) bits.push(`${s} ثانیه`);
  return bits.join(' و ');
}

export function progressBar(pct, width = 14) {
  const p = Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function faDate(date = new Date()) {
  return date.toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' });
}

export function esc(text = '') {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
