import { humanBytes, humanDuration, progressBar, esc } from '../utils/format.js';

export const LINE = '━━━━━━━━━━━━━━━━━━';
const BRAND = '⚡️ <b>Elegram</b>';

export const helpCard = () => [
  `${BRAND} — دستیار آرشیو تلگرام`,
  LINE,
  '<b>🎮 دستورات</b>',
  '▪️ <code>/ping</code> — بررسی اتصال و آپ‌تایم',
  '▪️ <code>/save</code> — آرشیو پیام ریپلای‌شده (حتی ضدفوروارد)',
  '▪️ <code>/auto on</code> | <code>/auto off</code> — سیو خودکار همین چت',
  '▪️ <code>/autolist</code> — چت‌های دارای سیو خودکار',
  '▪️ <code>/status</code> — آمار و وضعیت سیستم',
  '▪️ <code>/help</code> — راهنما',
  LINE,
  '<b>🎯 قابلیت‌های همیشگی</b>',
  '▫️ شکار لحظه‌ای رسانه‌های محوشونده (TTL)',
  '▫️ عبور از قفل فوروارد با دانلود و بازآپلود',
  '▫️ آلبوم، استیکر، وویس، ویدیو و همه فرمت‌ها بدون افت کیفیت',
  LINE,
  '💡 <i>روی رسانه ریپلای کن و /save بزن</i>',
].join('\n');

export const pingCard = ({ latency, uptime }) => [
  '🏓 <b>Pong!</b>',
  LINE,
  `⚡️ تأخیر: <code>${latency}ms</code>`,
  `⏱ آپ‌تایم: <code>${humanDuration(uptime)}</code>`,
  '📡 وضعیت: <b>متصل و آماده</b>',
].join('\n');

export const statusCard = (s) => [
  '📊 <b>وضعیت سیستم</b>',
  LINE,
  '<b>🖥 سیستم</b>',
  `▫️ آپ‌تایم: <code>${humanDuration(s.uptime)}</code>`,
  `▫️ رم مصرفی: <code>${humanBytes(s.rss)}</code>`,
  `▫️ نسخه Node: <code>${s.node}</code>`,
  '',
  '<b>🗄 آرشیو</b>',
  `▫️ فایل‌های ذخیره‌شده: <b>${s.archived}</b>`,
  `▫️ حجم کل: <b>${humanBytes(s.bytes)}</b>`,
  `▫️ صف: <b>${s.pending}</b> در انتظار • <b>${s.running}</b> در حال پردازش`,
  '',
  '<b>🔁 سیو خودکار</b>',
  `▫️ چت‌های فعال: <b>${s.autos}</b>`,
].join('\n');

export const autoOn = (title) => [
  '🔔 <b>سیو خودکار فعال شد</b>',
  LINE,
  `💬 چت: <b>${esc(title)}</b>`,
  '▫️ از این پس تمام رسانه‌های این چت به‌صورت خودکار آرشیو می‌شوند.',
].join('\n');

export const autoOff = (title) => [
  '🔕 <b>سیو خودکار غیرفعال شد</b>',
  LINE,
  `💬 چت: <b>${esc(title)}</b>`,
].join('\n');

export const autoUsage = () =>
  ['⚠️ استفاده صحیح:', '', '<code>/auto on</code> یا <code>/auto off</code>'].join('\n');

export const savedGuard = () =>
  [
    'ℹ️ اینجا <b>Saved Messages</b> خودت است!',
    '',
    'برای فعال‌سازی سیو خودکار، داخل چت موردنظر دستور <code>/auto on</code> را بفرست.',
  ].join('\n');

export const autoList = (map) => {
  const entries = Object.entries(map || {});
  if (!entries.length) {
    return [
      '📭 هیچ چتی دارای سیو خودکار نیست.',
      '',
      '💡 داخل چت موردنظر دستور <code>/auto on</code> را بفرست.',
    ].join('\n');
  }
  const rows = entries
    .map(([key, v], i) => `${i + 1}. <b>${esc(v?.title || key)}</b>\n    └ از ${humanDuration(Date.now() - (v?.since || Date.now()))} پیش`)
    .join('\n');
  return [`🔁 <b>چت‌های دارای سیو خودکار (${entries.length})</b>`, LINE, rows].join('\n');
};

export const notReply = () =>
  [
    '🤔 پیامی برای ذخیره پیدا نکردم.',
    '',
    'روی پیام یا رسانه موردنظر <b>ریپلای</b> کن و بعد <code>/save</code> بفرست.',
  ].join('\n');

export const noMedia = () =>
  ['🚫 در این پیام رسانه‌ای برای آرشیو وجود ندارد.'].join('\n');

export const queuedCard = ({ kind, size, pos, urgent }) =>
  [
    '📥 <b>در صف آرشیو…</b>',
    LINE,
    `🗂 نوع: <b>${kind}</b>`,
    size && size !== '0 B' ? `💾 حجم: <b>${size}</b>` : '',
    `📍 جایگاه در صف: <b>${pos}</b>`,
    urgent ? '\n⚡️ <b>اولویت حداکثری — رسانه محوشونده!</b>' : '',
  ].filter(Boolean).join('\n');

export const progressCard = ({ stage, pct, kind, size, urgent }) => {
  const label = stage === 'download' ? '⬇️ <b>در حال دانلود از منبع…</b>' : '⬆️ <b>در حال آپلود به آرشیو…</b>';
  return [
    '📦 <b>در حال آرشیو</b>',
    LINE,
    label,
    `<code>[${progressBar(pct)}] ${pct}%</code>`,
    `🗂 ${kind}${size && size !== '0 B' ? ` • 💾 ${size}` : ''}`,
    urgent ? '⏳ رسانه محوشونده — با سرعت کامل!' : '',
  ].filter(Boolean).join('\n');
};

export const albumCard = (count, kind, size) =>
  [
    '🗃 <b>در حال آرشیو آلبوم</b>',
    LINE,
    `▫️ تعداد: <b>${count}</b> مورد`,
    `▫️ حجم کل: <b>${size}</b>`,
    kind ? `▫️ محتوا: <b>${kind}</b>` : '',
  ].filter(Boolean).join('\n');

export const errorCard = (message) =>
  [
    '❌ <b>آرشیو ناموفق بود</b>',
    LINE,
    `<code>${esc(String(message || 'خطای ناشناخته')).slice(0, 300)}</code>`,
  ].join('\n');
