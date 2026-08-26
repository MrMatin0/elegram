import { COMMAND_PREFIX, cmd } from '../constants.js';
import { LINK_FAILURES } from '../utils/links.js';
import { humanBytes, humanDuration, progressBar, esc, truncate } from '../utils/format.js';

export const LINE = '\u2501'.repeat(18);
/** Lighter rule, for separating sections *inside* a card. */
export const SOFT = '\u2508'.repeat(18);
const BRAND = '\u26A1\uFE0F <b>Elegram</b>';

/** Anchors are built here so a URL is escaped exactly once, in one place. */
export const link = (href, label) => `<a href="${esc(href)}">${esc(label)}</a>`;

/** A command chip: one place decides how a command is spelled and styled. */
const chip = (name) => `<code>${cmd(name)}</code>`;

/** Keeps deliberate blank separator lines, drops only nullish entries. */
const block = (lines) => lines.filter((line) => line != null).join('\n');
/** Drops anything falsy — for cards whose rows are conditional. */
const compact = (lines) => lines.filter(Boolean).join('\n');

// A mirrored body is quoted verbatim, so it needs a hard cap of its own: two of
// them plus the frame must still fit in one Telegram message.
const BODY_LIMIT = 600;
const EMPTY_BODY = '<i>\u2014 بدون متن \u2014</i>';

/** Verbatim user text, truncated first and escaped second, ready to paste. */
const body = (text, limit = BODY_LIMIT) => {
  const value = String(text ?? '').trim();
  return value ? `<code>${esc(truncate(value, limit))}</code>` : EMPTY_BODY;
};

export const helpCard = () => block([
  `${BRAND} — دستیار آرشیو تلگرام`,
  LINE,
  `<b>\u{1F3AE} دستورات</b> <i>(همه با «${COMMAND_PREFIX}»)</i>`,
  `\u25AA\uFE0F ${chip('save')} — روی رسانه ریپلای کن و بفرست (حتی ضدفوروارد)`,
  `\u25AA\uFE0F ${chip('save')} <code>&lt;لینک پست&gt;</code> — وقتی جایی برای ریپلای نیست`,
  `\u25AA\uFE0F ${chip('auto on')} | ${chip('auto off')} — سیو خودکار رسانه‌های همین چت`,
  `\u25AA\uFE0F ${chip('autolist')} — چت‌های دارای سیو خودکار`,
  `\u25AA\uFE0F ${chip('mirror on')} | ${chip('mirror off')} — آینه لحظه‌ای همین چت`,
  `\u25AA\uFE0F ${chip('mirrorlist')} — چت‌های آینه‌شده`,
  `\u25AA\uFE0F ${chip('status')} — آمار و وضعیت سیستم`,
  `\u25AA\uFE0F ${chip('cancel')} — پاک کردن صف انتظار`,
  `\u25AA\uFE0F ${chip('ping')} — بررسی اتصال و آپ‌تایم`,
  `\u25AA\uFE0F ${chip('help')} — همین راهنما`,
  LINE,
  '<b>\u{1FA9E} آینه چطور کار می‌کند؟</b>',
  '\u25AB\uFE0F هر پیام آن چت، همان لحظه در آرشیو کپی می‌شود.',
  '\u25AB\uFE0F ویرایش شد؟ نسخه قبلی و جدید کنار هم ثبت می‌شوند.',
  '\u25AB\uFE0F پاک شد؟ متن اصلی همچنان پیش توست.',
  '\u25AB\uFE0F در گروه و کانال هم دقیقاً همین‌طور کار می‌کند.',
  LINE,
  '<b>\u{1F3AF} قابلیت‌های همیشگی</b>',
  '\u25AB\uFE0F شکار لحظه‌ای رسانه‌های محوشونده (TTL)',
  '\u25AB\uFE0F عبور از قفل فوروارد با دانلود و بازآپلود',
  '\u25AB\uFE0F آلبوم، استیکر، وویس، ویدیو و همه فرمت‌ها بدون افت کیفیت',
  LINE,
  `\u{1F4A1} <i>دستورها با «${COMMAND_PREFIX}» شروع می‌شوند، نه «/» — تا با ربات‌های دیگر تداخل نکنند.</i>`,
  '\u{1F92B} <i>خارج از Saved Messages، پیام دستور فوراً پاک می‌شود و گزارش فقط در آرشیو نوشته می‌شود.</i>',
]);

export const pingCard = ({ latency, uptime }) => block([
  '\u{1F3D3} <b>Pong!</b>',
  LINE,
  `\u26A1\uFE0F تأخیر: <code>${Number(latency) || 0}ms</code>`,
  `\u23F1 آپ‌تایم: <code>${humanDuration(uptime)}</code>`,
  '\u{1F4E1} وضعیت: <b>متصل و آماده</b>',
]);

export const statusCard = (s) => block([
  '\u{1F4CA} <b>وضعیت سیستم</b>',
  LINE,
  '<b>\u{1F5A5} سیستم</b>',
  `\u25AB\uFE0F آپ‌تایم: <code>${humanDuration(s.uptime)}</code>`,
  `\u25AB\uFE0F رم مصرفی: <code>${humanBytes(s.rss)}</code>`,
  `\u25AB\uFE0F نسخه: <code>Elegram ${esc(s.version)} \u2022 Node ${esc(s.node)}</code>`,
  '',
  '<b>\u{1F5C4} آرشیو</b>',
  `\u25AB\uFE0F مقصد: <code>${esc(s.dest)}</code>`,
  `\u25AB\uFE0F فایل‌های ذخیره‌شده: <b>${s.archived}</b>`,
  `\u25AB\uFE0F حجم کل: <b>${humanBytes(s.bytes)}</b>`,
  s.failed ? `\u25AB\uFE0F ناموفق: <b>${s.failed}</b>` : null,
  `\u25AB\uFE0F صف: <b>${s.pending}</b> در انتظار \u2022 <b>${s.running}</b> در حال پردازش`,
  '',
  '<b>\u{1F501} سیو خودکار</b>',
  `\u25AB\uFE0F چت‌های فعال: <b>${s.autos}</b>`,
  '',
  '<b>\u{1FA9E} آینه</b>',
  `\u25AB\uFE0F چت‌های فعال: <b>${s.mirrors ?? 0}</b>`,
  `\u25AB\uFE0F پیام‌های ثبت‌شده: <b>${s.mirrored ?? 0}</b>`,
  `\u25AB\uFE0F ویرایش: <b>${s.mirrorEdits ?? 0}</b> \u2022 حذف: <b>${s.mirrorDeletes ?? 0}</b>`,
]);

// ------------------------------------------------------------------ auto-save

export const autoOn = (title) => block([
  '\u{1F514} <b>سیو خودکار فعال شد</b>',
  LINE,
  `\u{1F4AC} چت: <b>${esc(title)}</b>`,
  '\u25AB\uFE0F از این پس تمام رسانه‌های این چت به‌صورت خودکار آرشیو می‌شوند.',
]);

export const autoOff = (title) => block([
  '\u{1F515} <b>سیو خودکار غیرفعال شد</b>',
  LINE,
  `\u{1F4AC} چت: <b>${esc(title)}</b>`,
]);

export const autoAlready = (title, on) => block([
  on ? '\u2139\uFE0F سیو خودکار این چت از قبل روشن بود.' : '\u2139\uFE0F سیو خودکار این چت از قبل خاموش بود.',
  '',
  `\u{1F4AC} چت: <b>${esc(title)}</b>`,
]);

export const autoUsage = () => compact([
  '\u26A0\uFE0F استفاده صحیح:',
  '',
  `${chip('auto on')} یا ${chip('auto off')}`,
]);

/** `name` is the command the user just tried to run inside Saved Messages. */
export const savedGuard = (name = 'auto') => compact([
  '\u2139\uFE0F اینجا <b>Saved Messages</b> خودت است!',
  '',
  `برای فعال‌سازی، داخل چت موردنظر دستور ${chip(`${name} on`)} را بفرست.`,
]);

export const autoList = (entries) => {
  const list = Array.isArray(entries) ? entries : Object.entries(entries ?? {});
  if (!list.length) {
    return compact([
      '\u{1F4ED} هیچ چتی دارای سیو خودکار نیست.',
      '',
      `\u{1F4A1} داخل چت موردنظر دستور ${chip('auto on')} را بفرست.`,
    ]);
  }
  return block([`\u{1F501} <b>چت‌های دارای سیو خودکار (${list.length})</b>`, LINE, chatRows(list)]);
};

/** Shared numbered list of `[chatKey, { title, since }]` pairs. */
function chatRows(list) {
  return list
    .map(([key, value], index) => {
      const since = Number(value?.since) || Date.now();
      return `${index + 1}. <b>${esc(value?.title || key)}</b>\n    \u2514 از ${humanDuration(Date.now() - since)} پیش`;
    })
    .join('\n');
}

// --------------------------------------------------------------------- mirror

export const mirrorOn = (title) => block([
  '\u{1FA9E} <b>آینه روشن شد</b>',
  LINE,
  `\u{1F4AC} چت: <b>${esc(title)}</b>`,
  SOFT,
  '\u25AB\uFE0F هر پیام جدید همان لحظه در آرشیو کپی می‌شود.',
  '\u25AB\uFE0F ویرایش شد \u2192 نسخه قبلی و جدید کنار هم ثبت می‌شوند.',
  '\u25AB\uFE0F پاک شد \u2192 متن اصلی پیش خودت می‌ماند.',
  '\u25AB\uFE0F رسانه‌های این چت هم خودکار آرشیو می‌شوند.',
]);

export const mirrorOff = (title) => block([
  '\u{1F6D1} <b>آینه خاموش شد</b>',
  LINE,
  `\u{1F4AC} چت: <b>${esc(title)}</b>`,
  '\u25AB\uFE0F هر چه تا الآن ثبت شده، سر جایش در آرشیو می‌ماند.',
]);

export const mirrorAlready = (title, on) => block([
  on ? '\u2139\uFE0F آینه این چت از قبل روشن بود.' : '\u2139\uFE0F آینه این چت از قبل خاموش بود.',
  '',
  `\u{1F4AC} چت: <b>${esc(title)}</b>`,
]);

export const mirrorUsage = () => compact([
  '\u26A0\uFE0F استفاده صحیح:',
  '',
  `${chip('mirror on')} یا ${chip('mirror off')}`,
]);

export const mirrorList = (entries) => {
  const list = Array.isArray(entries) ? entries : Object.entries(entries ?? {});
  if (!list.length) {
    return compact([
      '\u{1F4ED} هیچ چتی آینه نشده.',
      '',
      `\u{1F4A1} داخل چت موردنظر دستور ${chip('mirror on')} را بفرست.`,
    ]);
  }
  return block([`\u{1FA9E} <b>چت‌های آینه‌شده (${list.length})</b>`, LINE, chatRows(list)]);
};

/** The live copy, written the moment a message lands. */
export const mirrorCard = (info) => compact([
  '\u{1FA9E} <b>آینه</b> \u2022 <i>نسخه اصلی ثبت شد</i>',
  LINE,
  info.chatTitle ? `\u{1F4AC} <b>${esc(info.chatTitle)}</b>` : '',
  info.senderName ? `\u{1F464} ${esc(info.senderName)}` : '',
  info.kind ? `\u{1F5C2} ${esc(info.kind)}` : '',
  info.date ? `\u{1F553} <i>${esc(info.date)}</i>` : '',
  SOFT,
  body(info.text),
  info.link ? `${SOFT}\n${link(info.link, '\u{1F517} مشاهده در چت')}` : '',
]);

/** Someone rewrote history; both versions go on the record. */
export const mirrorEditCard = (info) => compact([
  `\u270F\uFE0F <b>پیام ویرایش شد</b>${info.revisions > 1 ? ` \u2022 <i>ویرایش #${info.revisions}</i>` : ''}`,
  LINE,
  info.chatTitle ? `\u{1F4AC} <b>${esc(info.chatTitle)}</b>` : '',
  info.senderName ? `\u{1F464} ${esc(info.senderName)}` : '',
  info.at ? `\u{1F553} <i>${esc(info.at)}</i>` : '',
  SOFT,
  '\u{1F535} <b>نسخه قبلی</b>',
  body(info.previous),
  '',
  '\u{1F7E2} <b>نسخه فعلی</b>',
  body(info.next),
  info.revisions > 1 && info.original && info.original !== info.previous
    ? `${SOFT}\n\u{1F4CC} <b>نسخه اول</b>\n${body(info.original)}`
    : '',
  SOFT,
  '\u{1F6E1} <i>نسخه اصلی همیشه بالاتر، در همین رشته، محفوظ است.</i>',
  info.link ? link(info.link, '\u{1F517} مشاهده در چت') : '',
]);

/** They hit "delete for everyone". Too late. */
export const mirrorDeleteCard = (info) => compact([
  '\u{1F5D1} <b>پیام پاک شد</b> \u2022 <i>ولی نسخه‌اش پیش توست</i>',
  LINE,
  info.chatTitle ? `\u{1F4AC} <b>${esc(info.chatTitle)}</b>` : '',
  info.senderName ? `\u{1F464} ${esc(info.senderName)}` : '',
  info.date ? `\u{1F553} زمان اصلی: <i>${esc(info.date)}</i>` : '',
  info.at ? `\u{1F4A5} زمان حذف: <i>${esc(info.at)}</i>` : '',
  info.kind ? `\u{1F5C2} ${esc(info.kind)}` : '',
  SOFT,
  '\u{1F4C4} <b>متن اصلی</b>',
  body(info.original ?? info.text),
  info.revisions
    ? `${SOFT}\n\u270F\uFE0F <i>قبل از حذف ${info.revisions} بار ویرایش شده بود \u2014 آخرین نسخه:</i>\n${body(info.text)}`
    : '',
  SOFT,
  '\u2705 <i>نسخه آینه‌ای این پیام در آرشیو تو دست‌نخورده باقی می‌ماند.</i>',
]);

// ----------------------------------------------------------------------- save

/** Usage lines shared by the "no target" and "bad link" cards. */
const SAVE_USAGE = [
  `\u25AA\uFE0F روی رسانه <b>ریپلای</b> کن و ${chip('save')} بفرست.`,
  '\u25AA\uFE0F یا لینک پست را جلوی دستور بگذار:',
  `<code>${cmd('save')} https://t.me/channel/1234</code>`,
  `<code>${cmd('save')} https://t.me/c/1234567890/1234</code>`,
];

export const notReply = () => compact([
  '\u{1F914} پیامی برای ذخیره پیدا نکردم.',
  '',
  ...SAVE_USAGE,
]);

export const linkError = (reason) => {
  if (reason === LINK_FAILURES.PEER) {
    return compact([
      '\u{1F6A7} <b>به این چت دسترسی ندارم.</b>',
      '',
      'اگر کانال یا گروه خصوصی است، اول باید با همین اکانت عضوش باشی.',
      `\u{1F4A1} یک بار چت را در تلگرام باز کن تا شناخته شود، بعد دوباره ${chip('save')} بزن.`,
    ]);
  }
  if (reason === LINK_FAILURES.MESSAGE) {
    return compact([
      '\u{1F50D} <b>پیامی با این لینک پیدا نشد.</b>',
      '',
      'شماره پیام را دوباره چک کن؛ ممکن است پاک شده باشد.',
    ]);
  }
  return compact([
    '\u{1F517} <b>این یک لینک پیام تلگرام نیست.</b>',
    '',
    ...SAVE_USAGE,
  ]);
};

export const noMedia = () => '\u{1F6AB} در این پیام رسانه‌ای برای آرشیو وجود ندارد.';

export const queuedCard = ({ kind, size, pos, urgent }) => compact([
  '\u{1F4E5} <b>در صف آرشیو…</b>',
  LINE,
  `\u{1F5C2} نوع: <b>${esc(kind)}</b>`,
  size && size !== '0 B' ? `\u{1F4BE} حجم: <b>${esc(size)}</b>` : '',
  `\u{1F4CD} جایگاه در صف: <b>${pos}</b>`,
  urgent ? '\n\u26A1\uFE0F <b>اولویت حداکثری — رسانه محوشونده!</b>' : '',
]);

export const progressCard = ({ stage, pct, kind, size, urgent }) => {
  const label = stage === 'download'
    ? '\u2B07\uFE0F <b>در حال دانلود از منبع…</b>'
    : '\u2B06\uFE0F <b>در حال آپلود به آرشیو…</b>';
  return compact([
    '\u{1F4E6} <b>در حال آرشیو</b>',
    LINE,
    label,
    `<code>[${progressBar(pct)}] ${pct}%</code>`,
    `\u{1F5C2} ${esc(kind)}${size && size !== '0 B' ? ` \u2022 \u{1F4BE} ${esc(size)}` : ''}`,
    urgent ? '\u23F3 رسانه محوشونده — با سرعت کامل!' : '',
  ]);
};

export const albumCard = (count, kind, size) => compact([
  '\u{1F5C3} <b>در حال آرشیو آلبوم</b>',
  LINE,
  `\u25AB\uFE0F تعداد: <b>${count}</b> مورد`,
  `\u25AB\uFE0F حجم کل: <b>${esc(size)}</b>`,
  kind ? `\u25AB\uFE0F محتوا: <b>${esc(kind)}</b>` : '',
]);

export const cancelCard = (dropped) => block([
  dropped ? '\u{1F9F9} <b>صف پاک شد</b>' : '\u2139\uFE0F صف خالی بود.',
  LINE,
  `\u25AB\uFE0F کارهای حذف‌شده: <b>${dropped}</b>`,
  '\u25AB\uFE0F کارهای در حال اجرا متوقف نمی‌شوند.',
]);

// Truncate raw text first, escape second — a blind cut can slice an entity.
export const errorCard = (message) => block([
  '\u274C <b>آرشیو ناموفق بود</b>',
  LINE,
  `<code>${esc(truncate(message || 'خطای ناشناخته', 300))}</code>`,
]);
