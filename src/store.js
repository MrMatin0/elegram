import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'store.json');
    this.data = {
      autoSave: {},
      stats: { archived: 0, bytes: 0 },
    };
    this._timer = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...this.data, ...raw };
        this.data.stats = { archived: 0, bytes: 0, ...(raw.stats || {}) };
        this.data.autoSave = raw.autoSave || {};
      }
    } catch (e) {
      console.error('[store] load failed:', e.message);
    }
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 500);
  }

  flush() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('[store] save failed:', e.message);
    }
  }

  isAuto(chatKey) {
    return Boolean(this.data.autoSave[chatKey]);
  }

  setAuto(chatKey, title, on) {
    if (on) {
      this.data.autoSave[chatKey] = { title: title || chatKey, since: Date.now() };
    } else {
      delete this.data.autoSave[chatKey];
    }
    this.save();
  }

  countArchive(bytes) {
    this.data.stats.archived += 1;
    this.data.stats.bytes += Number(bytes) || 0;
    this.save();
  }
}
