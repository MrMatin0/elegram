const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const level = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const colorize = Boolean(process.stdout?.isTTY) && !process.env.NO_COLOR;

const paint = (code, value) => (colorize ? `\x1b[${code}m${value}\x1b[0m` : String(value));
const stamp = () => new Date().toISOString().slice(11, 19);

const emit = (stream, code, glyph, args) => {
  stream(paint('90', `[${stamp()}]`), paint(code, glyph), ...args);
};

export const log = {
  debug: (...args) => level >= LEVELS.debug && emit(console.log, '35', '◦', args),
  info: (...args) => level >= LEVELS.info && emit(console.log, '36', '•', args),
  ok: (...args) => level >= LEVELS.info && emit(console.log, '32', '✔', args),
  warn: (...args) => level >= LEVELS.warn && emit(console.warn, '33', '⚠', args),
  error: (...args) => level >= LEVELS.error && emit(console.error, '31', '✖', args),
};

/** Normalizes gramjs/Node errors into a short human readable string. */
export const errText = (error) =>
  error?.errorMessage || error?.message || (error == null ? 'خطای ناشناخته' : String(error));
