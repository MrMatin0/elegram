import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskQueue } from '../src/services/queue.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a worker is required', () => {
  assert.throws(() => new TaskQueue(null), TypeError);
});

test('respects the concurrency ceiling', async () => {
  let inFlight = 0;
  let peak = 0;
  const queue = new TaskQueue(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await tick();
    inFlight -= 1;
  }, 2);

  await Promise.all(Array.from({ length: 8 }, (_, i) => queue.add(i)));
  assert.equal(peak, 2);
  assert.equal(queue.stats.completed, 8);
  assert.equal(queue.size, 0);
});

test('urgent tasks jump the whole normal lane', async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const queue = new TaskQueue(async (task) => {
    if (task === 'blocker') await gate;
    order.push(task);
  }, 1);

  const all = [
    queue.add('blocker'),
    queue.add('normal-1'),
    queue.add('normal-2'),
    queue.add('urgent', { priority: true }),
  ];
  release();
  await Promise.all(all);
  assert.deepEqual(order, ['blocker', 'urgent', 'normal-1', 'normal-2']);
});

test('a synchronously throwing worker rejects instead of exploding', async () => {
  const queue = new TaskQueue(() => {
    throw new Error('boom');
  }, 1);
  await assert.rejects(queue.add('x'), /boom/);
  assert.equal(queue.stats.failed, 1);
});

test('clear rejects every waiting task so nothing hangs', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const queue = new TaskQueue(() => gate, 1);

  const running = queue.add('running');
  const waiting = [queue.add('a'), queue.add('b')];
  assert.equal(queue.pending, 2);

  const dropped = queue.clear('nope');
  assert.equal(dropped, 2);
  await Promise.all(waiting.map((p) => assert.rejects(p, /nope/)));

  release();
  await running;
});

test('positionFor reports where a new task would land', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const queue = new TaskQueue(() => gate, 1);
  const running = queue.add('running');
  queue.add('a').catch(() => {});
  queue.add('b').catch(() => {});
  assert.equal(queue.positionFor(), 3);
  assert.equal(queue.positionFor({ priority: true }), 1);
  release();
  await running;
  queue.clear();
});

test('onIdle resolves once the queue drains', async () => {
  const queue = new TaskQueue(async () => tick(), 2);
  queue.add(1);
  queue.add(2);
  queue.add(3);
  await queue.onIdle();
  assert.equal(queue.size, 0);
  await queue.onIdle();
});

test('a closed queue refuses new work', async () => {
  const queue = new TaskQueue(async () => {}, 1);
  queue.close('bye');
  await assert.rejects(queue.add('x'), /بسته/);
});
