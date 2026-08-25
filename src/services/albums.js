import { log, errText } from '../utils/logger.js';

const TELEGRAM_ALBUM_MAX = 10;

/**
 * Buffers the messages of a Telegram album so they can be archived as one job.
 * Flushes on a timer, or immediately once the album hits its hard size limit.
 */
export class AlbumBuffer {
  constructor({ windowMs = 1200, maxItems = TELEGRAM_ALBUM_MAX, onFlush } = {}) {
    this.windowMs = Math.max(100, Number(windowMs) || 1200);
    this.maxItems = Math.max(1, Number(maxItems) || TELEGRAM_ALBUM_MAX);
    this.onFlush = typeof onFlush === 'function' ? onFlush : () => {};
    this.groups = new Map();
  }

  push(key, msg) {
    let group = this.groups.get(key);
    if (!group) {
      group = { items: [], timer: null };
      this.groups.set(key, group);
      group.timer = setTimeout(() => this.flush(key), this.windowMs);
      group.timer.unref?.();
    }
    group.items.push(msg);
    if (group.items.length >= this.maxItems) this.flush(key);
  }

  flush(key) {
    const group = this.groups.get(key);
    if (!group) return;
    clearTimeout(group.timer);
    this.groups.delete(key);
    if (!group.items.length) return;
    try {
      this.onFlush(group.items);
    } catch (error) {
      log.error('[albums] پردازش آلبوم ناموفق بود:', errText(error));
    }
  }

  dispose() {
    for (const key of [...this.groups.keys()]) this.flush(key);
  }
}
