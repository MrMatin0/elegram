/**
 * Naming a chat you cannot type in.
 *
 * `.auto on` and `.mirror on` had one hard requirement: they must be sent
 * *inside* the chat they switch on. That is exactly what a broadcast channel —
 * and any group that does not let you write — forbids, so both features were
 * unusable precisely where they matter most. Both toggles therefore also take
 * the chat as an argument:
 *
 *   .mirror @channel                .mirror -1001234567890
 *   .mirror off @channel            .mirror off 1234567890
 *
 * Everything here is pure string work — no client, no network — so it stays
 * unit-testable, exactly like `links.js`.
 *
 * The key this module produces has to come out byte-identical to
 * `idStr(msg.chatId)` on an incoming update. Anything else is a subscription
 * that nothing ever matches: the feature would look enabled and do nothing.
 */

/** Why a target could not be turned into a chat key. Cards branch on these. */
export const TARGET_FAILURES = Object.freeze({
  INVALID: 'invalid', // not a username, id or chat link at all
  PEER: 'peer',       // well-formed, but this account cannot reach that chat
});

const USERNAME = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;
// Telegram ids are far longer than 5 digits; a shorter number is a typo, not a peer.
const NUMERIC = /^-?\d{5,20}$/;
const HOST = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog|telesco\.pe)\//i;

/** First path segments that are never a chat username. */
const RESERVED = new Set([
  'c', 's', 'joinchat', 'addstickers', 'addemoji', 'addtheme', 'setlanguage',
  'proxy', 'socks', 'share', 'iv', 'login', 'confirmphone', 'bg', 'invoice',
  'giftcode', 'boost', 'contact', 'nft', 'blog', 'apps', 'm',
]);

/** Targets get pasted wrapped in quotes or brackets, or with a trailing dot. */
const clean = (value) =>
  String(value ?? '')
    .trim()
    .replace(/^[<([«"'`]+/, '')
    .replace(/[>)\]»"'`.,;:!?؟؛،]+$/, '')
    .trim();

const digits = (value) => {
  const raw = String(value ?? '').trim();
  return /^\d{5,20}$/.test(raw) ? raw : '';
};

const channelTarget = (id) => ({
  kind: 'channel',
  target: Number(`-100${id}`),
  key: `-100${id}`,
  candidates: [`-100${id}`],
  username: '',
  label: `-100${id}`,
});

const usernameTarget = (username) => ({
  kind: 'username',
  target: username,
  key: '',
  candidates: [],
  username,
  label: `@${username}`,
});

/**
 * A marked id (`-100…` for channels, `-…` for basic groups) is already the shape
 * teleproto reports, so it works as a key on its own. A bare positive number is
 * ambiguous — user, basic group or channel — so every marked form becomes a
 * candidate and the entity lookup decides which one is real.
 */
function numericTarget(raw) {
  if (raw.startsWith('-100')) return channelTarget(raw.slice(4));
  if (raw.startsWith('-')) {
    return { kind: 'chat', target: Number(raw), key: raw, candidates: [raw], username: '', label: raw };
  }
  return {
    kind: 'id',
    target: Number(raw),
    key: '',
    candidates: [`-100${raw}`, `-${raw}`, raw],
    username: '',
    label: raw,
  };
}

/** `tg://` deep links — what Telegram Desktop copies for a chat it cannot name. */
function fromDeepLink(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const action = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase();
  const query = url.searchParams;

  if (action === 'resolve') {
    const username = String(query.get('domain') ?? '').trim();
    return USERNAME.test(username) ? usernameTarget(username) : null;
  }
  if (action === 'privatepost') {
    const id = digits(query.get('channel'));
    return id ? channelTarget(id) : null;
  }
  if (action === 'openmessage') {
    const channelId = digits(query.get('channel_id'));
    if (channelId) return channelTarget(channelId);
    const chatId = digits(query.get('chat_id'));
    if (chatId) return numericTarget(`-${chatId}`);
    const userId = digits(query.get('user_id'));
    if (userId) return numericTarget(userId);
  }
  return null;
}

/**
 * Parses whatever the user typed after a toggle into a peer reference.
 *
 * Understood forms:
 *   @channel · channel                    public username
 *   -1001234567890                        marked channel id (usable as-is)
 *   -1234567890                           marked basic-group id
 *   1234567890                            bare id, type decided on lookup
 *   https://t.me/channel · t.me/channel   chat link, with or without a post id
 *   https://t.me/c/1234567890             private channel link
 *   tg://resolve?domain=channel
 *
 * A trailing message or topic id is ignored on purpose: a toggle subscribes to a
 * *chat*, so pasting any post link from it is the friendliest possible input.
 *
 * @returns {{kind: string, target: string|number, key: string, candidates: string[], username: string, label: string}|null}
 */
export function parseTarget(input) {
  let raw = clean(input);
  if (!raw) return null;

  if (/^tg:\/\//i.test(raw)) return fromDeepLink(raw);

  raw = raw.replace(HOST, '');
  // `/s/<username>` is the same chat, behind the web preview.
  raw = raw.replace(/^s\//i, '');

  const priv = /^c\/(\d{5,20})(?:\/|$)/i.exec(raw);
  if (priv) return channelTarget(priv[1]);

  // Drop the query string, any trailing post/topic id, then the leading `@`.
  raw = raw.split(/[?#]/)[0].replace(/\/.*$/, '').replace(/^@+/, '').trim();
  if (!raw) return null;

  if (NUMERIC.test(raw)) return numericTarget(raw);
  if (RESERVED.has(raw.toLowerCase())) return null;
  if (USERNAME.test(raw)) return usernameTarget(raw);
  return null;
}

/**
 * The marked peer id of a resolved entity, exactly as `msg.chatId` reports it.
 *
 * `entity.id` is the *bare* id: a channel resolved by username reports
 * `1234567890`, while its messages arrive as `-1001234567890`. Storing the bare
 * form is the one mistake that leaves a subscription silently dead.
 */
export function peerKey(entity) {
  if (!entity) return '';
  const raw = entity.id ?? entity.channelId ?? entity.chatId ?? entity.userId;
  const id = raw == null ? '' : String(raw);
  if (!id || !/^-?\d+$/.test(id)) return '';
  if (id.startsWith('-')) return id; // already marked

  // Matched loosely on purpose: `Channel`, `ChannelForbidden`, `PeerChannel` and
  // `InputPeerChannel` all describe the same peer and all reach us here.
  const cls = String(entity.className ?? '');
  if (/Channel/.test(cls)) return `-100${id}`;
  if (/Chat/.test(cls)) return `-${id}`;
  if (/User/.test(cls)) return id;

  // Duck-typing, for builds that hand back plain objects with no className.
  if (entity.broadcast !== undefined || entity.megagroup !== undefined) return `-100${id}`;
  if (entity.participantsCount !== undefined || entity.title) return `-${id}`;
  return id;
}
