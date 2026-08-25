export class AlbumBuffer {
  constructor(flushMs = 900) {
    this.flushMs = flushMs;
    this.groups = new Map();
  }

  push(key, msg, onFlush) {
    let group = this.groups.get(key);
    if (!group) {
      group = { items: [], timer: null };
      group.timer = setTimeout(() => {
        this.groups.delete(key);
        onFlush(group.items);
      }, this.flushMs);
      this.groups.set(key, group);
    }
    group.items.push(msg);
  }
}
