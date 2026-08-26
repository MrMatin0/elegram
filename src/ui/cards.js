import { LINK_FAILURES } from '../utils/links.js';
import { humanBytes, humanDuration, progressBar, esc, truncate } from '../utils/format.js';

export const LINE = '\u2501'.repeat(18);
const BRAND = '\u26A1\uFE0F <b>Elegram</b>';

/** Anchors are built here so a URL is escaped exactly once, in one place. */
export const link = (href, label) => `<a href="${esc(href)}">${esc(label)}</a>`;

/** Keeps deliberate blank separator lines, drops only nullish entries. */
const block = (lines) => lines.filter((line) => line != null).join('\n');
/** Drops anything falsy — for cards whose rows are conditional. */
const compact = (lines) => lines.filter(Boolean).join('\n');

export const helpCard = () => block([
  `${BRAND} — دستیار آرشیو تلگرام`,
  LINE,
  '<b>\u{1F3AE} دستورات</b>',
  '\u25AA\uFE0F <code>/save</code> — روی رسانه ریپلای کن و بفرست (حتی ضدفوروارد)',
  '\u25AA\uFE0F <code>/save &lt;لینک پست&gt;</code> — وقتی جایی برای ریپلای نیست',
  '\u25AA\uFE0F <code>/auto on</code> | <code>/auto off</code> — سیو خودکار همین چت',
  '\u25AA\uFE0F <code>/autolist</code> — چت‌های دارای سیو خودکار',
  '\u25AA\uFE0F <code>/status</code> — آمار و وضعیت سیستم',
  '\u25AA\uFE0F <code>/cancel</code> — پاک کردن صف انتظار',
  '\u25AA\uFE0F <code>/ping</code> — بررسی اتصال و آپ‌تایم',
  '\u25AA\uFE0F <code>/help</code> — همین راهنما',
  LINE,
  '<b>\u{1F3AF} قابلیت‌های همیشگی</b>',
  '\u25AB\uFE0F شکار لحظه‌ای رسانه‌های محوشونده (TTL)',
  '\u25AB\uFE0F عبور از قفل فوروارد با دانلود و بازآپلود',
  '\u25AB\uFE0F آلبوم، استیکر، وویس، ویدیو و همه فرمت‌ها بدون افت کیفیت',
  LINE,
  '\u{1F4A1} <i>رسانه‌های یک‌بارمصرف بدون هیچ دستوری سیو می‌شوند.</i>',
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
]);

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
  '<code>/auto on</code> یا <code>/auto off</code>',
]);

export const savedGuard = () => compact([
  '\u2139\uFE0F اینجا <b>Saved Messages</b> خودت است!',
  '',
  'برای فعال‌سازی سیو خودکار، داخل چت موردنظر دستور <code>/auto on</code> را بفرست.',
]);

export const autoList = (entries) => {
  const list = Array.isArray(entries) ? entries : Object.entries(entries ?? {});
  if (!list.length) {
    return compact([
      '\u{1F4ED} هیچ چتی دارای سیو خودکار نیست.',
      '',
      '\u{1F4A1} داخل چت موردنظر دستور <code>/auto on</code> را بفرست.',
    ]);
  }
  const rows = list
    .map(([key, value], index) => {
      const since = Number(value?.since) || Date.now();
      return `${index + 1}. <b>${esc(value?.title || key)}</b>\n    \u2514 از ${humanDuration(Date.now() - since)} پیش`;
    })
    .join('\n');
  return block([`\u{1F501} <b>چت‌های دارای سیو خودکار (${list.length})</b>`, LINE, rows]);
};

/** Usage lines shared by the "no target" and "bad link" cards. */
const SAVE_USAGE = [
  '\u25AA\uFE0F روی رسانه <b>ریپلای</b> کن و <code>/save</code> بفرست.',
  '\u25AA\uFE0F یا لینک پست را جلوی دستور بگذار:',
  '<code>/save https://t.me/channel/1234</code>',
  '<code>/save https://t.me/c/1234567890/1234</code>',
];

export const notReply = () => compact([
  '\u{1F914} پیامی برای ذخیره پیدا نکردم.',
  '',
  ...SAVE_USAGE,
]);

/**
 * `/save <link>` failures.
 *
 * One card per reason, because «نشد» is useless when the fix — عضو شدن در کانال
 * یا درست کردن شماره پیام — depends on which step failed.
 */
export const linkError = (reason) => {
  if (reason === LINK_FAILURES.PEER) {
    return compact([
      '\u{1F6A7} <b>به این چت دسترسی ندارم.</b>',
      '',
      'اگر کانال یا گروه خصوصی است، اول باید با همین اکانت عضوش باشی.',
      '\u{1F4A1} یک بار چت را در تلگرام باز کن تا شناخته شود، بعد دوباره <code>/save</code> بزن.',
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
