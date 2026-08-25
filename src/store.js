import fs from 'node:fs';
import path from 'node:path';
import { log, errText } from './utils/logger.js';

const SCHEMA = 2;

const defaults = () => ({
  schema: SCHEMA,
  autoSave: {},
  stats: { archived: 0, bytes: 0, failed: 0, since: Date.now() },
});

const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * Flat JSON persistence: auto-save subscriptions plus counters. Writes are
 * debounced (a burst of archives is one write) and atomic (write to a temp file,
 * then rename) so a crash mid-write can never truncate the real file.
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

  _migrate(parsed) {
    const base = defaults();
    const autoSave = {};
    const source = parsed.autoSave && typeof parsed.autoSave === 'object' ? parsed.autoSave : {};
    for (const [key, value] of Object.entries(source)) {
      if (!key) continue;
      if (value && typeof value === 'object') {
        autoSave[key] = { title: String(value.title ?? key), since: num(value.since, Date.now()) };
      } else if (value) {
        // schema 1 stored a bare `true`.
        autoSave[key] = { title: key, since: Date.now() };
      }
    }
    const stats = parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : {};
    return {
      schema: SCHEMA,
      autoSave,
      stats: {
        archived: num(stats.archived),
        bytes: num(stats.bytes),
        failed: num(stats.failed),
        since: num(stats.since, base.stats.since),
      },
    };
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

  isAuto(chatKey) {
    return Boolean(chatKey) && Boolean(this.data.autoSave[chatKey]);
  }

  setAuto(chatKey, title, on) {
    if (!chatKey) return false;
    if (on) {
      const existing = this.data.autoSave[chatKey];
      this.data.autoSave[chatKey] = {
        title: String(title || chatKey),
        since: existing ? existing.since : Date.now(),
      };
    } else if (!this.data.autoSave[chatKey]) {
      return false;
    } else {
      delete this.data.autoSave[chatKey];
    }
    this.save();
    return true;
  }

  autoEntries() {
    return Object.entries(this.data.autoSave);
  }

  get autoCount() {
    return Object.keys(this.data.autoSave).length;
  }

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
