import fs from 'node:fs';
import path from 'node:path';
import { log, errText } from './utils/logger.js';

const SCHEMA = 4;

/**
 * How many `source → archived copy` pairs are kept on disk.
 *
 * The map exists so an edit or a delete that lands *after* a restart can still
 * be reported as a reply to the right archived message. It is bounded because a
 * mirrored group is an unbounded stream: the oldest pairs are dropped first.
 */
const MIRROR_MAP_LIMIT = 5000;

/** The one chat-keyed feature bucket: `{ title, since }` per mirrored chat. */
export const BUCKETS = Object.freeze(['mirror']);

const defaults = () => ({
  schema: SCHEMA,
  mirror: {},
  mirrorMap: {},
  stats: { archived: 0, bytes: 0, failed: 0, since: Date.now() },
});

const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * Flat JSON persistence: chat subscriptions, the mirror map and counters.
 * Writes are debounced (a burst of archives is one write) and atomic (write to a
 * temp file, then rename) so a crash mid-write can never truncate the real file.
 */
export class Store {
  constructor(dataDir, { debounceMs = 500, mirrorMapLimit = MIRROR_MAP_LIMIT } = {}) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'store.json');
    this.debounceMs = Math.max(0, Number(debounceMs) || 0);
    this.mirrorMapLimit = Math.max(1, Number(mirrorMapLimit) || MIRROR_MAP_LIMIT);
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
        out[key] = { title: String(value.title ?? key), since: num(value.since, Date.now()) };
      } else if (value) {
        // schema 1 stored a bare `true`.
        out[key] = { title: key, since: Date.now() };
      }
    }
    return out;
  }

  /** `{ "<chatKey>|<messageId>": savedMessageId }`, junk dropped. */
  _mirrorMap(source) {
    const out = {};
    if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
    const entries = Object.entries(source).filter(([key, value]) => key.includes('|') && num(value) > 0);
    // Keep the newest tail if an older file grew past the current limit.
    for (const [key, value] of entries.slice(-this.mirrorMapLimit)) out[key] = num(value);
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
        since: num(stats.since, base.stats.since),
      },
      mirrorMap: this._mirrorMap(parsed.mirrorMap),
    };
    for (const bucket of BUCKETS) migrated[bucket] = this._chatMap(parsed[bucket]);

    // schema <= 3 had a second bucket, `autoSave`, for "archive this chat's
    // media". `.mirror` now covers that and more, so an old auto-save
    // subscription is carried over instead of silently dropped.
    for (const [key, value] of Object.entries(this._chatMap(parsed.autoSave))) {
      const existing = migrated.mirror[key];
      migrated.mirror[key] = existing
        ? { title: existing.title, since: Math.min(existing.since, value.since) }
        : value;
    }
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

  /** @returns false when nothing changed (unknown key, or already in that state). */
  toggle(bucket, chatKey, title, on) {
    if (!chatKey) return false;
    const map = this._bucket(bucket);
    if (on) {
      const existing = map[chatKey];
      map[chatKey] = {
        title: String(title || chatKey),
        since: existing ? existing.since : Date.now(),
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

  count(bucket) {
    return Object.keys(this._bucket(bucket)).length;
  }

  isMirror(chatKey) {
    return this.has('mirror', chatKey);
  }

  setMirror(chatKey, title, on) {
    return this.toggle('mirror', chatKey, title, on);
  }

  mirrorEntries() {
    return this.entries('mirror');
  }

  get mirrorCount() {
    return this.count('mirror');
  }

  // --------------------------------------------------------------- mirror map

  /**
   * `source_chat_id + source_message_id → saved_message_id`.
   *
   * The key carries a `|`, so V8 never treats it as an array index and the
   * object keeps insertion order — which is what makes the eviction below
   * "oldest first" rather than "whatever comes out of the hash".
   */
  static mirrorKey(chatKey, messageId) {
    const id = Number(messageId);
    if (!chatKey || !Number.isFinite(id) || id <= 0) return '';
    return `${chatKey}|${id}`;
  }

  _mirrorPairs() {
    if (!this.data.mirrorMap || typeof this.data.mirrorMap !== 'object') this.data.mirrorMap = {};
    return this.data.mirrorMap;
  }

  rememberMirror(chatKey, messageId, savedMessageId) {
    const key = Store.mirrorKey(chatKey, messageId);
    const saved = num(savedMessageId);
    if (!key || saved <= 0) return false;
    const map = this._mirrorPairs();
    // Re-inserting has to delete first, or the pair keeps its original (old)
    // position and gets evicted while newer, less useful pairs survive.
    delete map[key];
    map[key] = saved;
    const keys = Object.keys(map);
    for (let index = 0; index < keys.length - this.mirrorMapLimit; index += 1) delete map[keys[index]];
    this.save();
    return true;
  }

  savedIdFor(chatKey, messageId) {
    const key = Store.mirrorKey(chatKey, messageId);
    if (!key) return 0;
    return num(this._mirrorPairs()[key]);
  }

  /**
   * `updateDeleteMessages` carries no peer for users and basic groups, so the
   * only thing we get is a bare message id. Message ids are unique per account
   * in exactly those chats, which makes a scan by suffix a correct fallback.
   * @returns {{chatKey: string, id: number, savedId: number}|null}
   */
  findMirrorById(messageId) {
    const id = Number(messageId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const suffix = `|${id}`;
    const map = this._mirrorPairs();
    const keys = Object.keys(map);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (!key.endsWith(suffix)) continue;
      const savedId = num(map[key]);
      if (savedId > 0) return { chatKey: key.slice(0, -suffix.length), id, savedId };
    }
    return null;
  }

  forgetMirror(chatKey, messageId) {
    const key = Store.mirrorKey(chatKey, messageId);
    if (!key) return false;
    const map = this._mirrorPairs();
    if (!(key in map)) return false;
    delete map[key];
    this.save();
    return true;
  }

  get mirrorMapSize() {
    return Object.keys(this._mirrorPairs()).length;
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
