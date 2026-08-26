import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MirrorService } from '../src/services/mirror.js';
import { Store } from '../src/store.js';
import { setLogLevel } from '../src/utils/logger.js';

setLogLevel('silent');

const GROUP = '-1001111';
const ME = '500';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'elegram-mirror-'));

function harness({ mirrored = true, failArchive = false, gate = null } = {}) {
  const archived = [];
  const notices = [];
  const archiver = {
    dest: 'me',
    // The mirror never asks for a caption or a card: it archives as-is.
    archiveAsIs: async (msg) => {
      if (gate) await gate;
      if (failArchive) throw new Error('FLOOD_WAIT_600');
      const sent = { id: 900 + archived.length };
      archived.push({ source: msg.id, saved: sent.id });
      return sent;
    },
    sendText: async (text, options = {}) => {
      const message = { id: 800 + notices.length, text, replyTo: options.replyTo ?? null };
      notices.push(message);
      return message;
    },
  };
  // A mirror must never depend on the network: everything it needs is already
  // in the update it was handed, or in the store.
  const client = {
    getEntity: async () => {
      throw new Error('entity lookup is not available');
    },
  };
  const store = new Store(tmp(), { debounceMs: 0 });
  if (mirrored) store.setMirror(GROUP, 'گروه تست', true);
  const build = () => new MirrorService(client, store, archiver, { timezone: 'UTC', myId: ME, sendGapMs: 0 });
  return { mirror: build(), build, store, archived, notices, archiver };
}

const incoming = (id, text, extra = {}) => ({
  id,
  chatId: GROUP,
  peerId: GROUP,
  message: text,
  date: Math.floor(Date.now() / 1000),
  chat: { title: 'گروه تست' },
  senderId: '777',
  sender: { firstName: 'علی' },
  ...extra,
});

test('a captured message is archived as-is, with nothing added and nothing said', async () => {
  const { mirror, store, archived, notices } = harness();
  const snapshot = await mirror.capture(incoming(10, 'سلام، این پیام اصلیه'));

  assert.deepEqual(archived, [{ source: 10, saved: 900 }]);
  assert.equal(notices.length, 0, 'no card, no description — just the copy');
  assert.equal(snapshot.savedId, 900);
  assert.equal(store.savedIdFor(GROUP, 10), 900, 'the mapping is persisted');
  assert.equal(mirror.stats.captured, 1);
});

test('a replayed update after a reconnect is not archived twice', async () => {
  const { mirror, archived } = harness();
  const msg = incoming(11, 'یک بار بس است');
  await mirror.capture(msg);
  assert.equal(await mirror.capture(msg), null);
  assert.equal(archived.length, 1);
});

test('an edit posts a short notice as a reply to the archived copy', async () => {
  const { mirror, notices } = harness();
  await mirror.capture(incoming(12, 'متن اول'));
  await mirror.onEdit(incoming(12, 'متن دوم'));

  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /ویرایش شد/);
  assert.match(notices[0].text, /متن دوم/);
  assert.equal(notices[0].replyTo, 900, 'the notice hangs off the archived copy');
  assert.equal(mirror.get(GROUP, 12).revisions, 1);
  assert.equal(mirror.stats.edits, 1);
});

test('an edit update that changes no text says nothing', async () => {
  const { mirror, notices } = harness();
  await mirror.capture(incoming(14, 'بدون تغییر'));
  // Telegram also emits edits for pins, media re-renders and reaction churn.
  assert.equal(await mirror.onEdit(incoming(14, 'بدون تغییر')), null);
  assert.equal(notices.length, 0);
});

test('a delete for everyone is reported once, in the same thread', async () => {
  const { mirror, notices } = harness();
  await mirror.capture(incoming(15, 'این پاک می‌شود'));
  await mirror.onDelete([15, 999], GROUP);
  await mirror.onDelete([15], GROUP);

  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /حذف شد/);
  assert.equal(notices[0].replyTo, 900);
  assert.equal(mirror.stats.deletions, 1);
});

test('a delete update with no peer is resolved through the id index', async () => {
  const { mirror, notices } = harness();
  await mirror.capture(incoming(16, 'دیلیت بدون peer'));
  // updateDeleteMessages (private chats, basic groups) carries no chat id.
  await mirror.onDelete([16], '');

  assert.equal(notices.length, 1);
  assert.equal(notices[0].replyTo, 900);
});

test('an edit that lands after the delete reports nothing new', async () => {
  const { mirror, notices } = harness();
  await mirror.capture(incoming(18, 'رفت'));
  await mirror.onDelete([18], GROUP);
  assert.equal(await mirror.onEdit(incoming(18, 'برگشت')), null);
  assert.equal(notices.length, 1);
});

test('a delete racing the upload still replies to the copy', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { mirror, notices } = harness({ gate });

  const capturing = mirror.capture(incoming(19, 'حذف قبل از آپلود'));
  const deleting = mirror.onDelete([19], GROUP);
  release();
  await Promise.all([capturing, deleting]);

  assert.equal(notices.length, 1);
  assert.equal(notices[0].replyTo, 900, 'the notice waited for the copy instead of drifting off');
});

test('after a restart the persisted mapping still anchors a delete', async () => {
  const { mirror, build, notices } = harness();
  await mirror.capture(incoming(20, 'قبل از ری‌استارت'));
  // A restart loses every snapshot; the store does not.
  const restarted = build();
  await restarted.onDelete([20], GROUP);
  await restarted.onDelete([20], '');

  assert.equal(notices.length, 1, 'reported once, even across the id fallback');
  assert.equal(notices[0].replyTo, 900);
});

test('turning the mirror off silences edit and delete notices', async () => {
  const { mirror, notices } = harness({ mirrored: false });
  await mirror.capture(incoming(21, 'قبل از خاموشی'));
  assert.equal(await mirror.onEdit(incoming(21, 'بعدش')), null);
  assert.deepEqual(await mirror.onDelete([21], GROUP), []);
  assert.equal(notices.length, 0);
});

test('a failing archive never breaks the pipeline', async () => {
  const { mirror, notices, store } = harness({ failArchive: true });
  const snapshot = await mirror.capture(incoming(22, 'حتی وقتی تلگرام نه میگه'));
  assert.equal(snapshot.savedId, null);
  assert.equal(store.savedIdFor(GROUP, 22), 0);
  // The snapshot still exists, so a later delete is still reported.
  await mirror.onDelete([22], GROUP);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].replyTo, null);
});

test('junk updates are ignored instead of throwing', async () => {
  const { mirror } = harness();
  assert.equal(await mirror.capture({ id: 0, chatId: GROUP }), null);
  assert.equal(await mirror.capture(null), null);
  assert.equal(await mirror.onEdit({ chatId: GROUP }), null);
  assert.deepEqual(await mirror.onDelete(['x', -1], GROUP), []);
});
