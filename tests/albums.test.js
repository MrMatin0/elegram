import assert from 'node:assert/strict';
import test from 'node:test';
import { AlbumBuffer } from '../src/services/albums.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('flushes on the timer with everything that arrived', async () => {
  const flushes = [];
  const buffer = new AlbumBuffer({ windowMs: 100, onFlush: (items) => flushes.push(items) });
  buffer.push('g1', { id: 2 });
  buffer.push('g1', { id: 1 });
  assert.equal(flushes.length, 0);
  await wait(160);
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].length, 2);
});

test('flushes immediately at Telegram\u2019s hard album limit', () => {
  const flushes = [];
  const buffer = new AlbumBuffer({ windowMs: 5000, onFlush: (items) => flushes.push(items) });
  for (let i = 0; i < 10; i += 1) buffer.push('g', { id: i });
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].length, 10);
  assert.equal(buffer.openGroups, 0);
});

test('keeps separate groups apart', async () => {
  const flushes = [];
  const buffer = new AlbumBuffer({ windowMs: 60, onFlush: (items) => flushes.push(items) });
  buffer.push('a', { id: 1 });
  buffer.push('b', { id: 2 });
  assert.equal(buffer.openGroups, 2);
  await wait(120);
  assert.equal(flushes.length, 2);
});

test('a throwing consumer cannot kill the buffer', () => {
  const buffer = new AlbumBuffer({
    windowMs: 5000,
    onFlush: () => {
      throw new Error('downstream boom');
    },
  });
  buffer.push('g', { id: 1 });
  assert.doesNotThrow(() => buffer.dispose());
  assert.equal(buffer.openGroups, 0);
});

test('dispose drains everything still buffered', () => {
  const flushes = [];
  const buffer = new AlbumBuffer({ windowMs: 5000, onFlush: (items) => flushes.push(items) });
  buffer.push('a', { id: 1 });
  buffer.push('b', { id: 2 });
  buffer.dispose();
  assert.equal(flushes.length, 2);
  assert.equal(buffer.openGroups, 0);
});

test('ignores junk pushes', () => {
  const buffer = new AlbumBuffer({ windowMs: 5000, onFlush: () => {} });
  buffer.push('', { id: 1 });
  buffer.push('k', null);
  assert.equal(buffer.openGroups, 0);
  assert.equal(buffer.flush('nope'), 0);
});
