export class TaskQueue {
  constructor(worker, concurrency = 2) {
    this.worker = worker;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.urgent = [];
    this.normal = [];
    this.running = 0;
  }

  get pending() {
    return this.urgent.length + this.normal.length;
  }

  get size() {
    return this.pending + this.running;
  }

  add(task, { priority = false } = {}) {
    return new Promise((resolve, reject) => {
      (priority ? this.urgent : this.normal).push({ task, resolve, reject });
      this._drain();
    });
  }

  /** Rejects everything still waiting — used on shutdown so nothing hangs. */
  clear(reason = 'صف پاک شد') {
    const waiting = [...this.urgent, ...this.normal];
    this.urgent = [];
    this.normal = [];
    for (const item of waiting) item.reject(new Error(reason));
    return waiting.length;
  }

  _drain() {
    while (this.running < this.concurrency && this.pending > 0) {
      const item = this.urgent.length ? this.urgent.shift() : this.normal.shift();
      this.running += 1;
      Promise.resolve()
        .then(() => this.worker(item.task))
        .then(item.resolve, item.reject)
        .finally(() => {
          this.running -= 1;
          this._drain();
        });
    }
  }
}
