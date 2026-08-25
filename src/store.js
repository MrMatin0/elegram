import fs from 'node:fs';
import path from 'node:path';
import { log, errText } from './utils/logger.js';

const DEFAULTS = () => ({
  autoSave: {},
  stats: { archived: 0, bytes: 0 },
});

export class Store {
  constructor(dataDir, { debounceMs = 500 } = {}) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'store.json');
    this.debounceMs = debounceMs;
    this.data = DEFAULTS();
    this._timer = null;
    this._dirty = false;
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      const base = DEFAULTS();
      this.data = {
        ...base,
        ...raw,
        autoSave: raw.autoSave && typeof raw.autoSave === 'object' ? raw.autoSave : {},
        stats: { ...base.stats, ...(raw.stats && typeof raw.stats === 'object' ? raw.stats : {}) },
      };
      this.data.stats.archived = Number(this.data.stats.archived) || 0;
      this.data.stats.bytes = Number(this.data.stats.bytes) || 0;
    } catch (error) {
      log.error('[store] خواندن فایل ذخیره‌سازی ناموفق بود:', errText(error));
      this.data = DEFAULTS();
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

  /** Atomic write: a crash mid-write can no longer truncate the store file. */
  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._dirty) return;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (error) {
      log.error('[store] ذخیره‌سازی ناموفق بود:', errText(error));
      fs.rmSync(tmp, { force: true });
    }
  }

  isAuto(chatKey) {
    if (!chatKey) return false;
    return Boolean(this.data.autoSave[chatKey]);
  }

  setAuto(chatKey, title, on) {
    if (!chatKey) return;
    if (on) {
      this.data.autoSave[chatKey] = { title: title || chatKey, since: Date.now() };
    } else {
      delete this.data.autoSave[chatKey];
    }
    this.save();
  }

  countArchive(bytes, count = 1) {
    this.data.stats.archived += Math.max(1, Number(count) || 1);
    this.data.stats.bytes += Math.max(0, Number(bytes) || 0);
    this.save();
  }
}
