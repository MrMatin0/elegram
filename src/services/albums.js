import { log, errText } from '../utils/logger.js';

const TELEGRAM_ALBUM_MAX = 10;
const MAX_OPEN_GROUPS = 64;

/**
 * Buffers the messages of a Telegram album so they can be archived as one job.
 *
 * Telegram delivers an album as N independent updates sharing a `grouped_id`,
 * with no "that was the last one" marker. We therefore flush on a short timer,
 * or immediately once a group hits Telegram's hard limit of 10 items.
 */
export class AlbumBuffer {
  constructor({ windowMs = 1200, maxItems = TELEGRAM_ALBUM_MAX, onFlush } = {}) {
    this.windowMs = Math.max(100, Number(windowMs) || 1200);
    this.maxItems = Math.max(1, Number(maxItems) || TELEGRAM_ALBUM_MAX);
    this.onFlush = typeof onFlush === 'function' ? onFlush : () => {};
    this.groups = new Map();
  }

  push(key, msg) {
    if (!key || !msg) return;
    let group = this.groups.get(key);
    if (!group) {
      // Bound the map: a flood of half-finished groups must not leak memory.
      if (this.groups.size >= MAX_OPEN_GROUPS) this.flush(this.groups.keys().next().value);
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
    if (!group) return 0;
    clearTimeout(group.timer);
    this.groups.delete(key);
    if (!group.items.length) return 0;
    try {
      this.onFlush(group.items);
    } catch (error) {
      log.error('[albums] پردازش آلبوم ناموفق بود:', errText(error));
    }
    return group.items.length;
  }

  get openGroups() {
    return this.groups.size;
  }

  dispose() {
    for (const key of [...this.groups.keys()]) this.flush(key);
  }
}
