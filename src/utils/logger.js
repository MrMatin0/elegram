/**
 * Leveled console logger.
 *
 * Deliberately dependency-free and side-effect-free at import time: `config.js`
 * is the single owner of dotenv, and this module gets imported from places that
 * must keep working *before* (and without) the environment being loaded. The
 * level is read from `LOG_LEVEL` as a best-effort default and then re-applied
 * from validated config once the process boots.
 */
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export const LOG_LEVELS = Object.freeze(Object.keys(LEVELS));

let threshold = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const colorize = Boolean(process.stdout?.isTTY) && !process.env.NO_COLOR;
const paint = (code, value) => (colorize ? `\x1b[${code}m${value}\x1b[0m` : String(value));
const stamp = () => new Date().toISOString().slice(11, 19);

const emit = (sink, code, glyph, args) => {
  sink(paint('90', `[${stamp()}]`), paint(code, glyph), ...args);
  return true;
};

export function setLogLevel(name) {
  const next = LEVELS[String(name ?? '').toLowerCase()];
  if (next != null) threshold = next;
  return currentLogLevel();
}

export function currentLogLevel() {
  return LOG_LEVELS.find((name) => LEVELS[name] === threshold) ?? 'info';
}

export const log = {
  enabled: (name) => threshold >= (LEVELS[name] ?? LEVELS.info),
  debug: (...args) => threshold >= LEVELS.debug && emit(console.log, '35', '\u25e6', args),
  info: (...args) => threshold >= LEVELS.info && emit(console.log, '36', '\u2022', args),
  ok: (...args) => threshold >= LEVELS.info && emit(console.log, '32', '\u2714', args),
  warn: (...args) => threshold >= LEVELS.warn && emit(console.warn, '33', '\u26a0', args),
  error: (...args) => threshold >= LEVELS.error && emit(console.error, '31', '\u2716', args),
};

/**
 * Normalizes anything throwable into one short line.
 *
 * teleproto's RPC errors put the server string on `.errorMessage` (e.g.
 * `FLOOD_WAIT_42`) and keep `.message` for the human sentence, so we prefer the
 * former: it is the part worth grepping for.
 */
export function errText(error) {
  if (error == null) return 'خطای ناشناخته';
  if (typeof error === 'string') return error.trim() || 'خطای ناشناخته';
  const raw = error.errorMessage || error.message || String(error);
  const flat = String(raw).replace(/\s+/g, ' ').trim();
  return flat || 'خطای ناشناخته';
}
