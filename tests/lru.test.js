import assert from 'node:assert/strict';
import test from 'node:test';
import { LruMap, LruSet } from '../src/utils/lru.js';

test('LruSet reports duplicates and evicts the oldest key', () => {
  const seen = new LruSet(3);
  assert.equal(seen.add('a'), false, 'first sighting');
  assert.equal(seen.add('a'), true, 'second sighting is a duplicate');
  seen.add('b');
  seen.add('c');
  // Re-seeing 'a' refreshes it, so 'b' becomes the least recently used key.
  assert.equal(seen.add('a'), true);
  seen.add('d');
  assert.equal(seen.size, 3);
  assert.equal(seen.has('b'), false, 'oldest key evicted');
  assert.equal(seen.has('a'), true, 'refreshed key survived');
  assert.equal(seen.has('d'), true);
});

test('LruSet always keeps at least one slot', () => {
  const seen = new LruSet(0);
  seen.add('x');
  assert.equal(seen.size, 1);
});

test('LruMap tracks read recency, not just writes', () => {
  const map = new LruMap(2);
  map.set('a', 1);
  map.set('b', 2);
  assert.equal(map.get('a'), 1);
  map.set('c', 3);
  // reading 'a' saved it; 'b' is evicted.
  assert.equal(map.has('b'), false);
  assert.equal(map.get('a'), 1);
  assert.equal(map.get('c'), 3);
});

test('LruMap can cache an empty-string value', () => {
  const map = new LruMap(2);
  map.set('k', '');
  assert.equal(map.get('k'), '');
  assert.equal(map.get('missing'), undefined);
});
