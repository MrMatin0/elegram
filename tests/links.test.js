import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeMessageLink, parseMessageLink } from '../src/utils/links.js';

test('parses a public channel post link', () => {
  assert.deepEqual(parseMessageLink('https://t.me/durov/123'), {
    kind: 'public',
    target: 'durov',
    username: 'durov',
    messageId: 123,
    threadId: 0,
  });
});

test('accepts a link without a scheme, with junk around it', () => {
  const parsed = parseMessageLink('  «t.me/some_channel/7».  ');
  assert.equal(parsed.kind, 'public');
  assert.equal(parsed.username, 'some_channel');
  assert.equal(parsed.messageId, 7);
});

test('keeps the last id of a topic link and remembers the thread', () => {
  const parsed = parseMessageLink('https://t.me/mygroup/45/912');
  assert.equal(parsed.messageId, 912);
  assert.equal(parsed.threadId, 45);
});

test('marks a private channel id with the -100 prefix', () => {
  assert.deepEqual(parseMessageLink('https://t.me/c/1234567890/55'), {
    kind: 'private',
    target: -1001234567890,
    channelId: '1234567890',
    messageId: 55,
    threadId: 0,
  });
});

test('handles a private topic link', () => {
  const parsed = parseMessageLink('https://t.me/c/1234567890/12/34');
  assert.equal(parsed.target, -1001234567890);
  assert.equal(parsed.messageId, 34);
  assert.equal(parsed.threadId, 12);
});

test('unwraps the web preview form', () => {
  const parsed = parseMessageLink('https://t.me/s/channelname/900');
  assert.equal(parsed.kind, 'public');
  assert.equal(parsed.username, 'channelname');
  assert.equal(parsed.messageId, 900);
});

test('ignores single and comment query parameters', () => {
  assert.equal(parseMessageLink('https://t.me/durov/123?single').messageId, 123);
  assert.equal(parseMessageLink('https://t.me/durov/123?comment=9').messageId, 123);
});

test('reads tg:// deep links', () => {
  assert.equal(parseMessageLink('tg://resolve?domain=durov&post=42').messageId, 42);
  assert.equal(parseMessageLink('tg://privatepost?channel=1234567890&post=8').target, -1001234567890);
  assert.deepEqual(parseMessageLink('tg://openmessage?user_id=777&message_id=5'), {
    kind: 'user',
    target: 777,
    messageId: 5,
    threadId: 0,
  });
});

test('rejects anything that is not a message link', () => {
  for (const value of [
    '',
    null,
    'hello',
    'https://example.com/durov/1',
    'https://t.me/durov',
    'https://t.me/c/1234567890',
    'https://t.me/joinchat/AAAA',
    'https://t.me/+AbCdEf',
    'https://t.me/durov/0',
    'https://t.me/ab/12',
  ]) {
    assert.equal(parseMessageLink(value), null, `expected null for ${String(value)}`);
  }
});

test('recognises the intent of a link even when it cannot be parsed', () => {
  assert.equal(looksLikeMessageLink('https://t.me/durov'), true);
  assert.equal(looksLikeMessageLink('t.me/c/1/'), true);
  assert.equal(looksLikeMessageLink('tg://privatepost?channel=1'), true);
  assert.equal(looksLikeMessageLink('on'), false);
  assert.equal(looksLikeMessageLink('https://example.com/x/1'), false);
});
