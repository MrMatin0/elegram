/**
 * The glass control panel.
 *
 * Every screen is a pure function of a snapshot: `(view) => { text, keyboard }`.
 * No client, no store, no clock — the controller (`handlers/panel.js`) collects
 * the numbers, this file decides what they look like. That split is what makes
 * the whole panel testable without a Telegram connection, and it is why a screen
 * can never accidentally mutate state while rendering.
 *
 * Layout rules, so twelve screens stay one product:
 *   • one title bar, always `header()`
 *   • a one-line status strip under it, when there is something live to say
 *   • sections in a fixed order: what it is → what it is doing → what you can do
 *   • the keyboard mirrors the sections, top to bottom, two columns
 *   • the last row is always navigation: back, refresh, close
 */
import { cmd } from '../constants.js';
import { esc, humanBytes, humanDuration, truncate } from '../utils/format.js';
import {
  BRAND, BULLET, ICON, MID,
  code, compact, header, hint, kv, kvRaw, meter, pill, quote, ratio, section, stack, toast, tree,
} from './theme.js';
import {
  ACTION, SCREEN,
  backBtn, btn, closeBtn, confirmRow, grid, keyboard, pager, paginate, refreshBtn, row, toggleBtn,
} from './glass.js';

/** Rows per page. Six keeps the keyboard thumb-sized on a phone. */
export const PAGE_SIZE = 6;
const LABEL_LIMIT = 26;

const BUCKETS = Object.freeze({
  [SCREEN.AUTO]: { key: 'auto', icon: ICON.auto, title: 'سیو خودکار', empty: 'هنوز چتی برای سیو خودکار انتخاب نشده.' },
  [SCREEN.MIRROR]: { key: 'mirror', icon: ICON.mirror, title: 'آینه', empty: 'هنوز هیچ چتی آینه نشده.' },
});

export const bucketOf = (screen) => BUCKETS[screen] ?? BUCKETS[SCREEN.AUTO];

const entriesOf = (view, screen) => view[bucketOf(screen).key] ?? [];

/** A notice is the panel's toast: it leads the card, then disappears on refresh. */
const noticeLine = (notice) => (notice?.text ? toast(notice.icon || ICON.info, notice.text) : '');

const label = (text) => truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), LABEL_LIMIT);

const sinceRow = (entry) => {
  const since = Number(entry?.since) || 0;
  return since ? kv('از', `${humanDuration(Date.now() - since)} پیش`) : '';
};

// ------------------------------------------------------------------------- home

export function home(view) {
  const { system = {}, archive = {}, queue = {}, mirrorStats = {} } = view;
  const autos = entriesOf(view, SCREEN.AUTO).length;
  const mirrors = entriesOf(view, SCREEN.MIRROR).length;
  const comments = (view.comment ?? []).length;

  const text = stack([
    header(ICON.panel, BRAND, 'پنل کنترل'),
    compact([
      noticeLine(view.notice),
      `${pill(Boolean(system.socket), 'متصل', 'قطع')} ${MID} ${ICON.time} ${esc(humanDuration(system.uptime))}`,
    ]),
    compact([
      section(ICON.archive, 'آرشیو'),
      tree([
        kv('ذخیره‌شده', String(archive.archived ?? 0)),
        kv('حجم کل', humanBytes(archive.bytes)),
        archive.failed ? kv('ناموفق', String(archive.failed)) : '',
        kvRaw('مقصد', code(system.dest || 'me')),
      ]),
    ]),
    compact([
      section(ICON.queue, 'صف'),
      tree([
        kvRaw('بار کارگرها', ratio(queue.running, queue.concurrency, 10)),
        kv('در انتطار', String(queue.pending ?? 0)),
        kv('در حال پردازش', String(queue.running ?? 0)),
      ]),
    ]),
    compact([
      section(ICON.target, 'رهگیری'),
      tree([
        kv('سیو خودکار', `${autos} چت`),
        kv('آینه', `${mirrors} چت`),
        kv('پیام‌های آینه‌شده', String(mirrorStats.captured ?? 0)),
        kv('کامنت اول', `${comments} کانال`),
      ]),
    ]),
    hint('هر دکمه یک صفحه است؛ هیچ چیزی بدون تأیید حذف نمی‌شود.'),
  ]);

  return {
    text,
    keyboard: keyboard(
      row(
        btn(`${ICON.auto} سیو خودکار (${autos})`, [SCREEN.AUTO, ACTION.OPEN]),
        btn(`${ICON.mirror} آینه (${mirrors})`, [SCREEN.MIRROR, ACTION.OPEN]),
      ),
      row(
        btn(`${ICON.comment} کامنت اول (${comments})`, [SCREEN.COMMENT, ACTION.OPEN]),
        btn(`${ICON.queue} صف (${queue.pending ?? 0})`, [SCREEN.QUEUE, ACTION.OPEN]),
      ),
      row(
        btn(`${ICON.stats} آمار`, [SCREEN.STATS, ACTION.OPEN]),
        btn(`${ICON.tools} ابزارها`, [SCREEN.TOOLS, ACTION.OPEN]),
      ),
      row(
        btn(`${ICON.settings} تنطیمات`, [SCREEN.SETTINGS, ACTION.OPEN]),
        btn(`${ICON.help} راهنما`, [SCREEN.HELP, ACTION.OPEN]),
      ),
      row(refreshBtn([SCREEN.HOME, ACTION.REFRESH]), closeBtn()),
    ),
  };
}

// ------------------------------------------------------------------ chat lists

/** The auto-save and mirror lists are the same screen over a different bucket. */
export function chats(view, screen) {
  const spec = bucketOf(screen);
  const list = entriesOf(view, screen);
  const { slice, page, pages, start, total } = paginate(list, view.page, PAGE_SIZE);

  const body = total
    ? slice
      .map(([key, entry], index) => compact([
        `${start + index + 1}. <b>${esc(entry?.title || key)}</b>`,
        tree([
          kvRaw('شناسه', code(key)),
          entry?.username ? kvRaw('یوزرنیم', code(`@${entry.username}`)) : '',
          sinceRow(entry),
        ]),
      ]))
      .join('\n')
    : compact([
      toast(ICON.empty, spec.empty),
      hint(`با دکمه «افزودن» یک یوزرنیم، شناسه یا لینک بده — یا داخل خود چت ${code(cmd(`${spec.key === 'auto' ? 'auto' : 'mirror'} on`))} را بفرست.`),
    ]);

  const text = stack([
    header(spec.icon, `<b>${esc(spec.title)}</b>`, total ? `${total} چت` : 'خالی'),
    noticeLine(view.notice),
    body,
    total > PAGE_SIZE ? hint(`صفحه ${page + 1} از ${pages}`) : '',
  ]);

  return {
    text,
    keyboard: keyboard(
      ...grid(
        slice.map(([key, entry]) => btn(`${ICON.chat} ${label(entry?.title || key)}`, [SCREEN.CHAT, ACTION.OPEN, screen, key])),
        1,
      ).map((line) => line),
      pager(screen, page, pages),
      row(
        btn(`\u2795 افزودن چت`, [screen, ACTION.PROMPT]),
        refreshBtn([screen, ACTION.REFRESH]),
      ),
      row(backBtn()),
    ),
  };
}

// --------------------------------------------------------------- first comment

/**
 * The first-comment list.
 *
 * Its own screen rather than a third bucket in `chats()`: every row carries a
 * *body*, which is the whole point of the feature and the one thing the other
 * two lists never have to show. Adding and editing are the same prompt — a
 * channel that is already in the list simply gets its text replaced.
 */
export function comments(view) {
  const list = view.comment ?? [];
  const stats = view.commentStats ?? {};
  const { slice, page, pages, start, total } = paginate(list, view.page, PAGE_SIZE);
  const dropping = view.confirm?.kind === 'comment' ? view.confirm.key : '';

  const body = total
    ? slice
      .map(([key, entry], index) => compact([
        `${start + index + 1}. <b>${esc(entry?.title || key)}</b>`,
        tree([
          kvRaw('شناسه', code(key)),
          entry?.username ? kvRaw('یوزرنیم', code(`@${entry.username}`)) : '',
          kv('کامنت گذاشته', entry?.sent ? `${entry.sent} بار` : 'هنوز هیچ'),
        ]),
        quote(entry?.text, 160),
      ]))
      .join('\n')
    : compact([
      toast(ICON.empty, 'هنوز کانالی کامنت اول ندارد.'),
      hint(`با دکمه «افزودن کانال»، یا از اکانت خودت: ${code(`${cmd('comment')} @channel | متن`)}`),
    ]);

  const text = stack([
    header(ICON.comment, '<b>کامنت اول</b>', total ? `${total} کانال` : 'خالی'),
    noticeLine(view.notice),
    body,
    total
      ? tree([
        kv('گذاشته‌شده', String(stats.posted ?? 0)),
        stats.failed ? kv('ناموفق', String(stats.failed)) : '',
      ])
      : '',
    dropping
      ? toast(ICON.warn, 'کامنت اول این کانال خاموش شود؟')
      : hint('برای عوض کردن متن، همان کانال را با متن تازه دوباره اضافه کن.'),
  ]);

  const keys = dropping
    ? keyboard(
      confirmRow('بله، خاموش کن', [SCREEN.COMMENT, ACTION.CONFIRM, dropping], [SCREEN.COMMENT, ACTION.OPEN]),
      row(backBtn()),
    )
    : keyboard(
      ...grid(
        slice.map(([key, entry]) => btn(`${ICON.trash} ${label(entry?.title || key)}`, [SCREEN.COMMENT, ACTION.DROP, key])),
        1,
      ).map((line) => line),
      pager(SCREEN.COMMENT, page, pages),
      row(
        btn(`\u2795 افزودن کانال`, [SCREEN.COMMENT, ACTION.PROMPT]),
        refreshBtn([SCREEN.COMMENT, ACTION.REFRESH]),
      ),
      row(backBtn()),
    );

  return { text, keyboard: keys };
}

// ------------------------------------------------------------------ chat detail

export function chat(view) {
  const { chat: target } = view;
  if (!target?.key) {
    return {
      text: stack([
        header(ICON.chat, '<b>چت پیدا نشد</b>'),
        'این چت دیگر در لیست نیست — شاید از جای دیگری حذفش کرده‌ای.',
      ]),
      keyboard: keyboard(row(backBtn([view.from ?? SCREEN.HOME, ACTION.OPEN]))),
    };
  }

  const from = view.from ?? SCREEN.AUTO;
  const { key, entry, auto, mirror, comment } = target;

  const text = stack([
    header(ICON.chat, `<b>${esc(entry?.title || key)}</b>`),
    noticeLine(view.notice),
    tree([
      kvRaw('شناسه', code(key)),
      entry?.username ? kvRaw('یوزرنیم', code(`@${entry.username}`)) : '',
      sinceRow(entry),
    ]),
    compact([
      section(ICON.target, 'وضعیت'),
      tree([
        kvRaw('سیو خودکار', pill(auto)),
        kvRaw('آینه', pill(mirror)),
        kvRaw('کامنت اول', pill(Boolean(comment))),
      ]),
    ]),
    view.confirm?.kind === 'drop'
      ? toast(ICON.warn, 'حذف از همه‌ی لیست‌ها؟ آرشیو موجود دست‌نخورده می‌ماند.')
      : hint('آینه، رسانه‌های همان چت را هم خودکار آرشیو می‌کند.'),
  ]);

  const keys = view.confirm?.kind === 'drop'
    ? keyboard(
      confirmRow('بله، حذف کن', [SCREEN.CHAT, ACTION.CONFIRM, from, key], [SCREEN.CHAT, ACTION.OPEN, from, key]),
      row(backBtn([from, ACTION.OPEN])),
    )
    : keyboard(
      row(
        toggleBtn('سیو خودکار', auto, [SCREEN.CHAT, ACTION.TOGGLE, SCREEN.AUTO, key]),
        toggleBtn('آینه', mirror, [SCREEN.CHAT, ACTION.TOGGLE, SCREEN.MIRROR, key]),
      ),
      comment ? row(btn(`${ICON.comment} کامنت اول این کانال`, [SCREEN.COMMENT, ACTION.OPEN])) : null,
      row(btn(`${ICON.trash} حذف از لیست‌ها`, [SCREEN.CHAT, ACTION.DROP, from, key])),
      row(
        backBtn([from, ACTION.OPEN]),
        refreshBtn([SCREEN.CHAT, ACTION.REFRESH, from, key]),
      ),
    );

  return { text, keyboard: keys };
}

// ------------------------------------------------------------------------ queue

export function queue(view) {
  const q = view.queue ?? {};
  const total = (q.completed ?? 0) + (q.failed ?? 0);

  const text = stack([
    header(ICON.queue, '<b>صف آرشیو</b>', q.pending ? `${q.pending} در انتطار` : 'خالی'),
    noticeLine(view.notice),
    compact([
      section(ICON.box, 'همین حالا'),
      tree([
        kvRaw('بار کارگرها', ratio(q.running, q.concurrency, 10)),
        kv('در انتطار', String(q.pending ?? 0)),
        kv('در حال پردازش', `${q.running ?? 0} از ${q.concurrency ?? 1}`),
      ]),
    ]),
    compact([
      section(ICON.stats, 'از زمان اجرا'),
      tree([
        kv('انجام‌شده', String(q.completed ?? 0)),
        kv('ناموفق', String(q.failed ?? 0)),
        total ? kvRaw('نرخ موفقیت', meter(((q.completed ?? 0) / total) * 100, 10)) : '',
      ]),
    ]),
    view.confirm?.kind === 'clear'
      ? toast(ICON.warn, 'کارهای در انتطار حذف می‌شوند. کاری که در حال اجراست ادامه پیدا می‌کند.')
      : hint('رسانه محوشونده همیشه از بقیه صف جلو می‌زند.'),
  ]);

  const keys = view.confirm?.kind === 'clear'
    ? keyboard(
      confirmRow('بله، صف را پاک کن', [SCREEN.QUEUE, ACTION.CONFIRM], [SCREEN.QUEUE, ACTION.OPEN]),
      row(backBtn()),
    )
    : keyboard(
      row(
        q.pending ? btn(`${ICON.broom} پاک کردن صف`, [SCREEN.QUEUE, ACTION.DROP]) : null,
        refreshBtn([SCREEN.QUEUE, ACTION.REFRESH]),
      ),
      row(backBtn()),
    );

  return { text, keyboard: keys };
}

// ------------------------------------------------------------------------ stats

export function stats(view) {
  const { system = {}, archive = {}, queue: q = {}, mirrorStats = {}, commentStats = {} } = view;
  const attempts = (archive.archived ?? 0) + (archive.failed ?? 0);
  const average = archive.archived ? (archive.bytes ?? 0) / archive.archived : 0;

  const text = stack([
    header(ICON.stats, '<b>آمار</b>', archive.since ? `از ${humanDuration(Date.now() - archive.since)} پیش` : ''),
    noticeLine(view.notice),
    compact([
      section(ICON.archive, 'آرشیو'),
      tree([
        kv('فایل‌ها', String(archive.archived ?? 0)),
        kv('حجم کل', humanBytes(archive.bytes)),
        kv('میانگین هر فایل', humanBytes(average)),
        attempts ? kvRaw('نرخ موفقیت', meter(((archive.archived ?? 0) / attempts) * 100, 10)) : '',
      ]),
    ]),
    compact([
      section(ICON.mirror, 'آینه'),
      tree([
        kv('پیام‌های ثبت‌شده', String(mirrorStats.captured ?? 0)),
        kv('ویرایش', String(mirrorStats.edits ?? 0)),
        kv('حذف', String(mirrorStats.deletions ?? 0)),
      ]),
    ]),
    compact([
      section(ICON.comment, 'کامنت اول'),
      tree([
        kv('کانال‌های فعال', String((view.comment ?? []).length)),
        kv('گذاشته‌شده', String(commentStats.posted ?? 0)),
        commentStats.failed ? kv('ناموفق', String(commentStats.failed)) : '',
      ]),
    ]),
    compact([
      section(ICON.system, 'سیستم'),
      tree([
        kv('آپ‌تایم', humanDuration(system.uptime)),
        kv('رم مصرفی', humanBytes(system.rss)),
        kv('نسخه', `Elegram ${system.version ?? ''} ${MID} Node ${system.node ?? ''}`),
        kvRaw('سوکت', pill(Boolean(system.socket), 'متصل', 'قطع')),
      ]),
    ]),
  ]);

  return {
    text,
    keyboard: keyboard(
      row(refreshBtn([SCREEN.STATS, ACTION.REFRESH]), btn(`${ICON.queue} صف`, [SCREEN.QUEUE, ACTION.OPEN])),
      row(backBtn()),
    ),
  };
}

// --------------------------------------------------------------------- settings

export function settings(view) {
  const s = view.settings ?? {};

  const text = stack([
    header(ICON.settings, '<b>تنطیمات</b>', 'قابل تغییر در همین لحظه'),
    noticeLine(view.notice),
    compact([
      section(ICON.bolt, 'زنده'),
      tree([
        kv('همزمانی آرشیو', String(s.concurrency ?? 1)),
        kvRaw('ری‌اکشن پس از ذخیره', s.doneReaction ? `${esc(s.doneReaction)} ${pill(true)}` : pill(false)),
        kvRaw('سطح لاگ', code(s.logLevel ?? 'info')),
      ]),
    ]),
    compact([
      section(ICON.system, 'ثابت (از فایل محیطی)'),
      tree([
        kvRaw('مقصد آرشیو', code(s.storagePeer || 'me')),
        kv('کارگر آپلود', String(s.uploadWorkers ?? 0)),
        kv('دانلود همزمان', String(s.maxConcurrentDownloads ?? 0)),
        kv('پنجره آلبوم', `${s.albumWindowMs ?? 0} ms`),
        kv('تأخیر کامنت اول', `${s.firstCommentDelayMs ?? 0} ms`),
        kv('منطقه زمانی', s.timezone ?? ''),
        kvRaw('بازیابی پس از ری‌استارت', pill(Boolean(s.catchUp))),
      ]),
    ]),
    hint('تغییرهای «زنده» فقط تا ری‌استارت بعدی می‌مانند؛ برای همیشگی‌شدن در فایل محیطی بنویسشان.'),
  ]);

  return {
    text,
    keyboard: keyboard(
      row(
        btn('\u2796 همزمانی', [SCREEN.SETTINGS, ACTION.BUMP, '-']),
        btn(`${s.concurrency ?? 1}`, [SCREEN.NOOP, ACTION.OPEN]),
        btn('\u2795 همزمانی', [SCREEN.SETTINGS, ACTION.BUMP, '+']),
      ),
      row(
        toggleBtn('ری‌اکشن', Boolean(s.doneReaction), [SCREEN.SETTINGS, ACTION.TOGGLE, 'r']),
        btn(`\u{1FAB5} لاگ: ${s.logLevel ?? 'info'}`, [SCREEN.SETTINGS, ACTION.SET, 'l']),
      ),
      row(backBtn(), refreshBtn([SCREEN.SETTINGS, ACTION.REFRESH])),
    ),
  };
}

// ------------------------------------------------------------------------ tools

export function tools(view) {
  const text = stack([
    header(ICON.tools, '<b>ابزارها</b>'),
    noticeLine(view.notice),
    compact([
      section(ICON.link, 'ذخیره با لینک'),
      `${BULLET} لینک هر پست را بده تا رسانه‌اش (حتی ضدفوروارد) آرشیو شود.`,
      `${BULLET} آلبوم را کامل برمی‌دارد، نه فقط یک عکس.`,
    ]),
    compact([
      section(ICON.target, 'افزودن چت'),
      `${BULLET} یوزرنیم، شناسه عددی یا لینک چت را بده.`,
      `${BULLET} برای کانالی که در آن نمی‌شود نوشت، این تنها راه است.`,
    ]),
    compact([
      section(ICON.comment, 'کامنت اول'),
      `${BULLET} خط اول کانال، خط‌های بعد متن کامنت.`,
      `${BULLET} به محض انتشار پست جدید، همان متن اولین کامنت می‌شود.`,
    ]),
    hint(`همین کارها از سمت اکانت خودت هم ممکن است: ${code(cmd('save'))} ${MID} ${code(cmd('mirror'))} ${MID} ${code(cmd('auto'))} ${MID} ${code(cmd('comment'))}`),
  ]);

  return {
    text,
    keyboard: keyboard(
      row(btn(`${ICON.link} ذخیره با لینک`, [SCREEN.TOOLS, ACTION.PROMPT, 's'])),
      row(
        btn(`${ICON.mirror} افزودن آینه`, [SCREEN.TOOLS, ACTION.PROMPT, 'm']),
        btn(`${ICON.auto} افزودن سیو خودکار`, [SCREEN.TOOLS, ACTION.PROMPT, 'a']),
      ),
      row(btn(`${ICON.comment} تنظیم کامنت اول`, [SCREEN.TOOLS, ACTION.PROMPT, 'f'])),
      row(backBtn()),
    ),
  };
}

// ----------------------------------------------------------------------- prompt

const PROMPTS = Object.freeze({
  save: {
    icon: ICON.link,
    title: 'لینک پست را بفرست',
    lines: [
      `${BULLET} ${code('https://t.me/channel/1234')}`,
      `${BULLET} ${code('https://t.me/c/1234567890/1234')}`,
    ],
    note: 'باید با همین اکانت به آن چت دسترسی داشته باشی.',
  },
  mirror: {
    icon: ICON.mirror,
    title: 'چت را برای آینه بفرست',
    lines: [
      `${BULLET} ${code('@channel')}`,
      `${BULLET} ${code('-1001234567890')}`,
      `${BULLET} ${code('https://t.me/channel')}`,
    ],
    note: 'از این پس هر پیام، ویرایش و حذف آن چت ثبت می‌شود.',
  },
  auto: {
    icon: ICON.auto,
    title: 'چت را برای سیو خودکار بفرست',
    lines: [
      `${BULLET} ${code('@channel')}`,
      `${BULLET} ${code('-1001234567890')}`,
      `${BULLET} ${code('https://t.me/channel')}`,
    ],
    note: 'هر رسانه‌ای که در آن چت بیاید خودکار آرشیو می‌شود.',
  },
  comment: {
    icon: ICON.comment,
    title: 'کانال و متن کامنت را بفرست',
    lines: [
      `${BULLET} خط اول: ${code('@channel')} یا ${code('-1001234567890')}`,
      `${BULLET} خط‌های بعد: متن کامنت`,
      `${BULLET} یک‌خطی هم می‌شود: ${code('@channel | متن کامنت')}`,
      `${BULLET} در متن: ${code('{title}')} ${code('{link}')} ${code('{id}')} ${code('{date}')}`,
    ],
    note: 'کانال باید گروه گفتگو داشته باشد؛ کانالی که از قبل در لیست باشد، متنش عوض می‌شود.',
  },
});

export function prompt(view) {
  const spec = PROMPTS[view.awaiting] ?? PROMPTS.auto;
  const text = stack([
    header(spec.icon, `<b>${esc(spec.title)}</b>`, 'در انتطار پیام تو'),
    noticeLine(view.notice),
    compact(spec.lines),
    hint(spec.note),
  ]);
  return {
    text,
    keyboard: keyboard(row(btn('\u2716\uFE0F انصراف', [SCREEN.TOOLS, ACTION.CANCEL]))),
  };
}

// ------------------------------------------------------------------------- help

export function help(view) {
  const text = stack([
    header(ICON.help, '<b>راهنما</b>', 'پنل و اکانت، کنار هم'),
    noticeLine(view.notice),
    compact([
      section(ICON.panel, 'این پنل'),
      `${BULLET} دکمه‌های شیشه‌ای فقط از سمت ربات ساخته می‌شوند؛ اکانت‌ها اجازه‌اش را ندارند.`,
      `${BULLET} پس این ربات فقط «صفحه‌نمایش» است و همه‌ی کار با اکانت خودت انجام می‌شود.`,
      `${BULLET} فقط مالک پنل می‌تواند از آن استفاده کند؛ بقیه جواب نمی‌گیرند.`,
    ]),
    compact([
      section(ICON.game, 'دستورهای اکانت'),
      `${BULLET} ${code(cmd('save'))} روی رسانه ریپلای کن — یا لینک پست را بده.`,
      `${BULLET} ${code(cmd('mirror'))} و ${code(cmd('auto'))} برای روشن و خاموش کردن چت‌ها.`,
      `${BULLET} ${code(cmd('comment'))} برای اولین کامنت پست‌های یک کانال.`,
      `${BULLET} ${code(cmd('status'))} همان اعدادی است که در این پنل می‌بینی.`,
      `${BULLET} ${code(cmd('panel'))} همین پنل را باز می‌کند.`,
    ]),
    compact([
      section(ICON.shield, 'خوب است بدانی'),
      `${BULLET} حذف‌ها همیشه تأیید دومرحله‌ای دارند.`,
      `${BULLET} خاموش کردن آینه، آرشیوِ ثبت‌شده را پاک نمی‌کند.`,
      `${BULLET} رسانه محوشونده بی‌قید‌و‌شرط و با اولویت کامل ذخیره می‌شود.`,
    ]),
  ]);
  return {
    text,
    keyboard: keyboard(row(btn(`${ICON.tools} ابزارها`, [SCREEN.TOOLS, ACTION.OPEN]), backBtn())),
  };
}

// --------------------------------------------------------------------- dispatch

const SCREENS = Object.freeze({
  [SCREEN.HOME]: home,
  [SCREEN.AUTO]: (view) => chats(view, SCREEN.AUTO),
  [SCREEN.MIRROR]: (view) => chats(view, SCREEN.MIRROR),
  [SCREEN.COMMENT]: comments,
  [SCREEN.CHAT]: chat,
  [SCREEN.QUEUE]: queue,
  [SCREEN.STATS]: stats,
  [SCREEN.SETTINGS]: settings,
  [SCREEN.TOOLS]: tools,
  [SCREEN.HELP]: help,
});

/** One entry point: give it a view, get the exact message to send or edit. */
export function render(view) {
  if (view?.awaiting) return prompt(view);
  const draw = SCREENS[view?.screen] ?? home;
  return draw(view);
}
