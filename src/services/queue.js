export class TaskQueue {
  constructor(worker, concurrency = 2) {
    this.worker = worker;
    this.concurrency = Math.max(1, concurrency);
    this.urgent = [];
    this.normal = [];
    this.running = 0;
  }

  get pending() {
    return this.urgent.length + this.normal.length;
  }

  add(task, { priority = false } = {}) {
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject };
      (priority ? this.urgent : this.normal).push(item);
      this._drain();
    });
  }

  _drain() {
    while (this.running < this.concurrency && (this.urgent.length || this.normal.length)) {
      const item = this.urgent.shift() ?? this.normal.shift();
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
