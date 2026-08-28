/**
 * Every card the *self account* writes.
 *
 * These are plain HTML messages: a user account cannot attach glass buttons to
 * anything it sends (see `ui/glass.js`), so the layout itself has to do the work
 * that a keyboard would otherwise do — grouping, ranking, and telling the user
 * what to type next. All furniture comes from `ui/theme.js`; nothing here
 * invents its own rule, icon or spacing.
 */
import { COMMAND_PREFIX, cmd } from '../constants.js';
import { LINK_FAILURES } from '../utils/links.js';
import { TARGET_FAILURES } from '../utils/targets.js';
import { humanBytes, humanDuration, esc, truncate } from '../utils/format.js';
import {
  BRAND, ICON, MARK, BULLET, MID, RULE, SOFT,
  block, code, compact, gauge, header, hint, kv, kvRaw, link, meter, pill, quote, section, stack, toast, tree,
} from './theme.js';

/** Kept for the modules that frame their own captions (archiver). */
export const LINE = RULE;
export { SOFT, link };

/** A command chip: one place decides how a command is spelled and styled. */
const chip = (name) => code(cmd(name));

/** The exact key, so the user can paste it straight into an `off` form. */
const idRow = (chatKey) => (chatKey ? `${ICON.id} شناسه: ${code(chatKey)}` : '');

const chatRow = (title) => `${ICON.chat} <b>${esc(title)}</b>`;

// ------------------------------------------------------------------------ help

export const helpCard = () => stack([
  header(ICON.bolt, BRAND, 'دستیار آرشیو تلگرام'),
  compact([
    section(ICON.game, 'دستورها'),
    `<i>همه با «${COMMAND_PREFIX}» شروع می‌شوند</i>`,
    '',
    `${MARK} ${chip('panel')} — پنل کنترل شیشه‌ای`,
    `${MARK} ${chip('save')} — روی رسانه ریپلای کن و بفرست (حتی ضدفوروارد)`,
    `${MARK} ${chip('save')} ${code('<لینک پست>')} — وقتی جایی برای ریپلای نیست`,
    `${MARK} ${chip('auto on')} ${MID} ${chip('auto off')} — سیو خودکار همین چت`,
    `${MARK} ${chip('autolist')} — چت‌های دارای سیو خودکار`,
    `${MARK} ${chip('mirror on')} ${MID} ${chip('mirror off')} — آینه لحظه‌ای همین چت`,
    `${MARK} ${chip('mirror')} ${code('@username')} — آینه یک کانال/گروه <b>از هر جا</b>`,
    `${MARK} ${chip('mirrorlist')} — چت‌های آینه‌شده`,
    `${MARK} ${chip('comment')} ${code('@channel | متن')} — اولین کامنت هر پست کانال`,
    `${MARK} ${chip('commentlist')} — کانال‌های دارای کامنت اول`,
    `${MARK} ${chip('status')} — آمار و وضعیت سیستم`,
    `${MARK} ${chip('id')} — شناسه همین چت`,
    `${MARK} ${chip('cancel')} — پاک کردن صف انتطار`,
    `${MARK} ${chip('ping')} — بررسی اتصال و آپ‌تایم`,
    `${MARK} ${chip('help')} — همین راهنما`,
  ]),
  compact([
    section(ICON.panel, 'پنل کنترل'),
    `${BULLET} ${chip('panel')} را بفرست تا لینک پنل شیشه‌ای را بگیری.`,
    `${BULLET} همه‌ی کارها آنجا با دکمه انجام می‌شود: صف، آینه، سیو خودکار، تنطیمات.`,
    `${BULLET} دکمه‌های شیشه‌ای فقط از سمت ربات ساخته می‌شوند، پس پنل روی ربات همراه است.`,
  ]),
  compact([
    section(ICON.radar, 'کانال و گروهی که نمی‌شود در آن نوشت'),
    `${BULLET} یوزرنیم یا شناسه عددی را جلوی دستور بگذار: ${code(`${cmd('mirror')} @channel`)}`,
    `${BULLET} شناسه خصوصی هم قبول است: ${code(`${cmd('mirror')} -1001234567890`)}`,
    `${BULLET} ${chip('auto')} و ${chip('comment')} هم دقیقاً همین شکل را می‌پذیرند.`,
    `${BULLET} این دستورها را از داخل Saved Messages خودت بفرست.`,
  ]),
  compact([
    section(ICON.mirror, 'آینه چطور کار می‌کند؟'),
    `${BULLET} هر پیام آن چت، همان لحظه در آرشیو کپی می‌شود.`,
    `${BULLET} ویرایش شد؟ نسخه قبلی و جدید کنار هم ثبت می‌شوند.`,
    `${BULLET} پاک شد؟ متن اصلی همچنان پیش توست.`,
    `${BULLET} در گروه و کانال هم دقیقاً همین‌طور کار می‌کند.`,
  ]),
  compact([
    section(ICON.comment, 'کامنت اول چطور کار می‌کند؟'),
    `${BULLET} کانال و متن را یک‌جا بده: ${code(`${cmd('comment')} @channel | متن کامنت`)}`,
    `${BULLET} تا پست جدید منتشر شود، همین متن اولین کامنت زیر آن می‌شود.`,
    `${BULLET} کانال باید گروه گفتگو (Discussion) داشته باشد.`,
    `${BULLET} در متن می‌توانی ${code('{title}')} ${code('{link}')} ${code('{id}')} ${code('{date}')} بگذاری.`,
  ]),
  compact([
    section(ICON.target, 'قابلیت‌های همیشگی'),
    `${BULLET} شکار لحظه‌ای رسانه‌های محوشونده (TTL)`,
    `${BULLET} عبور از قفل فوروارد با دانلود و بازآپلود`,
    `${BULLET} آلبوم، استیکر، وویس، ویدیو و همه فرمت‌ها بدون افت کیفیت`,
  ]),
  compact([
    hint(`دستورها با «${COMMAND_PREFIX}» شروع می‌شوند، نه «/» — تا با ربات‌های دیگر تداخل نکنند.`),
    `${ICON.hush} <i>خارج از Saved Messages، پیام دستور فوراً پاک می‌شود و گزارش فقط در آرشیو نوشته می‌شود.</i>`,
  ]),
]);

// ---------------------------------------------------------------------- health

export const pingCard = ({ latency, uptime }) => stack([
  header(ICON.ping, '<b>Pong!</b>'),
  tree([
    kv('تأخیر', `${Number(latency) || 0}ms`),
    kv('آپ‌تایم', humanDuration(uptime)),
    kvRaw('وضعیت', pill(true, 'متصل و آماده')),
  ]),
]);

/**
 * The status card is the text twin of the panel dashboard: same regions, same
 * order, same numbers. Reading one and then the other should feel like the same
 * screen, because it is.
 */
export const statusCard = (s) => stack([
  header(ICON.stats, '<b>وضعیت سیستم</b>', s.panel ? 'پنل فعال' : ''),
  compact([
    section(ICON.system, 'سیستم'),
    tree([
      kv('آپ‌تایم', humanDuration(s.uptime)),
      kv('رم مصرفی', humanBytes(s.rss)),
      kv('نسخه', `Elegram ${s.version} ${MID} Node ${s.node}`),
    ]),
  ]),
  compact([
    section(ICON.archive, 'آرشیو'),
    tree([
      kvRaw('مقصد', code(s.dest)),
      kv('فایل‌های ذخیره‌شده', String(s.archived)),
      kv('حجم کل', humanBytes(s.bytes)),
      s.failed ? kv('ناموفق', String(s.failed)) : '',
      kv('صف', `${s.pending} در انتطار ${MID} ${s.running} در حال پردازش`),
    ]),
  ]),
  compact([
    section(ICON.auto, 'سیو خودکار'),
    tree([kv('چت‌های فعال', String(s.autos))]),
  ]),
  compact([
    section(ICON.mirror, 'آینه'),
    tree([
      kv('چت‌های فعال', String(s.mirrors ?? 0)),
      kv('پیام‌های ثبت‌شده', String(s.mirrored ?? 0)),
      kv('ویرایش', String(s.mirrorEdits ?? 0)),
      kv('حذف', String(s.mirrorDeletes ?? 0)),
    ]),
  ]),
  compact([
    section(ICON.comment, 'کامنت اول'),
    tree([
      kv('کانال‌های فعال', String(s.comments ?? 0)),
      kv('کامنت‌های گذاشته‌شده', String(s.commented ?? 0)),
      s.commentFails ? kv('ناموفق', String(s.commentFails)) : '',
    ]),
  ]),
  s.panelLink
    ? hint(`پنل شیشه‌ای: ${link(s.panelLink, 'باز کردن پنل')}`)
    : hint(`برای پنل شیشه‌ای ${chip('panel')} را بفرست.`),
]);

export const idCard = ({ title, chatKey, kind, userId }) => stack([
  header(ICON.id, '<b>شناسه‌ها</b>'),
  tree([
    title ? kv('چت', title) : '',
    chatKey ? kvRaw('شناسه چت', code(chatKey)) : '',
    kind ? kv('نوع', kind) : '',
    userId ? kvRaw('شناسه تو', code(userId)) : '',
  ]),
  hint(`همین شناسه را می‌توانی به ${chip('mirror')} یا ${chip('auto')} بدهی.`),
]);

// ----------------------------------------------------------------------- panel

/** `.panel` — the self account cannot draw buttons, so it hands over a door. */
export const panelCard = ({ username, owner, configured, ready }) => {
  if (!configured) {
    return stack([
      header(ICON.panel, '<b>پنل کنترل</b>', 'غیرفعال'),
      compact([
        `${ICON.warn} <b>ربات همراه تنطیم نشده است.</b>`,
        '',
        `${BULLET} یک ربات از @BotFather بساز.`,
        `${BULLET} توکنش را در ${code('BOT_TOKEN')} بگذار و سرویس را ری‌استارت کن.`,
        `${BULLET} همین حساب مالک پنل می‌شود؛ کسی دیگر به آن دسترسی ندارد.`,
      ]),
      hint('پنل، دکمه‌های شیشه‌ای، صفحه‌بندی و تأیید دومرحله‌ای را از ربات می‌گیرد؛ آرشیو همچنان با همین حساب انجام می‌شود.'),
    ]);
  }
  const url = username ? `https://t.me/${username}?start=panel` : '';
  return stack([
    header(ICON.panel, '<b>پنل کنترل</b>', ready ? 'آماده' : 'در حال اتصال'),
    tree([
      username ? kvRaw('ربات', code(`@${username}`)) : '',
      owner ? kvRaw('مالک', code(owner)) : '',
      kvRaw('وضعیت', pill(Boolean(ready), 'آماده', 'در حال اتصال')),
    ]),
    url ? `${ICON.spark} ${link(url, 'باز کردن پنل شیشه‌ای')}` : '',
    hint(`اگر پنل جواب نداد، در ربات ${code('/panel')} را بفرست.`),
  ]);
};

// ---------------------------------------------------------------- chat toggles

/**
 * Every shape of a chat toggle, written once. `name` is `auto` or `mirror`.
 *
 * The target forms exist because the in-chat form cannot work everywhere: a
 * broadcast channel (and a read-only group) gives you nowhere to type.
 */
const toggleUsage = (name) => (name === 'comment' ? commentUsageLines() : [
  `${MARK} داخل خود چت: ${chip(`${name} on`)} یا ${chip(`${name} off`)}`,
  `${MARK} از هر جا، با یوزرنیم یا شناسه عددی:`,
  code(`${cmd(name)} @username`),
  code(`${cmd(name)} -1001234567890`),
  `${MARK} برای حذف از لیست:`,
  code(`${cmd(name)} off @username`),
  code(`${cmd(name)} off -1001234567890`),
]);

export const autoUsage = () => stack([
  toast(ICON.warn, 'استفاده صحیح'),
  compact(toggleUsage('auto')),
  hint(`با ${chip('panel')} همین کار را با دکمه انجام بده.`),
]);

export const mirrorUsage = () => stack([
  toast(ICON.warn, 'استفاده صحیح'),
  compact(toggleUsage('mirror')),
  hint(`با ${chip('panel')} همین کار را با دکمه انجام بده.`),
]);

/** `name` is the command the user just tried to run inside Saved Messages. */
export const savedGuard = (name = 'auto') => stack([
  toast(ICON.info, 'اینجا Saved Messages خودت است'),
  compact([
    `برای فعال‌سازی، داخل چت موردنطر ${chip(`${name} on`)} را بفرست.`,
    `اگر آن چت اجازه نوشتن نمی‌دهد، از همین‌جا: ${code(`${cmd(name)} @username`)}`,
  ]),
]);

/** A username/id we could not turn into a chat. `name` is `auto` or `mirror`. */
export const targetError = (name, reason, raw = '') => {
  const echo = raw ? `${ICON.search} ورودی: ${code(truncate(String(raw), 80))}` : '';
  if (reason === TARGET_FAILURES.PEER) {
    return stack([
      toast(ICON.build, 'این چت را پیدا نکردم'),
      echo,
      compact([
        'اگر خصوصی است، باید با همین اکانت عضوش باشی و یک بار در تلگرام بازش کنی.',
        hint(`شناسه عددی را کامل بده (با ${code('-100')}) یا از یوزرنیم استفاده کن: ${code(`${cmd(name)} -1001234567890`)}`),
      ]),
    ]);
  }
  return stack([
    toast(ICON.think, 'این یوزرنیم یا شناسه معتبر نیست'),
    echo,
    compact(toggleUsage(name)),
  ]);
};

// ------------------------------------------------------------------- auto-save

export const autoOn = (title, chatKey = '') => stack([
  header(ICON.bell, '<b>سیو خودکار فعال شد</b>'),
  compact([chatRow(title), idRow(chatKey)]),
  `${BULLET} از این پس تمام رسانه‌های این چت به‌صورت خودکار آرشیو می‌شوند.`,
]);

export const autoOff = (title, chatKey = '') => stack([
  header(ICON.mute, '<b>سیو خودکار غیرفعال شد</b>'),
  compact([chatRow(title), idRow(chatKey)]),
]);

export const autoAlready = (title, on, chatKey = '') => stack([
  toast(ICON.info, on ? 'سیو خودکار این چت از قبل روشن بود.' : 'سیو خودکار این چت از قبل خاموش بود.'),
  compact([chatRow(title), idRow(chatKey)]),
]);

export const autoList = (entries) => chatListCard({
  entries,
  icon: ICON.auto,
  title: 'چت‌های دارای سیو خودکار',
  empty: 'هیچ چتی دارای سیو خودکار نیست.',
  name: 'auto',
});

// ---------------------------------------------------------------------- mirror

export const mirrorOn = (title, chatKey = '') => stack([
  header(ICON.mirror, '<b>آینه روشن شد</b>'),
  compact([chatRow(title), idRow(chatKey)]),
  compact([
    `${BULLET} هر پیام جدید همان لحظه در آرشیو کپی می‌شود.`,
    `${BULLET} ویرایش شد \u2192 نسخه قبلی و جدید کنار هم ثبت می‌شوند.`,
    `${BULLET} پاک شد \u2192 متن اصلی پیش خودت می‌ماند.`,
    `${BULLET} رسانه‌های این چت هم خودکار آرشیو می‌شوند.`,
  ]),
]);

export const mirrorOff = (title, chatKey = '') => stack([
  header(ICON.stop, '<b>آینه خاموش شد</b>'),
  compact([chatRow(title), idRow(chatKey)]),
  `${BULLET} هر چه تا الآن ثبت شده، سر جایش در آرشیو می‌ماند.`,
]);

export const mirrorAlready = (title, on, chatKey = '') => stack([
  toast(ICON.info, on ? 'آینه این چت از قبل روشن بود.' : 'آینه این چت از قبل خاموش بود.'),
  compact([chatRow(title), idRow(chatKey)]),
]);

export const mirrorList = (entries) => chatListCard({
  entries,
  icon: ICON.mirror,
  title: 'چت‌های آینه‌شده',
  empty: 'هیچ چتی آینه نشده.',
  name: 'mirror',
});

/**
 * Shared numbered list of `[chatKey, { title, since }]` pairs.
 *
 * The key is printed on purpose: it is the argument the `off` form takes, and
 * for a channel you cannot post in it is the only handle you have.
 */
function chatRows(list) {
  return list
    .map(([key, value], index) => {
      const since = Number(value?.since) || Date.now();
      return [
        `${index + 1}. <b>${esc(value?.title || key)}</b>`,
        `    \u251C ${code(key)}${value?.username ? ` ${MID} @${esc(value.username)}` : ''}`,
        `    \u2514 از ${humanDuration(Date.now() - since)} پیش`,
      ].join('\n');
    })
    .join('\n');
}

function chatListCard({ entries, icon, title, empty, name }) {
  const list = Array.isArray(entries) ? entries : Object.entries(entries ?? {});
  if (!list.length) {
    return stack([
      toast(ICON.empty, empty),
      hint(`داخل چت موردنطر ${chip(`${name} on`)} را بفرست، یا از هر جا: ${code(`${cmd(name)} @username`)}`),
    ]);
  }
  return stack([
    header(icon, `<b>${esc(title)} (${list.length})</b>`),
    chatRows(list),
    compact([
      hint(`حذف: ${code(`${cmd(name)} off <شناسه>`)}`),
      hint(`یا با دکمه: ${chip('panel')}`),
    ]),
  ]);
}

// --------------------------------------------------------------- first comment

/**
 * The `.comment` forms. Kept separate from `toggleUsage` because this toggle
 * carries a payload: a channel *and* the text to post under its next post.
 */
const commentUsageLines = () => [
  `${MARK} کانال و متن کامنت را با هم بده:`,
  code(`${cmd('comment')} @channel | متن کامنت`),
  `${MARK} یا متن را در خط بعد بنویس:`,
  code(`${cmd('comment')} @channel\nمتن کامنت`),
  `${MARK} شناسه عددی هم قبول است:`,
  code(`${cmd('comment')} -1001234567890 | سلام`),
  `${MARK} برای خاموش کردن:`,
  code(`${cmd('comment')} off @channel`),
];

const PLACEHOLDER_HINT = `${ICON.spark} <i>در متن می‌توانی ${code('{title}')} ${code('{link}')} ${code('{id}')} ${code('{date}')} بگذاری؛ هر بار با مقدار همان پست پر می‌شود.</i>`;

export const commentUsage = () => stack([
  toast(ICON.warn, 'استفاده صحیح'),
  compact(commentUsageLines()),
  PLACEHOLDER_HINT,
  hint(`لیست کانال‌ها: ${chip('commentlist')} ${MID} با دکمه: ${chip('panel')}`),
]);

export const commentOn = (title, chatKey = '', text = '', updated = false) => stack([
  header(ICON.comment, `<b>کامنت اول ${updated ? 'به‌روز شد' : 'فعال شد'}</b>`),
  compact([chatRow(title), idRow(chatKey)]),
  compact([`${ICON.page} <b>متن کامنت</b>`, quote(text, 400)]),
  compact([
    `${BULLET} به محض انتشار هر پست جدید، همین متن اولین کامنت زیر آن می‌شود.`,
    `${BULLET} کانال باید گروه گفتگو (Discussion) داشته باشد.`,
    `${BULLET} آلبوم چندتایی یک کامنت می‌گیرد، نه چند تا.`,
  ]),
  PLACEHOLDER_HINT,
]);

export const commentOff = (title, chatKey = '') => stack([
  header(ICON.stop, '<b>کامنت اول خاموش شد</b>'),
  compact([chatRow(title), idRow(chatKey)]),
  `${BULLET} کامنت‌هایی که تا الآن گذاشته شده، سر جایشان می‌مانند.`,
]);

export const commentAlready = (title, on, chatKey = '') => stack([
  toast(ICON.info, on ? 'کامنت اول این کانال از قبل روشن بود.' : 'کامنت اول این کانال از قبل خاموش بود.'),
  compact([chatRow(title), idRow(chatKey)]),
]);

/** The channel resolved fine; there is just no text to post under its posts. */
export const commentNoText = (title, chatKey = '') => stack([
  toast(ICON.think, 'متن کامنت را ندادی'),
  compact([chatRow(title), idRow(chatKey)]),
  compact(commentUsageLines()),
  PLACEHOLDER_HINT,
]);

export const commentList = (entries) => {
  const list = Array.isArray(entries) ? entries : Object.entries(entries ?? {});
  if (!list.length) {
    return stack([
      toast(ICON.empty, 'هیچ کانالی کامنت اول ندارد.'),
      compact(commentUsageLines()),
    ]);
  }
  return stack([
    header(ICON.comment, `<b>کامنت اول (${list.length})</b>`),
    list
      .map(([key, value], index) => [
        `${index + 1}. <b>${esc(value?.title || key)}</b>`,
        `    \u251C ${code(key)}${value?.username ? ` ${MID} @${esc(value.username)}` : ''}`,
        `    \u251C ${quote(value?.text, 160)}`,
        `    \u2514 ${value?.sent ? `${value.sent} کامنت گذاشته شده` : 'هنوز کامنتی نگذاشته'}`,
      ].join('\n'))
      .join('\n'),
    compact([
      hint(`حذف: ${code(`${cmd('comment')} off <شناسه>`)}`),
      hint(`تغییر متن: همین دستور را با متن تازه دوباره بفرست.`),
    ]),
  ]);
};

/** Written into the archive the moment a comment lands. */
export const commentPostedCard = (info) => stack([
  header(ICON.comment, '<b>اولین کامنت گذاشته شد</b>', info.count ? `کامنت #${info.count}` : ''),
  compact([
    info.title ? chatRow(info.title) : '',
    info.at ? `${ICON.clock} <i>${esc(info.at)}</i>` : '',
  ]),
  quote(info.body, 400),
  info.link ? link(info.link, 'مشاهده پست') : '',
]);

/** And when it did not. `reason` is either `discussion` or a server message. */
export const commentFailedCard = (info) => stack([
  header(ICON.warn, '<b>کامنت اول گذاشته نشد</b>'),
  compact([
    info.title ? chatRow(info.title) : '',
    info.at ? `${ICON.clock} <i>${esc(info.at)}</i>` : '',
  ]),
  info.reason === 'discussion'
    ? compact([
      'گروه گفتگوی این کانال پیدا نشد.',
      `${BULLET} در تنطیمات کانال، Discussion را روشن کن.`,
      `${BULLET} مطمئن شو با همین اکانت به آن گروه دسترسی داری.`,
    ])
    : code(truncate(String(info.reason || 'خطای ناشناخته'), 200)),
  info.link ? link(info.link, 'مشاهده پست') : '',
]);

// -------------------------------------------------------------- mirror records

/** The live copy, written the moment a message lands. */
export const mirrorCard = (info) => stack([
  header(ICON.mirror, '<b>آینه</b>', 'نسخه اصلی ثبت شد'),
  compact([
    info.chatTitle ? chatRow(info.chatTitle) : '',
    info.senderName ? `${ICON.user} ${esc(info.senderName)}` : '',
    info.kind ? `${ICON.file} ${esc(info.kind)}` : '',
    info.date ? `${ICON.clock} <i>${esc(info.date)}</i>` : '',
  ]),
  quote(info.text),
  info.link ? link(info.link, 'مشاهده در چت') : '',
]);

/** Someone rewrote history; both versions go on the record. */
export const mirrorEditCard = (info) => stack([
  header(ICON.edit, '<b>پیام ویرایش شد</b>', info.revisions > 1 ? `ویرایش #${info.revisions}` : ''),
  compact([
    info.chatTitle ? chatRow(info.chatTitle) : '',
    info.senderName ? `${ICON.user} ${esc(info.senderName)}` : '',
    info.at ? `${ICON.clock} <i>${esc(info.at)}</i>` : '',
  ]),
  compact([
    `${ICON.old} <b>نسخه قبلی</b>`,
    quote(info.previous),
  ]),
  compact([
    `${ICON.now} <b>نسخه فعلی</b>`,
    quote(info.next),
  ]),
  info.revisions > 1 && info.original && info.original !== info.previous
    ? compact([`${ICON.first} <b>نسخه اول</b>`, quote(info.original)])
    : '',
  compact([
    `${ICON.shield} <i>نسخه اصلی همیشه بالاتر، در همین رشته، محفوظ است.</i>`,
    info.link ? link(info.link, 'مشاهده در چت') : '',
  ]),
]);

/** They hit "delete for everyone". Too late. */
export const mirrorDeleteCard = (info) => stack([
  header(ICON.trash, '<b>پیام پاک شد</b>', 'ولی نسخه‌اش پیش توست'),
  compact([
    info.chatTitle ? chatRow(info.chatTitle) : '',
    info.senderName ? `${ICON.user} ${esc(info.senderName)}` : '',
    info.date ? `${ICON.clock} زمان اصلی: <i>${esc(info.date)}</i>` : '',
    info.at ? `${ICON.boom} زمان حذف: <i>${esc(info.at)}</i>` : '',
    info.kind ? `${ICON.file} ${esc(info.kind)}` : '',
  ]),
  compact([`${ICON.page} <b>متن اصلی</b>`, quote(info.original ?? info.text)]),
  info.revisions
    ? compact([
      `${ICON.edit} <i>قبل از حذف ${info.revisions} بار ویرایش شده بود \u2014 آخرین نسخه:</i>`,
      quote(info.text),
    ])
    : '',
  `${ICON.ok} <i>نسخه آینه‌ای این پیام در آرشیو تو دست‌نخورده باقی می‌ماند.</i>`,
]);

// ------------------------------------------------------------------------ save

/** Usage lines shared by the "no target" and "bad link" cards. */
const SAVE_USAGE = [
  `${MARK} روی رسانه <b>ریپلای</b> کن و ${chip('save')} بفرست.`,
  `${MARK} یا لینک پست را جلوی دستور بگذار:`,
  code(`${cmd('save')} https://t.me/channel/1234`),
  code(`${cmd('save')} https://t.me/c/1234567890/1234`),
];

export const notReply = () => stack([
  toast(ICON.think, 'پیامی برای ذخیره پیدا نکردم.'),
  compact(SAVE_USAGE),
]);

export const linkError = (reason) => {
  if (reason === LINK_FAILURES.PEER) {
    return stack([
      toast(ICON.build, 'به این چت دسترسی ندارم.'),
      compact([
        'اگر کانال یا گروه خصوصی است، اول باید با همین اکانت عضوش باشی.',
        hint(`یک بار چت را در تلگرام باز کن تا شناخته شود، بعد دوباره ${chip('save')} بزن.`),
      ]),
    ]);
  }
  if (reason === LINK_FAILURES.MESSAGE) {
    return stack([
      toast(ICON.search, 'پیامی با این لینک پیدا نشد.'),
      'شماره پیام را دوباره چک کن؛ ممکن است پاک شده باشد.',
    ]);
  }
  return stack([
    toast(ICON.link, 'این یک لینک پیام تلگرام نیست.'),
    compact(SAVE_USAGE),
  ]);
};

export const noMedia = () => `${ICON.block} در این پیام رسانه‌ای برای آرشیو وجود ندارد.`;

export const queuedCard = ({ kind, size, pos, urgent }) => stack([
  header(ICON.queue, '<b>در صف آرشیو…</b>'),
  tree([
    kv('نوع', kind),
    size && size !== '0 B' ? kv('حجم', size) : '',
    kv('جایگاه در صف', String(pos)),
  ]),
  urgent ? `${ICON.bolt} <b>اولویت حداکثری — رسانه محوشونده!</b>` : '',
]);

export const progressCard = ({ stage, pct, kind, size, urgent }) => stack([
  header(ICON.box, '<b>در حال آرشیو</b>', stage === 'download' ? 'دانلود از منبع' : 'آپلود به آرشیو'),
  compact([
    `${stage === 'download' ? ICON.down : ICON.up} ${meter(pct, 14)}`,
    `${ICON.file} ${esc(kind)}${size && size !== '0 B' ? ` ${MID} ${ICON.disk} ${esc(size)}` : ''}`,
    urgent ? `${ICON.ttl} <i>رسانه محوشونده — با سرعت کامل!</i>` : '',
  ]),
]);

export const albumCard = (count, kind, size) => stack([
  header(ICON.album, '<b>در حال آرشیو آلبوم</b>'),
  tree([
    kv('تعداد', `${count} مورد`),
    kv('حجم کل', String(size)),
    kind ? kv('محتوا', kind) : '',
  ]),
]);

export const cancelCard = (dropped) => stack([
  header(dropped ? ICON.broom : ICON.info, dropped ? '<b>صف پاک شد</b>' : '<b>صف خالی بود</b>'),
  tree([
    kv('کارهای حذف‌شده', String(dropped)),
    'کارهای در حال اجرا متوقف نمی‌شوند.',
  ]),
]);

// Truncate raw text first, escape second — a blind cut can slice an entity.
export const errorCard = (message) => stack([
  header(ICON.no, '<b>آرشیو ناموفق بود</b>'),
  code(truncate(message || 'خطای ناشناخته', 300)),
]);

/** Kept for callers that only need the bare gauge (health checks, logs). */
export { gauge, block };
