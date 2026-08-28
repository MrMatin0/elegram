/**
 * Two-lane task queue: `urgent` always drains before `normal`.
 *
 * Self-destructing media is the reason this exists — a TTL photo has to be
 * downloaded before the sender's timer wins, so it must be able to jump a queue
 * full of 200 MB videos.
 */
export class TaskQueue {
  constructor(worker, concurrency = 2) {
    if (typeof worker !== 'function') throw new TypeError('TaskQueue needs a worker function');
    this.worker = worker;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.urgent = [];
    this.normal = [];
    this.running = 0;
    this.completed = 0;
    this.failed = 0;
    this._closed = false;
    this._idleWaiters = [];
  }

  get pending() {
    return this.urgent.length + this.normal.length;
  }

  get size() {
    return this.pending + this.running;
  }

  get stats() {
    return { pending: this.pending, running: this.running, completed: this.completed, failed: this.failed };
  }

  /**
   * Live concurrency change, for the panel's ± buttons.
   *
   * Raising it has to drain immediately: without that, the extra worker sits
   * idle until the next task happens to arrive, which looks exactly like the
   * setting having no effect.
   */
  setConcurrency(value) {
    const next = Math.max(1, Math.floor(Number(value) || 1));
    if (next === this.concurrency) return this.concurrency;
    const raised = next > this.concurrency;
    this.concurrency = next;
    // Lowering it never interrupts work in flight; the surplus simply retires as
    // each running task finishes.
    if (raised) this._drain();
    return this.concurrency;
  }

  add(task, { priority = false } = {}) {
    if (this._closed) return Promise.reject(new Error('صف بسته شده است.'));
    return new Promise((resolve, reject) => {
      (priority ? this.urgent : this.normal).push({ task, resolve, reject });
      this._drain();
    });
  }

  /** Position a freshly added task would land in — used for the queued card. */
  positionFor({ priority = false } = {}) {
    return (priority ? this.urgent.length : this.pending) + 1;
  }

  /** Resolves once nothing is queued or in flight. */
  onIdle() {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this._idleWaiters.push(resolve));
  }

  /** Rejects everything still waiting so no caller is left hanging. */
  clear(reason = 'صف پاک شد') {
    const waiting = [...this.urgent, ...this.normal];
    this.urgent = [];
    this.normal = [];
    for (const item of waiting) item.reject(new Error(reason));
    this._settleIdle();
    return waiting.length;
  }

  close(reason) {
    this._closed = true;
    return this.clear(reason);
  }

  _settleIdle() {
    if (this.size > 0) return;
    const waiters = this._idleWaiters;
    this._idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  _drain() {
    while (this.running < this.concurrency && this.pending > 0) {
      const item = this.urgent.length ? this.urgent.shift() : this.normal.shift();
      this.running += 1;
      // Promise.resolve().then() keeps a synchronously-throwing worker from
      // escaping as an exception instead of a rejected promise.
      Promise.resolve()
        .then(() => this.worker(item.task))
        .then(
          (value) => {
            this.completed += 1;
            item.resolve(value);
          },
          (error) => {
            this.failed += 1;
            item.reject(error);
          },
        )
        .finally(() => {
          this.running -= 1;
          this._drain();
          this._settleIdle();
        });
    }
  }
}
