/**
 * The Elegram design system.
 *
 * Every surface this project renders — the cards the self-bot writes into the
 * archive and the glass panel the companion bot draws — is built from the
 * primitives in this file. One place decides what a rule looks like, how a
 * key/value row reads, which icon means "on", and how wide a gauge is.
 *
 * Escaping discipline (the most common way to break parseMode):
 *   • Anything named `*Raw`, plus `hint()` and `header()`, takes **HTML** and is
 *     passed through untouched — the caller owns the escaping.
 *   • Everything else takes **plain text** and escapes it here, exactly once.
 *   • `quote()` truncates first and escapes second: a blind cut through an
 *     already-escaped entity (`&amp;`) produces invalid HTML.
 *
 * Only tags that MTProto *and* the Bot API both parse are used: b, i, u, s,
 * code, pre, a. No blockquote, no spoiler — an unsupported tag is not a
 * cosmetic problem, it is a rejected message.
 */
import { esc, truncate } from '../utils/format.js';

// ------------------------------------------------------------------- furniture

/** Hard rule. Frames a card and separates its major regions. */
export const RULE = '\u2501'.repeat(18);
/** Soft rule. Separates sections *inside* one card. */
export const SOFT = '\u2508'.repeat(18);
/** Whisper rule, for a footnote that should not look like a section. */
export const FAINT = '\u00B7 '.repeat(9).trim();

export const BRAND = '\u26A1\uFE0F <b>Elegram</b>';
export const DOT = '\u2022';
export const MID = '\u00B7';
export const BULLET = '\u25AB\uFE0F';
export const MARK = '\u25AA\uFE0F';

/** Named glyphs. Never inline an emoji anywhere else — add it here. */
export const ICON = Object.freeze({
  brand: '\u26A1\uFE0F',
  panel: '\u{1F39B}\uFE0F',
  system: '\u{1F5A5}\uFE0F',
  archive: '\u{1F5C4}\uFE0F',
  box: '\u{1F4E6}',
  queue: '\u{1F4E5}',
  auto: '\u{1F501}',
  mirror: '\u{1FA9E}',
  comment: '\u{1F5E8}\uFE0F',
  stats: '\u{1F4C8}',
  settings: '\u2699\uFE0F',
  tools: '\u{1F9F0}',
  help: '\u{1F4D6}',
  chat: '\u{1F4AC}',
  user: '\u{1F464}',
  clock: '\u{1F553}',
  calendar: '\u{1F5D3}\uFE0F',
  id: '\u{1F194}',
  link: '\u{1F517}',
  file: '\u{1F5C2}\uFE0F',
  album: '\u{1F5C3}\uFE0F',
  disk: '\u{1F4BE}',
  pin: '\u{1F4CD}',
  on: '\u{1F7E2}',
  off: '\u26AA\uFE0F',
  ok: '\u2705',
  no: '\u274C',
  warn: '\u26A0\uFE0F',
  info: '\u2139\uFE0F',
  idea: '\u{1F4A1}',
  ttl: '\u23F3',
  bolt: '\u26A1\uFE0F',
  edit: '\u270F\uFE0F',
  trash: '\u{1F5D1}\uFE0F',
  ghost: '\u{1F47B}',
  bell: '\u{1F514}',
  mute: '\u{1F515}',
  stop: '\u{1F6D1}',
  empty: '\u{1F4ED}',
  search: '\u{1F50E}',
  down: '\u2B07\uFE0F',
  up: '\u2B06\uFE0F',
  shield: '\u{1F6E1}\uFE0F',
  spark: '\u2728',
  broom: '\u{1F9F9}',
  radar: '\u{1F4E1}',
  target: '\u{1F3AF}',
  game: '\u{1F3AE}',
  ping: '\u{1F3D3}',
  time: '\u23F1\uFE0F',
  block: '\u{1F6AB}',
  build: '\u{1F6A7}',
  think: '\u{1F914}',
  hush: '\u{1F92B}',
  fresh: '\u{1F195}',
  old: '\u{1F535}',
  now: '\u{1F7E2}',
  first: '\u{1F4CC}',
  boom: '\u{1F4A5}',
  page: '\u{1F4C4}',
});

// --------------------------------------------------------------- line plumbing

/** Keeps deliberate blank separators, drops only nullish entries. */
export const block = (lines) => lines.filter((line) => line != null).join('\n');

/** Drops anything falsy — for cards whose rows are conditional. */
export const compact = (lines) => lines.filter(Boolean).join('\n');

/**
 * Joins whole sections with a rule between them, skipping empty ones.
 *
 * This is what keeps a card from ever rendering two rules in a row or a
 * dangling separator above nothing — the classic look of a template whose
 * conditional block came out empty.
 */
export const stack = (sections, rule = SOFT) => {
  const kept = sections.filter((part) => part != null && part !== '');
  return kept.reduce((out, part, index) => {
    if (index === 0) return part;
    // A title bar already ends in a hard rule; adding a soft one under it is the
    // double-line look that made the old cards feel like a form, not a card.
    const closed = /(?:\u2501{3,}|\u2508{3,})$/.test(out);
    return closed ? `${out}\n${part}` : `${out}\n${rule}\n${part}`;
  }, '');
};

// ------------------------------------------------------------------ components

/** Card title bar. `name` and `subtitle` are HTML: titles carry brand markup. */
export const header = (icon, name, subtitle = '') =>
  compact([`${icon} ${name}${subtitle ? ` ${MID} <i>${subtitle}</i>` : ''}`, RULE]);

/** Section label inside a card. Plain text. */
export const section = (icon, label) => `${icon} <b>${esc(label)}</b>`;

/**
 * Indented tree of rows: `├` for every row but the last, `└` closes the group.
 * Rows are HTML — they are normally built from `kv()`, which escapes already.
 */
export const tree = (rows) => {
  const kept = rows.filter(Boolean);
  const last = kept.length - 1;
  return kept.map((row, index) => `  ${index === last ? '\u2514' : '\u251C'} ${row}`).join('\n');
};

/** `label · value`, both plain text, value emphasized. */
export const kv = (label, value) => `${esc(label)} ${MID} <b>${esc(value)}</b>`;

/** Same row, but `value` is trusted HTML (a link, a pill, a code chip). */
export const kvRaw = (label, value) => `${esc(label)} ${MID} ${value}`;

/** The exact value, in a copyable chip. */
export const code = (value) => `<code>${esc(value)}</code>`;

/** A footnote. HTML, so it can hold a chip or a link. */
export const hint = (text) => `${ICON.idea} <i>${text}</i>`;

/** State pill: the one place that decides what "on" looks like. */
export const pill = (on, onLabel = 'روشن', offLabel = 'خاموش') =>
  `${on ? ICON.on : ICON.off} <b>${esc(on ? onLabel : offLabel)}</b>`;

/** Escaped anchor. A URL is escaped exactly once, here. */
export const link = (href, label) => `<a href="${esc(href)}">${esc(label)}</a>`;

const clamp = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.round(parsed)));
};

/** Filled/empty gauge — the new look, deliberately not `format.progressBar`. */
export const gauge = (pct, width = 12) => {
  const value = clamp(pct);
  const filled = Math.round((value / 100) * width);
  return '\u25B0'.repeat(filled) + '\u25B1'.repeat(Math.max(0, width - filled));
};

/** Gauge plus its number, monospaced so successive edits do not jitter. */
export const meter = (pct, width = 12) => `<code>${gauge(pct, width)} ${clamp(pct)}%</code>`;

/** A ratio rendered as a gauge — for "how loaded is the queue" rows. */
export const ratio = (done, total, width = 12) => {
  const size = Number(total);
  if (!Number.isFinite(size) || size <= 0) return meter(0, width);
  return meter(((Number(done) || 0) / size) * 100, width);
};

/**
 * Verbatim user text, ready to copy: truncated first, escaped second.
 *
 * Two of these plus a frame must still fit in one Telegram message, hence the
 * hard default cap.
 */
export const quote = (text, limit = 600, fallback = '<i>\u2014 بدون متن \u2014</i>') => {
  const value = String(text ?? '').trim();
  return value ? `<code>${esc(truncate(value, limit))}</code>` : fallback;
};

/** The status line that leads a card: `✅ done`, `⚠️ careful`. */
export const toast = (icon, text) => (text ? `${icon} <b>${esc(text)}</b>` : '');
