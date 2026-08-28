/**
 * Glass buttons.
 *
 * Telegram's inline keyboard — the one that lives *under* a message instead of
 * replacing your keyboard — is what everyone means by a "glass button". It is
 * also strictly bot-only: a user account may not attach `replyInlineMarkup` to
 * anything it sends, and the server does not even complain, it just drops the
 * markup. That is why the panel is drawn by the companion bot (`services/bot.js`)
 * while the self account keeps doing the archiving.
 *
 * Everything here is pure data: a keyboard is a plain `{ inline_keyboard }`
 * object, exactly what the Bot API takes, so it is trivially unit-testable and
 * carries no transport of its own.
 */

/** Telegram rejects callback data longer than this, in bytes. */
export const MAX_DATA_BYTES = 64;

const SEP = ':';

/**
 * Screens are single letters on purpose.
 *
 * `callback_data` has 64 bytes for *everything*, and a chat key alone eats 14
 * (`-1001234567890`). Spelling a route out as `mirror:toggle:-100…` leaves no
 * room for a page number and no room to grow.
 */
export const SCREEN = Object.freeze({
  HOME: 'h',
  AUTO: 'a',
  MIRROR: 'm',
  CHAT: 'c',
  QUEUE: 'q',
  STATS: 's',
  SETTINGS: 'g',
  TOOLS: 't',
  HELP: 'i',
  NOOP: 'n',
  CLOSE: 'x',
});

export const ACTION = Object.freeze({
  OPEN: 'o',
  PAGE: 'p',
  TOGGLE: 't',
  DROP: 'd',
  CONFIRM: 'y',
  CANCEL: 'c',
  REFRESH: 'r',
  PROMPT: 'i',
  SET: 's',
  BUMP: 'b',
});

const clean = (value) => String(value ?? '').replaceAll(SEP, '');

/** `pack('c', 't', 'a', '-100…')` -> `c:t:a:-100…` */
export function pack(screen, action = ACTION.OPEN, ...args) {
  const data = [clean(screen), clean(action), ...args.map(clean)].join(SEP);
  // Truncating would silently route a button to the wrong chat, which is worse
  // than a loud failure: better to notice it in development.
  if (Buffer.byteLength(data, 'utf8') > MAX_DATA_BYTES) {
    throw new RangeError(`callback_data بیش از ${MAX_DATA_BYTES} بایت است: ${data}`);
  }
  return data;
}

/** Inverse of `pack`, tolerant of anything a stale keyboard may send back. */
export function unpack(data) {
  const parts = String(data ?? '').split(SEP);
  return {
    screen: parts[0] || SCREEN.HOME,
    action: parts[1] || ACTION.OPEN,
    args: parts.slice(2),
    arg: parts[2] ?? '',
  };
}

// -------------------------------------------------------------------- builders

/** A callback button. `data` is either a packed string or `[screen, action, …]`. */
export const btn = (text, data) => ({
  text,
  callback_data: Array.isArray(data) ? pack(...data) : String(data),
});

/** A URL button — the one glass button that needs no round trip. */
export const urlBtn = (text, url) => ({ text, url });

/** Drops falsy buttons, so a row can be built with inline conditionals. */
export const row = (...buttons) => buttons.filter(Boolean);

/** Wraps a flat list of buttons into rows of `columns`. */
export const grid = (buttons, columns = 2) => {
  const kept = buttons.filter(Boolean);
  const rows = [];
  for (let index = 0; index < kept.length; index += columns) {
    rows.push(kept.slice(index, index + columns));
  }
  return rows;
};

/** Drops empty rows, so a screen can build its keyboard with conditionals. */
export const keyboard = (...rows) => ({
  inline_keyboard: rows.flatMap((item) => {
    if (!item) return [];
    // Accept both a single row and an array of rows (what `grid()` returns).
    const isRow = Array.isArray(item) && item.every((cell) => cell && typeof cell === 'object' && 'text' in cell);
    if (isRow) return item.length ? [item] : [];
    return Array.isArray(item) ? item.filter((line) => Array.isArray(line) && line.length) : [];
  }),
});

// ---------------------------------------------------------------- common pieces

/** State toggle, drawn as a pill so its current value is readable at a glance. */
export const toggleBtn = (label, on, data) =>
  btn(`${on ? '\u{1F7E2}' : '\u26AA\uFE0F'} ${label}`, data);

export const backBtn = (data = [SCREEN.HOME]) => btn('\u2B05\uFE0F بازگشت', data);
export const refreshBtn = (data) => btn('\u{1F504} بروزرسانی', data);
export const closeBtn = () => btn('\u2716\uFE0F بستن', [SCREEN.CLOSE, ACTION.OPEN]);

/**
 * Pager. Both arrows are always present so the keyboard never reflows under the
 * user's thumb; the disabled one is a no-op that answers with a toast.
 */
export const pager = (screen, page, pages) => {
  if (pages <= 1) return [];
  const previous = page > 0
    ? btn('\u2039 قبلی', [screen, ACTION.PAGE, String(page - 1)])
    : btn('\u00B7', [SCREEN.NOOP, ACTION.OPEN]);
  const next = page < pages - 1
    ? btn('بعدی \u203A', [screen, ACTION.PAGE, String(page + 1)])
    : btn('\u00B7', [SCREEN.NOOP, ACTION.OPEN]);
  return [previous, btn(`${page + 1}\u2009/\u2009${pages}`, [SCREEN.NOOP, ACTION.OPEN]), next];
};

/** Destructive actions get a two-step keyboard, never a one-tap surprise. */
export const confirmRow = (label, yes, no) => [
  btn(`\u2705 ${label}`, yes),
  btn('\u2716\uFE0F انصراف', no),
];

/** Splits a list into pages and reports the shape the pager needs. */
export function paginate(items, page = 0, size = 6) {
  const list = Array.isArray(items) ? items : [];
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const start = current * size;
  return { slice: list.slice(start, start + size), page: current, pages, start, total: list.length };
}
