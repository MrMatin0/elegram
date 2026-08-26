import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_FAILURES, markedChatId, resolveChat } from '../src/services/lookup.js';
import { setLogLevel } from '../src/utils/logger.js';

setLogLevel('silent');

const client = (entities = {}) => ({
  asked: [],
  async getEntity(target) {
    this.asked.push(target);
    const found = entities[String(target)];
    if (!found) throw new Error('Could not find the input entity');
    return found;
  },
});

test('markedChatId converts a bare entity id into the form updates use', () => {
  assert.equal(markedChatId({ id: 1234567890, className: 'Channel' }), '-1001234567890');
  assert.equal(markedChatId({ id: 777, className: 'Chat' }), '-777');
  assert.equal(markedChatId({ id: 42, className: 'User' }), '42');
  assert.equal(markedChatId({ id: '-1001234567890', className: 'Channel' }), '-1001234567890');
  assert.equal(markedChatId(null), '');
});

test('a username resolves to the marked chat id and its title', async () => {
  const api = client({ mychannel: { id: 1234567890, className: 'Channel', title: 'کانال من' } });
  const found = await resolveChat(api, '@mychannel');
  assert.equal(found.chatKey, '-1001234567890');
  assert.equal(found.title, 'کانال من');
  assert.deepEqual(api.asked, ['mychannel'], 'the @ is stripped before resolving');
});

test('a marked numeric id resolves as given', async () => {
  const api = client({ '-1001234567890': { id: 1234567890, className: 'Channel', title: 'گروه' } });
  const found = await resolveChat(api, '-1001234567890');
  assert.equal(found.chatKey, '-1001234567890');
});

test('a bare channel id is retried with the -100 prefix Telegram marks it with', async () => {
  const api = client({ '-1001234567890': { id: 1234567890, className: 'Channel', title: 'گروه' } });
  const found = await resolveChat(api, '1234567890');
  assert.equal(found.chatKey, '-1001234567890');
  assert.deepEqual(api.asked, [1234567890, -1001234567890]);
});

test('a chat this session cannot reach is reported, never assumed', async () => {
  const api = client({});
  const found = await resolveChat(api, '@secretplace');
  assert.equal(found.failure, CHAT_FAILURES.ACCESS);
  assert.equal(found.chatKey, undefined);
});

test('anything that is not a username or an id is refused before the network', async () => {
  const api = client({});
  for (const value of ['', null, 'no!', 'ab', '9'.repeat(30)]) {
    const found = await resolveChat(api, value);
    assert.equal(found.failure, CHAT_FAILURES.INVALID, `expected invalid for ${String(value)}`);
  }
  assert.equal(api.asked.length, 0);
});
