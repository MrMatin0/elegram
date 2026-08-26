import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMessageLink,
  displayName,
  guessFilename,
  idStr,
  isExpiring,
  isSelfDestruct,
  mediaKind,
  mediaSize,
  mediaType,
  sanitizeFilename,
  shouldForceDocument,
  ttlSeconds,
} from '../src/services/mediaInfo.js';

const doc = (attributes, extra = {}) => ({
  media: { className: 'MessageMediaDocument' },
  document: { attributes, ...extra },
});

test('mediaType distinguishes every media shape', () => {
  assert.equal(mediaType({}), null);
  assert.equal(mediaType({ media: { className: 'MessageMediaPhoto' }, photo: {} }), 'photo');
  assert.equal(mediaType(doc([{ className: 'DocumentAttributeSticker' }])), 'sticker');
  assert.equal(mediaType(doc([{ className: 'DocumentAttributeAnimated' }])), 'gif');
  assert.equal(mediaType(doc([{ className: 'DocumentAttributeVideo', roundMessage: false }])), 'video');
  assert.equal(mediaType(doc([{ className: 'DocumentAttributeVideo', roundMessage: true }])), 'round');
  assert.equal(mediaType(doc([{ className: 'DocumentAttributeAudio', voice: true }])), 'voice');
  assert.equal(mediaType(doc([{ className: 'DocumentAttributeAudio', voice: false }])), 'audio');
  assert.equal(mediaType(doc([])), 'document');
  assert.equal(mediaType({ media: { className: 'MessageMediaGeo' } }), 'media');
});

test('a gif keeps its animated type even when it also carries video attrs', () => {
  const gif = doc([{ className: 'DocumentAttributeVideo' }, { className: 'DocumentAttributeAnimated' }]);
  assert.equal(mediaType(gif), 'gif');
});

test('missing attributes array does not throw', () => {
  assert.equal(mediaType({ media: {}, document: {} }), 'document');
  assert.equal(mediaType({ media: {}, document: { attributes: null } }), 'document');
});

test('mediaKind labels every type', () => {
  assert.match(mediaKind({ media: {}, photo: {} }), /عکس/);
  assert.equal(mediaKind({}), null);
});

test('shouldForceDocument only for shapes Telegram cannot rebuild', () => {
  assert.equal(shouldForceDocument(doc([])), true);
  assert.equal(shouldForceDocument(doc([{ className: 'DocumentAttributeSticker' }])), true);
  assert.equal(shouldForceDocument(doc([{ className: 'DocumentAttributeAudio', voice: true }])), false);
  assert.equal(shouldForceDocument(doc([{ className: 'DocumentAttributeVideo', roundMessage: true }])), false);
});

test('ttl detection is limited to photo/document media', () => {
  assert.equal(ttlSeconds({ media: { className: 'MessageMediaPhoto', ttlSeconds: 5 } }), 5);
  assert.equal(ttlSeconds({ media: { className: 'MessageMediaGeo', ttlSeconds: 5 } }), 0);
  assert.equal(ttlSeconds({ media: { className: 'MessageMediaPhoto' } }), 0);
  assert.equal(isSelfDestruct({ media: { className: 'MessageMediaPhoto', ttlSeconds: 1 } }), true);
  assert.equal(isSelfDestruct({ media: { className: 'MessageMediaPhoto' } }), false);
});

test('isExpiring also covers chat-level auto-delete timers', () => {
  assert.equal(isExpiring({ media: { className: 'MessageMediaDocument' }, ttlPeriod: 86400 }), true);
  assert.equal(isExpiring({ media: { className: 'MessageMediaDocument' } }), false);
});

test('mediaSize coerces whatever numeric shape arrives', () => {
  assert.equal(mediaSize({ file: { size: 1234 } }), 1234);
  assert.equal(mediaSize({ document: { size: 99 } }), 99);
  assert.equal(mediaSize({ file: { size: 'nope' } }), 0);
  assert.equal(mediaSize(null), 0);
});

test('filenames are sanitized against traversal and control chars', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), '_.._etc_passwd', 'no separators, no leading dots');
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitizeFilename('   '), 'file');
  assert.equal(sanitizeFilename('x'.repeat(300)).length, 120);
  assert.equal(sanitizeFilename('bad\u0007name.txt'), 'bad_name.txt', 'control chars are stripped');
  assert.equal(sanitizeFilename('tab\there.txt'), 'tab_here.txt');
  // A dash is an ordinary character. The class used to start with a literal `-`
  // instead of the control range, so every hyphenated name came out mangled.
  assert.equal(sanitizeFilename('my-holiday-video.mp4'), 'my-holiday-video.mp4');
});

test('guessFilename prefers the declared name, then mime, then type', () => {
  assert.equal(guessFilename(doc([{ className: 'DocumentAttributeFilename', fileName: 'a b.pdf' }])), 'a b.pdf');
  assert.equal(guessFilename(doc([], { mimeType: 'video/webm' })), 'elegram_0.webm');
  assert.equal(guessFilename({ media: {}, photo: {}, id: 7 }), 'photo_7.jpg');
});

test('buildMessageLink handles usernames, channels and bare ids', () => {
  assert.equal(buildMessageLink({ id: 5, chat: { username: 'dur' } }), 'https://t.me/dur/5');
  assert.equal(buildMessageLink({ id: 5, chatId: '-1001234' }), 'https://t.me/c/1234/5');
  assert.equal(buildMessageLink({ id: 5, chatId: '777' }), 'tg://openmessage?user_id=777&message_id=5');
  assert.equal(buildMessageLink({ chatId: '777' }), '');
});

test('idStr survives BigInt-like ids', () => {
  assert.equal(idStr({ toString: () => '99' }), '99');
  assert.equal(idStr(null), '');
  assert.equal(idStr(10n), '10');
});

test('displayName falls back through title, name, username, id', () => {
  assert.equal(displayName({ title: 'Chan' }), 'Chan');
  assert.equal(displayName({ firstName: 'A', lastName: 'B' }), 'A B');
  assert.equal(displayName({ username: 'u' }), 'u');
  assert.equal(displayName({ id: 42 }), '42');
  assert.equal(displayName(null), '');
});
