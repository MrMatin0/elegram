import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCommandHandler } from '../src/handlers/commands.js';
import { clearPeerCache } from '../src/services/lookup.js';
import { setLogLevel } from '../src/utils/logger.js';

setLogLevel('silent');

const ME = { id: 500, username: 'archivist' };
const SAVED = '500';
const GROUP = '-1009999';

/** A media message, shaped like the fields mediaInfo/archiver actually read. */
const mediaMessage = (id, extra = {}) => ({
  id,
  media: { className: 'MessageMediaDocument' },
  document: { size: 2048, mimeType: 'video/mp4', attributes: [] },
  chatId: GROUP,
  peerId: GROUP,
  ...extra,
});

const textMessage = (id) => ({ id, chatId: GROUP, peerId: GROUP });

function harness({ reply = null, remote = [], entityFails = false } = {}) {
  const calls = { edits: [], sent: [], deleted: [], entities: [], jobs: [] };

  const client = {
    editMessage: async (peer, { message, text }) => {
      calls.edits.push({ peer, id: message, text });
      return { id: message, peerId: peer };
    },
    deleteMessages: async (peer, ids) => {
      calls.deleted.push(...ids);
    },
    getInputEntity: async (target) => {
      calls.entities.push(target);
      if (entityFails) throw new Error('Could not find the input entity');
      return { target };
    },
    iterDialogs: async function* () {},
    getMessages: async (peer, { ids }) =>
      ids.map((id) => remote.find((item) => item.id === id) ?? { id, className: 'MessageEmpty' }),
    iterMessages: async function* () {
      for (const item of remote) yield item;
    },
  };

  const archiver = {
    dest: 'me',
    sendText: async (text) => {
      const message = { id: 900 + calls.sent.length, chatId: SAVED, peerId: SAVED, text };
      calls.sent.push(message);
      return message;
    },
  };

  const queue = {
    stats: { pending: 0, running: 0 },
    positionFor: () => 1,
    clear: () => 0,
    add: async (job) => {
      calls.jobs.push(job);
    },
  };

  const ctx = {
    client,
    archiver,
    queue,
    me: ME,
    store: { data: { stats: {} }, autoCount: 0 },
    version: 'test',
    startedAt: Date.now(),
  };

  const command = (text, chatId) => ({
    id: 1,
    chatId,
    peerId: chatId,
    message: text,
    date: Math.floor(Date.now() / 1000),
    removed: false,
    delete: async function remove() {
      this.removed = true;
      calls.deleted.push(this.id);
    },
    getInputChat: async () => chatId,
    getReplyMessage: async () => reply,
  });

  return { handle: createCommandHandler(ctx), calls, command };
}

beforeEach(() => clearPeerCache());

test('a reply inside Saved Messages still edits the command in place', async () => {
  const { handle, calls, command } = harness({ reply: mediaMessage(10) });
  const msg = command('/save', SAVED);
  await handle({ message: msg });

  assert.equal(msg.removed, false, 'the command in the archive chat is the card');
  assert.equal(calls.deleted.length, 0);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.edits.length, 1);
  assert.equal(calls.jobs.length, 1);
  assert.equal(calls.jobs[0].statusMsg, msg);
  assert.equal(calls.jobs[0].messages[0].id, 10);
});

test('in a group the command is deleted and the card goes to the archive', async () => {
  const { handle, calls, command } = harness({ reply: mediaMessage(11) });
  const msg = command('/save', GROUP);
  await handle({ message: msg });

  assert.equal(msg.removed, true, 'the group keeps no trace of the command');
  assert.equal(calls.edits.length, 0, 'nothing is ever written back to the group');
  assert.equal(calls.sent.length, 1, 'the queue card lands in the archive chat');
  assert.equal(calls.jobs.length, 1);
  assert.equal(calls.jobs[0].statusMsg, calls.sent[0]);
  assert.equal(calls.jobs[0].statusMsg.chatId, SAVED);
});

test('a post link needs no reply at all', async () => {
  const target = mediaMessage(77);
  const { handle, calls, command } = harness({ remote: [target] });
  await handle({ message: command('/save https://t.me/lockedchannel/77', SAVED) });

  assert.deepEqual(calls.entities, ['lockedchannel']);
  assert.equal(calls.jobs.length, 1);
  assert.equal(calls.jobs[0].messages[0], target);
  assert.equal(calls.jobs[0].explicit, true);
});

test('a private link resolves to the marked channel id', async () => {
  const target = mediaMessage(5);
  const { handle, calls, command } = harness({ remote: [target] });
  await handle({ message: command('/save https://t.me/c/1234567890/5', GROUP) });

  assert.deepEqual(calls.entities, [-1001234567890]);
  assert.equal(calls.jobs.length, 1);
  assert.equal(calls.sent.length, 1);
});

test('a link to an album collects every sibling', async () => {
  const album = [
    mediaMessage(20, { groupedId: 'g1' }),
    mediaMessage(21, { groupedId: 'g1' }),
    mediaMessage(22, { groupedId: 'g2' }),
  ];
  const { handle, calls, command } = harness({ remote: album });
  await handle({ message: command('/save https://t.me/somechannel/20', SAVED) });

  assert.deepEqual(calls.jobs[0].messages.map((item) => item.id), [20, 21]);
});

test('an unreachable chat is reported, not queued', async () => {
  const { handle, calls, command } = harness({ entityFails: true });
  await handle({ message: command('/save https://t.me/c/1234567890/5', GROUP) });

  assert.equal(calls.jobs.length, 0);
  assert.equal(calls.sent.length, 1);
  assert.match(calls.sent[0].text, /دسترسی ندارم/);
});

test('a missing message is reported, not queued', async () => {
  const { handle, calls, command } = harness({ remote: [] });
  await handle({ message: command('/save https://t.me/somechannel/404', SAVED) });

  assert.equal(calls.jobs.length, 0);
  assert.match(calls.edits[0].text, /پیدا نشد/);
});

test('junk after /save is called out as a bad link', async () => {
  const { handle, calls, command } = harness({});
  await handle({ message: command('/save please', SAVED) });

  assert.equal(calls.jobs.length, 0);
  assert.equal(calls.entities.length, 0, 'a non-link never hits the network');
  assert.match(calls.edits[0].text, /لینک پیام تلگرام نیست/);
});

test('a link to a text-only post says so', async () => {
  const { handle, calls, command } = harness({ remote: [textMessage(31)] });
  await handle({ message: command('/save https://t.me/somechannel/31', SAVED) });

  assert.equal(calls.jobs.length, 0);
  assert.match(calls.edits[0].text, /رسانه‌ای برای آرشیو وجود ندارد/);
});

test('bare /save with nothing to work with explains both ways', async () => {
  const { handle, calls, command } = harness({ reply: null });
  await handle({ message: command('/save', SAVED) });

  assert.equal(calls.jobs.length, 0);
  assert.match(calls.edits[0].text, /ریپلای/);
  assert.match(calls.edits[0].text, /t\.me\/c\//);
});
