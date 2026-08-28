import fs from 'node:fs';
import path from 'node:path';
import { log, errText } from './utils/logger.js';

const SCHEMA = 4;

/**
 * Chat-keyed feature buckets. They hold the same `{ title, since, username? }`
 * shape, so migration, toggling and listing are written once and reused.
 *   autoSave     — archive every media message of that chat
 *   mirror       — keep a live copy of every message of that chat
 *   firstComment — write the stored `text` as the first comment under every new
 *                  post of that channel (see services/comment.js)
 */
export const BUCKETS = Object.freeze(['autoSave', 'mirror', 'firstComment']);

const defaults = () => ({
  schema: SCHEMA,
  autoSave: {},
  mirror: {},
  firstComment: {},
  stats: { archived: 0, bytes: 0, failed: 0, comments: 0, since: Date.now() },
});

const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const handle = (value) => String(value ?? '').trim().replace(/^@+/, '');

/**
 * Flat JSON persistence: chat subscriptions plus counters. Writes are debounced
 * (a burst of archives is one write) and atomic (write to a temp file, then
 * rename) so a crash mid-write can never truncate the real file.
 */
export class Store {
  constructor(dataDir, { debounceMs = 500 } = {}) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'store.json');
    this.debounceMs = Math.max(0, Number(debounceMs) || 0);
    this.data = defaults();
    this._timer = null;
    this._dirty = false;
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      this.data = this._migrate(parsed);
    } catch (error) {
      // A corrupt store must not stop the service: start clean and keep a copy.
      log.error('[store] خواندن فایل ذخیره‌سازی ناموفق بود:', errText(error));
      this._quarantine();
      this.data = defaults();
    }
  }

  /** Normalizes one chat bucket, tolerating every shape older schemas wrote. */
  _chatMap(source) {
    const out = {};
    if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
    for (const [key, value] of Object.entries(source)) {
      if (!key) continue;
      if (value && typeof value === 'object') {
        const entry = { title: String(value.title ?? key), since: num(value.since, Date.now()) };
        // Optional and purely additive: it only lets `off @username` match an
        // entry whose chat can no longer be resolved.
        const username = handle(value.username);
        if (username) entry.username = username;
        // The first-comment body, and how many times it has been posted. Both
        // are per-bucket payload: an entry that never had them keeps not having
        // them instead of gaining an empty string.
        const text = String(value.text ?? '').trim();
        if (text) entry.text = text;
        const sent = num(value.sent);
        if (sent) entry.sent = sent;
        out[key] = entry;
      } else if (value) {
        // schema 1 stored a bare `true`.
        out[key] = { title: key, since: Date.now() };
      }
    }
    return out;
  }

  _migrate(parsed) {
    const base = defaults();
    const stats = parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : {};
    const migrated = {
      schema: SCHEMA,
      stats: {
        archived: num(stats.archived),
        bytes: num(stats.bytes),
        failed: num(stats.failed),
        comments: num(stats.comments),
        since: num(stats.since, base.stats.since),
      },
    };
    // schema <= 2 had no `mirror` key and schema <= 3 no `firstComment` one; an
    // absent bucket becomes an empty one.
    for (const bucket of BUCKETS) migrated[bucket] = this._chatMap(parsed[bucket]);
    return migrated;
  }

  _quarantine() {
    try {
      if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
    } catch {
      /* best effort */
    }
  }

  save() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, this.debounceMs);
    // Never keep the event loop alive just for a pending write.
    this._timer.unref?.();
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._dirty) return false;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
      this._dirty = false;
      return true;
    } catch (error) {
      log.error('[store] ذخیره‌سازی ناموفق بود:', errText(error));
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  // ------------------------------------------------------------------ buckets

  _bucket(name) {
    if (!this.data[name] || typeof this.data[name] !== 'object') this.data[name] = {};
    return this.data[name];
  }

  has(bucket, chatKey) {
    return Boolean(chatKey) && Boolean(this._bucket(bucket)[chatKey]);
  }

  /**
   * `username` is optional metadata: it is what makes `off @channel` work after
   * the chat itself became unreachable. An existing one is never lost.
   *
   * `extra` is the bucket's own payload (the first-comment body). Anything the
   * entry already carries survives a plain re-toggle — only an explicit `extra`
   * replaces it — so turning a feature off and on again cannot silently wipe a
   * message the user typed once.
   *
   * @returns false when nothing changed (unknown key, or already in that state).
   */
  toggle(bucket, chatKey, title, on, username = '', extra = null) {
    if (!chatKey) return false;
    const map = this._bucket(bucket);
    if (on) {
      const existing = map[chatKey];
      const name = handle(username) || handle(existing?.username);
      const extras = extra && typeof extra === 'object' ? extra : {};
      map[chatKey] = {
        title: String(title || chatKey),
        since: existing ? existing.since : Date.now(),
        ...(name ? { username: name } : {}),
        ...(existing?.text ? { text: existing.text } : {}),
        ...(existing?.sent ? { sent: existing.sent } : {}),
        ...extras,
      };
    } else if (!map[chatKey]) {
      return false;
    } else {
      delete map[chatKey];
    }
    this.save();
    return true;
  }

  entries(bucket) {
    return Object.entries(this._bucket(bucket));
  }

  /**
   * One entry, or null.
   *
   * The panel routes on a chat *key* — that is all 64 bytes of callback data can
   * carry — and still has to draw a title, so it needs to look one up cheaply.
   */
  entry(bucket, chatKey) {
    if (!chatKey) return null;
    return this._bucket(bucket)[chatKey] ?? null;
  }

  count(bucket) {
    return Object.keys(this._bucket(bucket)).length;
  }

  isAuto(chatKey) {
    return this.has('autoSave', chatKey);
  }

  setAuto(chatKey, title, on, username = '') {
    return this.toggle('autoSave', chatKey, title, on, username);
  }

  autoEntries() {
    return this.entries('autoSave');
  }

  get autoCount() {
    return this.count('autoSave');
  }

  isMirror(chatKey) {
    return this.has('mirror', chatKey);
  }

  setMirror(chatKey, title, on, username = '') {
    return this.toggle('mirror', chatKey, title, on, username);
  }

  mirrorEntries() {
    return this.entries('mirror');
  }

  get mirrorCount() {
    return this.count('mirror');
  }

  // ------------------------------------------------------------- first comment

  isFirstComment(chatKey) {
    return this.has('firstComment', chatKey);
  }

  /**
   * `text` is the comment body. An empty one keeps whatever was stored before,
   * which is what makes `.comment @channel` (no text) a re-enable rather than a
   * way to lose the message.
   */
  setFirstComment(chatKey, title, on, username = '', text = '') {
    const body = String(text ?? '').trim();
    return this.toggle('firstComment', chatKey, title, on, username, body ? { text: body } : null);
  }

  firstCommentEntry(chatKey) {
    return this.entry('firstComment', chatKey);
  }

  firstCommentEntries() {
    return this.entries('firstComment');
  }

  get firstCommentCount() {
    return this.count('firstComment');
  }

  /** The stored body, or '' when the channel is not configured at all. */
  commentText(chatKey) {
    return String(this.firstCommentEntry(chatKey)?.text ?? '');
  }

  /** One more comment posted on that channel. @returns its new per-chat count. */
  countComment(chatKey) {
    this.data.stats.comments = num(this.data.stats.comments) + 1;
    const entry = this._bucket('firstComment')[chatKey];
    if (entry) entry.sent = num(entry.sent) + 1;
    this.save();
    return entry ? entry.sent : 0;
  }

  /** Either feature is reason enough to keep a chat's media. */
  isWatched(chatKey) {
    return this.isAuto(chatKey) || this.isMirror(chatKey);
  }

  // -------------------------------------------------------------------- stats

  countArchive(bytes, count = 1) {
    this.data.stats.archived += Math.max(0, Math.floor(num(count, 1)));
    this.data.stats.bytes += Math.max(0, num(bytes));
    this.save();
  }

  countFailure(count = 1) {
    this.data.stats.failed += Math.max(1, Math.floor(num(count, 1)));
    this.save();
  }
}
