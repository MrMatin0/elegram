import test from 'node:test';
import assert from 'node:assert/strict';
import { MirrorService } from '../src/services/mirror.js';
import { setLogLevel } from '../src/utils/logger.js';

setLogLevel('silent');

const GROUP = '-1001111';
const ME = '500';

function harness({ mirrored = true } = {}) {
  const sent = [];
  const archiver = {
    dest: 'me',
    sendText: async (text, options = {}) => {
      const message = { id: 900 + sent.length, text, replyTo: options.replyTo ?? null };
      sent.push(message);
      return message;
    },
  };
  // A mirror must never depend on the network: everything it reports is already
  // in the update it was handed.
  const client = {
    getEntity: async () => {
      throw new Error('entity lookup is not available');
    },
  };
  const store = { isMirror: () => mirrored };
  const mirror = new MirrorService(client, store, archiver, {
    timezone: 'UTC',
    myId: ME,
    sendGapMs: 0,
  });
  return { mirror, sent };
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

test('a captured message is copied with its chat, sender and body', async () => {
  const { mirror, sent } = harness();
  const snapshot = await mirror.capture(incoming(10, 'سلام، این پیام اصلیه'));

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /گروه تست/);
  assert.match(sent[0].text, /علی/);
  assert.match(sent[0].text, /این پیام اصلیه/);
  assert.equal(sent[0].replyTo, null, 'the original copy opens the thread');
  assert.equal(snapshot.cardId, sent[0].id);
  assert.equal(mirror.stats.captured, 1);
});

test('a replayed update after a reconnect is not mirrored twice', async () => {
  const { mirror, sent } = harness();
  const msg = incoming(11, 'یک بار بس است');
  await mirror.capture(msg);
  assert.equal(await mirror.capture(msg), null);
  assert.equal(sent.length, 1);
});

test('an edit keeps the original and reports both versions in the thread', async () => {
  const { mirror, sent } = harness();
  await mirror.capture(incoming(12, 'متن اول'));
  await mirror.onEdit(incoming(12, 'متن دوم'));

  assert.equal(sent.length, 2);
  const card = sent[1].text;
  assert.match(card, /ویرایش/);
  assert.match(card, /متن اول/, 'the previous version is on the record');
  assert.match(card, /متن دوم/);
  assert.equal(sent[1].replyTo, sent[0].id, 'the notice hangs off the original copy');

  const snapshot = mirror.get(GROUP, 12);
  assert.equal(snapshot.original, 'متن اول', 'the first version is never overwritten');
  assert.equal(snapshot.text, 'متن دوم');
  assert.equal(snapshot.revisions, 1);
});

test('a second edit still remembers the very first version', async () => {
  const { mirror, sent } = harness();
  await mirror.capture(incoming(13, 'نسخه یک'));
  await mirror.onEdit(incoming(13, 'نسخه دو'));
  await mirror.onEdit(incoming(13, 'نسخه سه'));

  assert.equal(sent.length, 3);
  assert.match(sent[2].text, /نسخه یک/);
  assert.match(sent[2].text, /نسخه دو/);
  assert.match(sent[2].text, /نسخه سه/);
  assert.equal(mirror.get(GROUP, 13).revisions, 2);
});

test('an edit update that changes no text says nothing', async () => {
  const { mirror, sent } = harness();
  await mirror.capture(incoming(14, 'بدون تغییر'));
  // Telegram also emits edits for pins, media re-renders and reaction churn.
  assert.equal(await mirror.onEdit(incoming(14, 'بدون تغییر')), null);
  assert.equal(sent.length, 1);
});

test('a delete for everyone still shows the original text', async () => {
  const { mirror, sent } = harness();
  await mirror.capture(incoming(15, 'این پاک می‌شود'));
  await mirror.onDelete([15], GROUP);

  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /پاک شد/);
  assert.match(sent[1].text, /این پاک می‌شود/);
  assert.equal(sent[1].replyTo, sent[0].id);
  assert.equal(mirror.stats.deletions, 1);
});

test('a delete update with no peer is resolved through the id index', async () => {
  const { mirror, sent } = harness();
  await mirror.capture(incoming(16, 'دیلیت بدون peer'));
  // updateDeleteMessages (private chats, basic groups) carries no chat id.
  await mirror.onDelete([16], '');

  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /دیلیت بدون peer/);
});

test('a delete is reported once, and never for a message we never mirrored', async () => {
  const { mirror, sent } = harness();
  await mirror.capture(incoming(17, 'یکتا'));
  await mirror.onDelete([17, 999], GROUP);
  await mirror.onDelete([17], GROUP);

  assert.equal(sent.length, 2, 'one copy, one delete notice');
  assert.equal(mirror.stats.deletions, 1);
});

test('an edited message that was deleted before the edit landed reports nothing new', async () => {
  const { mirror, sent } = harness();
  await mirror.capture(incoming(18, 'رفت'));
  await mirror.onDelete([18], GROUP);
  assert.equal(await mirror.onEdit(incoming(18, 'برگشت')), null);
  assert.equal(sent.length, 2);
});

test('turning the mirror off silences edit and delete notices', async () => {
  const { mirror, sent } = harness({ mirrored: false });
  await mirror.capture(incoming(19, 'قبل از خاموشی'));
  assert.equal(await mirror.onEdit(incoming(19, 'بعدش')), null);
  assert.deepEqual(await mirror.onDelete([19], GROUP), []);
  assert.equal(sent.length, 1);
});

test('a media message with no caption is still mirrored, with its type', async () => {
  const { mirror, sent } = harness();
  await mirror.capture(incoming(20, '', {
    media: { className: 'MessageMediaDocument' },
    document: { size: 1024, mimeType: 'video/mp4', attributes: [{ className: 'DocumentAttributeVideo' }] },
  }));
  assert.match(sent[0].text, /ویدیو/);
  assert.match(sent[0].text, /بدون متن/);
});

test('a channel post has no separate sender line', async () => {
  const { mirror, sent } = harness();
  await mirror.capture(incoming(21, 'پست کانال', { senderId: GROUP, sender: null, chat: { title: 'کانال خبری' } }));
  assert.match(sent[0].text, /کانال خبری/);
  assert.equal(/\u{1F464}/u.test(sent[0].text), false, 'the chat is the sender');
});

test('a failing send never breaks the pipeline', async () => {
  const { mirror } = harness();
  mirror.archiver.sendText = async () => {
    throw new Error('FLOOD_WAIT_600');
  };
  const snapshot = await mirror.capture(incoming(22, 'حتی وقتی تلگرام نه میگه'));
  assert.equal(snapshot.cardId, null);
  // The snapshot still exists, so a later delete can be reported.
  assert.equal(mirror.get(GROUP, 22).text, 'حتی وقتی تلگرام نه میگه');
});
