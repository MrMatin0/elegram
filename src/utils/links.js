/**
 * Telegram message-link parsing.
 *
 * A channel with saving disabled (`noforwards`) almost always forbids posting
 * too, so there is no message of ours to reply to and nowhere to type a
 * command: `/save <link>` is the only way to name a target there. Everything
 * here is pure string work — no client, no network — so it is fully unit tested.
 */

/** Why a `/save <link>` could not be turned into a message. Cards branch on these. */
export const LINK_FAILURES = Object.freeze({
  INVALID: 'invalid',   // not a Telegram message link at all
  PEER: 'peer',         // the chat itself is out of reach
  MESSAGE: 'message',   // the chat is fine, that message id is not
});

const HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog', 'telesco.pe']);

/** First path segments that are never a channel username. */
const RESERVED = new Set([
  'c', 's', 'joinchat', 'addstickers', 'addemoji', 'addtheme', 'setlanguage',
  'proxy', 'socks', 'share', 'iv', 'login', 'confirmphone', 'bg', 'invoice',
  'giftcode', 'boost', 'contact', 'nft', 'blog', 'apps', 'm',
]);

const USERNAME = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const LINK_HINT = /^(?:tg:\/\/|(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog|telesco\.pe)\/)/i;

const posInt = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
};

/** Links get pasted wrapped in quotes or brackets, or with a trailing full stop. */
const unwrap = (value) =>
  String(value ?? '')
    .trim()
    .replace(/^[<([«"'`]+/, '')
    .replace(/[>)\]»"'`.,;:!?؟؛،]+$/, '')
    .trim();

/** A private channel id is kept marked, exactly as teleproto reports chat ids. */
const markChannel = (channelId) => Number(`-100${channelId}`);

/** True when the text was *meant* as a link, so a parse failure is worth reporting. */
export function looksLikeMessageLink(value) {
  return LINK_HINT.test(unwrap(value));
}

/**
 * `tg://` deep links — what Telegram Desktop copies for chats without a
 * username, and what our own captions emit for private peers.
 */
function fromDeepLink(url) {
  const action = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase();
  const query = url.searchParams;
  const messageId = posInt(query.get('post') ?? query.get('message_id') ?? query.get('id'));
  if (!messageId) return null;
  const threadId = posInt(query.get('thread') ?? query.get('topic'));

  if (action === 'resolve') {
    const username = String(query.get('domain') ?? '').trim();
    if (!USERNAME.test(username)) return null;
    return { kind: 'public', target: username, username, messageId, threadId };
  }

  if (action === 'privatepost') {
    const channelId = posInt(query.get('channel'));
    if (!channelId) return null;
    return { kind: 'private', target: markChannel(channelId), channelId: String(channelId), messageId, threadId };
  }

  if (action === 'openmessage') {
    const userId = posInt(query.get('user_id'));
    if (userId) return { kind: 'user', target: userId, messageId, threadId: 0 };
    const chatId = posInt(query.get('chat_id'));
    if (chatId) return { kind: 'chat', target: -chatId, messageId, threadId: 0 };
    const channelId = posInt(query.get('channel_id'));
    if (channelId) {
      return { kind: 'private', target: markChannel(channelId), channelId: String(channelId), messageId, threadId: 0 };
    }
  }

  return null;
}

/**
 * Parses any shape of Telegram post link into a peer + message id.
 *
 * Understood forms:
 *   https://t.me/channel/123          public channel or group
 *   https://t.me/channel/45/123       topic / thread — the *last* id is the post
 *   https://t.me/c/1234567890/123     private channel (id without the -100)
 *   https://t.me/s/channel/123        web-preview link
 *   t.me/channel/123                  scheme optional
 *   tg://resolve?domain=channel&post=123
 *   tg://privatepost?channel=1234567890&post=123
 *   tg://openmessage?user_id=123&message_id=45
 *
 * `?comment=` and `?single` are ignored on purpose: the post itself is what the
 * user asked us to archive.
 *
 * @returns {{kind: string, target: string|number, messageId: number, threadId: number}|null}
 */
export function parseMessageLink(input) {
  const raw = unwrap(input);
  if (!raw) return null;

  let url;
  try {
    url = new URL(HAS_SCHEME.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  if (url.protocol === 'tg:') return fromDeepLink(url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (!HOSTS.has(host)) return null;

  let segments = url.pathname.split('/').filter(Boolean);
  // `/s/<channel>/<id>` is the same message, behind the web preview.
  if (segments[0]?.toLowerCase() === 's' && segments.length > 1) segments = segments.slice(1);
  if (!segments.length) return null;

  const head = segments[0].toLowerCase();

  if (head === 'c') {
    const channelId = posInt(segments[1]);
    const ids = segments.slice(2).map(posInt).filter(Boolean);
    const messageId = ids.length ? ids[ids.length - 1] : posInt(url.searchParams.get('post'));
    if (!channelId || !messageId) return null;
    return {
      kind: 'private',
      target: markChannel(channelId),
      channelId: String(channelId),
      messageId,
      threadId: ids.length > 1 ? ids[0] : 0,
    };
  }

  if (RESERVED.has(head)) return null;

  const username = segments[0];
  if (!USERNAME.test(username)) return null;
  const ids = segments.slice(1).map(posInt).filter(Boolean);
  const messageId = ids.length ? ids[ids.length - 1] : posInt(url.searchParams.get('post'));
  if (!messageId) return null;
  return {
    kind: 'public',
    target: username,
    username,
    messageId,
    threadId: ids.length > 1 ? ids[0] : 0,
  };
}
