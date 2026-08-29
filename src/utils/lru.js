/**
 * Two tiny bounded collections. Both rely on JS Map/Set preserving insertion
 * order: re-inserting a key moves it to the end, so the *first* key is always
 * the least recently used one and eviction is a single `delete`.
 */

/** Bounded set used for update de-duplication. */
export class LruSet {
  constructor(limit = 2048) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.items = new Set();
  }

  has(key) {
    return this.items.has(key);
  }

  /**
   * Records `key`.
   * @returns {boolean} true when the key had already been seen (a duplicate).
   */
  add(key) {
    if (this.items.has(key)) {
      this.items.delete(key);
      this.items.add(key);
      return true;
    }
    this.items.add(key);
    while (this.items.size > this.limit) {
      this.items.delete(this.items.values().next().value);
    }
    return false;
  }

  /**
   * Forgets `key`, so the next `add()` of it reports a first sighting again.
   *
   * Dedupe is normally permanent — that is the point — but a claim staked before
   * the work succeeded has to be releasable, or a single failed attempt blocks
   * every retry Telegram would have handed us for free on the next reconnect.
   *
   * @returns {boolean} true when the key was actually being tracked.
   */
  delete(key) {
    return this.items.delete(key);
  }

  get size() {
    return this.items.size;
  }

  clear() {
    this.items.clear();
  }
}

/** Bounded map with proper read-recency (a plain Map only tracks writes). */
export class LruMap {
  constructor(limit = 500) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.items = new Map();
  }

  has(key) {
    return this.items.has(key);
  }

  get(key) {
    if (!this.items.has(key)) return undefined;
    const value = this.items.get(key);
    this.items.delete(key);
    this.items.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.items.has(key)) this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.limit) {
      this.items.delete(this.items.keys().next().value);
    }
    return this;
  }

  delete(key) {
    return this.items.delete(key);
  }

  get size() {
    return this.items.size;
  }

  clear() {
    this.items.clear();
  }
}
