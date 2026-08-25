import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'elegram-store-'));

test('starts from defaults when there is no file', () => {
  const store = new Store(tmp(), { debounceMs: 0 });
  assert.equal(store.data.stats.archived, 0);
  assert.equal(store.autoCount, 0);
  assert.deepEqual(store.autoEntries(), []);
});

test('auto-save toggles round-trip through disk', () => {
  const dir = tmp();
  const store = new Store(dir, { debounceMs: 0 });
  assert.equal(store.setAuto('-100123', 'My Channel', true), true);
  assert.equal(store.isAuto('-100123'), true);
  store.flush();

  const reopened = new Store(dir, { debounceMs: 0 });
  assert.equal(reopened.isAuto('-100123'), true);
  assert.equal(reopened.data.autoSave['-100123'].title, 'My Channel');

  assert.equal(reopened.setAuto('-100123', 'My Channel', false), true);
  assert.equal(reopened.setAuto('-100123', 'My Channel', false), false);
  assert.equal(reopened.isAuto('-100123'), false);
  assert.equal(store.setAuto('', 'x', true), false);
});

test('re-enabling keeps the original "since" timestamp', () => {
  const store = new Store(tmp(), { debounceMs: 0 });
  store.setAuto('7', 'chat', true);
  const since = store.data.autoSave['7'].since;
  store.setAuto('7', 'renamed', true);
  assert.equal(store.data.autoSave['7'].since, since);
  assert.equal(store.data.autoSave['7'].title, 'renamed');
});

test('counters ignore junk and never go negative', () => {
  const store = new Store(tmp(), { debounceMs: 0 });
  store.countArchive(100, 2);
  // Junk or negative input falls back to "one archived item, zero bytes".
  store.countArchive('nope', 'nope');
  store.countArchive(-5, -5);
  store.countFailure();
  assert.equal(store.data.stats.archived, 4);
  assert.equal(store.data.stats.bytes, 100);
  assert.equal(store.data.stats.failed, 1);
});

test('migrates the schema-1 shape where autoSave held bare booleans', () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'store.json'),
    JSON.stringify({ autoSave: { '5': true, '6': false }, stats: { archived: '9' } }),
  );
  const store = new Store(dir, { debounceMs: 0 });
  assert.equal(store.isAuto('5'), true);
  assert.equal(store.isAuto('6'), false);
  assert.equal(store.data.stats.archived, 9);
  assert.equal(store.data.schema, 2);
});

test('a corrupt store is quarantined instead of crashing the service', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'store.json'), '{ this is not json');
  const store = new Store(dir, { debounceMs: 0 });
  assert.equal(store.autoCount, 0);
  assert.ok(fs.readdirSync(dir).some((name) => name.includes('.corrupt-')));
});

test('flush writes atomically and leaves no temp file behind', () => {
  const dir = tmp();
  const store = new Store(dir, { debounceMs: 0 });
  store.countArchive(1, 1);
  assert.equal(store.flush(), true);
  assert.equal(store.flush(), false);
  assert.ok(!fs.existsSync(path.join(dir, 'store.json.tmp')));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'))).sort(), ['autoSave', 'schema', 'stats']);
});
