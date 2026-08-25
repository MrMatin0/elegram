const ts = () => new Date().toLocaleTimeString('en-GB');
const paint = (code, msg) => `\x1b[${code}m${msg}\x1b[0m`;

export const log = {
  info: (...args) => console.log(paint('90', `[${ts()}]`), paint('36', '•'), ...args),
  ok: (...args) => console.log(paint('90', `[${ts()}]`), paint('32', '✔'), ...args),
  warn: (...args) => console.log(paint('90', `[${ts()}]`), paint('33', '⚠'), ...args),
  error: (...args) => console.log(paint('90', `[${ts()}]`), paint('31', '✖'), ...args),
};
