import { LINK_FAILURES, USERNAME, parseMessageLink } from '../utils/links.js';
import { LruMap } from '../utils/lru.js';
import { withRetry } from '../utils/retry.js';
import { displayName, idStr } from './mediaInfo.js';
import { log, errText } from '../utils/logger.js';

/**
 * Turning a `.save <link>` into a real message, and a `.mirror <target>` into a
 * chat we are actually allowed to read.
 *
 * This is the whole point of the link form: in a channel with forwarding and
 * saving disabled there is nothing of ours to reply to, so the user pastes the
 * post link instead and we go fetch the message ourselves.
 */

const PEER_CACHE_LIMIT = 200;
const DIALOG_SCAN_LIMIT = 500;

/** Why a `.mirror <target>` could not be turned into a chat. */
export const CHAT_FAILURES = Object.freeze({
  INVALID: 'invalid',   // not a username and not a numeric id
  ACCESS: 'access',     // a plausible target this session cannot reach
});

// One process talks to exactly one account, so a module-level cache is safe and
// saves a `resolveUsername` round trip on every repeated .save of a channel.
const peerCache = new LruMap(PEER_CACHE_LIMIT);

/**
 * Last resort for a private id: teleproto can only build an input peer for an
 * entity it has already seen, and a fresh StringSession has seen nothing. One
 * dialog walk finds the chat *and* fills that cache, which beats failing on a
 * channel the user is plainly a member of.
 */
async function findInDialogs(client, marked) {
  const wanted = String(marked);
  try {
    for await (const dialog of client.iterDialogs({ limit: DIALOG_SCAN_LIMIT })) {
      if (String(dialog?.id) === wanted) return dialog.inputEntity ?? dialog.entity ?? null;
    }
  } catch (error) {
    log.debug('[lookup] پیمایش دیالوگ‌ها ناموفق بود:', errText(error));
  }
  return null;
}

async function resolvePeer(client, parsed) {
  const key = `${parsed.kind}:${parsed.target}`;
  const cached = peerCache.get(key);
  if (cached) return cached;

  let peer = null;
  try {
    peer = await client.getInputEntity(parsed.target);
  } catch (error) {
    log.debug('[lookup] ساخت peer از لینک ناموفق بود:', errText(error));
  }

  // Usernames resolve over the network, so a miss there is final; a numeric id
  // only ever misses the local cache and is still worth one dialog scan.
  if (!peer && typeof parsed.target === 'number') {
    peer = await findInDialogs(client, parsed.target);
  }

  if (peer) peerCache.set(key, peer);
  return peer;
}

/** teleproto pads unknown ids with MessageEmpty instead of leaving a hole. */
const isReal = (item) => Boolean(item?.id) && item.className !== 'MessageEmpty';

/**
 * @returns {Promise<{message?: object, peer?: object, parsed?: object, failure?: string}>}
 */
export async function resolveLinkedMessage(client, input) {
  const parsed = parseMessageLink(input);
  if (!parsed) return { failure: LINK_FAILURES.INVALID };

  const peer = await resolvePeer(client, parsed);
  if (!peer) return { failure: LINK_FAILURES.PEER, parsed };

  let message = null;
  try {
    const found = await withRetry(
      () => client.getMessages(peer, { ids: [parsed.messageId] }),
      { label: 'getMessages:link' },
    );
    const list = Array.isArray(found) ? found : [found];
    message = list.find(isReal) ?? null;
  } catch (error) {
    log.warn('[lookup] خواندن پیام از لینک ناموفق بود:', errText(error));
    return { failure: LINK_FAILURES.MESSAGE, parsed };
  }

  if (!message) return { failure: LINK_FAILURES.MESSAGE, parsed };
  return { message, peer, parsed };
}

// ---------------------------------------------------------------- chat targets

/**
 * The *marked* id of an entity, i.e. the form the update stream uses.
 *
 * `getEntity` hands back a bare id (a supergroup is `1234567890`), while
 * `message.chatId` reports the marked one (`-1001234567890`). The store is keyed
 * by whatever the updates produce, so an entity has to be converted before its
 * id can be compared with — or written next to — anything else.
 */
export function markedChatId(entity) {
  const id = idStr(entity?.id);
  if (!id || id === '0') return '';
  if (id.startsWith('-')) return id;
  const className = String(entity?.className ?? '');
  // Channel, ChannelForbidden — channels and supergroups share the -100 prefix.
  if (className.startsWith('Channel')) return `-100${id}`;
  // Chat, ChatForbidden, ChatEmpty — a basic group is only negated.
  if (className.startsWith('Chat')) return `-${id}`;
  return id;
}

const stripTarget = (value) =>
  String(value ?? '')
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?t\.me\//i, '')
    .replace(/^@+/, '')
    .replace(/\/+$/, '')
    .trim();

/**
 * Turns `@channel`, `channel`, `-1001234567890` or `1234567890` into a chat we
 * may actually operate on.
 *
 * Resolution goes through `getEntity`, which is also the authorization check:
 * it only succeeds for a peer this session can see. A target we cannot resolve
 * is reported, never guessed at — mirroring a chat we cannot read would just
 * produce a silent, permanently empty subscription.
 *
 * @returns {Promise<{chatKey?: string, title?: string, entity?: object, failure?: string}>}
 */
export async function resolveChat(client, input) {
  const raw = stripTarget(input);
  if (!raw) return { failure: CHAT_FAILURES.INVALID };

  const candidates = [];
  if (/^-?\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isSafeInteger(numeric) || numeric === 0) return { failure: CHAT_FAILURES.INVALID };
    candidates.push(numeric);
    // Channel ids get copied around without the -100 Telegram marks them with.
    if (numeric > 0) candidates.push(Number(`-100${raw}`));
  } else if (USERNAME.test(raw)) {
    candidates.push(raw);
  } else {
    return { failure: CHAT_FAILURES.INVALID };
  }

  for (const candidate of candidates) {
    let entity = null;
    try {
      entity = await client.getEntity(candidate);
    } catch (error) {
      log.debug('[lookup] هدف قابل دسترسی نبود:', errText(error));
      continue;
    }
    const chatKey = markedChatId(entity);
    if (!chatKey) continue;
    return { chatKey, title: displayName(entity) || String(candidate), entity };
  }

  return { failure: CHAT_FAILURES.ACCESS };
}

/** Exposed for tests and for a clean restart between sessions. */
export function clearPeerCache() {
  peerCache.clear();
}
