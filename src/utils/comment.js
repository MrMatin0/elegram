/**
 * The first comment: parsing what the user typed, rendering it per post.
 *
 * Pure string work — no client, no store, no clock — exactly like `targets.js`,
 * so the account command and the panel prompt share one parser instead of
 * drifting apart, and both stay testable with no environment present.
 */

/** Telegram refuses a longer message; a body is cut here rather than rejected. */
export const COMMENT_LIMIT = 4096;

/** Placeholders a body may carry. Anything else is left as literal text. */
export const PLACEHOLDERS = Object.freeze(['title', 'link', 'id', 'date', 'text']);

const normalize = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();

/**
 * Splits `<target> <body>` in every shape a human types it:
 *
 *   .comment @channel | اولین کامنت
 *   .comment @channel
 *   اولین کامنت
 *   .comment -1001234567890 اولین کامنت
 *   .comment off @channel
 *
 * A newline is tried first: it is the only separator that survives a body
 * containing a pipe. After that a pipe, and last a plain space — a chat
 * reference never contains one, so everything past it is the body.
 *
 * @returns {{direction: ''|'on'|'off', target: string, text: string}}
 */
export function parseCommentInput(input) {
  const raw = normalize(input);
  if (!raw) return { direction: '', target: '', text: '' };

  let rest = raw;
  let direction = '';
  const head = /^(on|off)(?=\s|$)/i.exec(rest);
  if (head) {
    direction = head[1].toLowerCase();
    rest = rest.slice(head[0].length).trim();
  }

  const newline = rest.indexOf('\n');
  if (newline >= 0) {
    return { direction, target: rest.slice(0, newline).trim(), text: rest.slice(newline + 1).trim() };
  }
  const pipe = rest.indexOf('|');
  if (pipe >= 0) {
    return { direction, target: rest.slice(0, pipe).trim(), text: rest.slice(pipe + 1).trim() };
  }
  const space = /\s/.exec(rest);
  if (!space) return { direction, target: rest, text: '' };
  return { direction, target: rest.slice(0, space.index), text: rest.slice(space.index).trim() };
}

/**
 * Fills the placeholders of a stored body for one concrete post.
 *
 * An unknown placeholder is left untouched on purpose: a body that happens to
 * contain `{something}` is ordinary text, not a broken template.
 */
export function renderComment(template, info = {}) {
  const values = {
    title: String(info.title ?? ''),
    link: String(info.link ?? ''),
    id: info.id == null ? '' : String(info.id),
    date: String(info.date ?? ''),
    text: String(info.text ?? ''),
  };
  const filled = String(template ?? '').replace(/\{(\w+)\}/g, (match, name) => {
    const key = String(name).toLowerCase();
    return Object.hasOwn(values, key) ? values[key] : match;
  });
  const body = filled.trim();
  return body.length > COMMENT_LIMIT ? body.slice(0, COMMENT_LIMIT) : body;
}
