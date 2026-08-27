import { LINK_FAILURES, parseMessageLink } from '../utils/links.js';
import { TARGET_FAILURES, parseTarget, peerKey } from '../utils/targets.js';
import { LruMap } from '../utils/lru.js';
import { withRetry } from '../utils/retry.js';
import { displayName, idStr } from './mediaInfo.js';
import { log, errText } from '../utils/logger.js';

/**
 * Turning user-typed text into something Telegram can address.
 *
 *   `.save <link>`      -> a concrete message
 *   `.mirror <target>`  -> a chat key, for a chat we may not be able to post in
 *
 * This is the whole point of both forms: in a channel with forwarding and saving
 * disabled there is nothing of ours to reply to and nowhere to type a command,
 * so the user names the target instead and we go find it ourselves.
 */

const PEER_CACHE_LIMIT = 200;
const DIALOG_SCAN_LIMIT = 500;

// One process talks to exactly one account, so a module-level cache is safe and
// saves a `resolveUsername` round trip on every repeated /save of a channel.
const peerCache = new LruMap(PEER_CACHE_LIMIT);

/**
 * Last resort for a private id: teleproto can only build an input peer for an
 * entity it has already seen, and a fresh StringSession has seen nothing. One
 * dialog walk finds the chat *and* fills that cache, which beats failing on a
 * channel the user is plainly a member of.
 *
 * @param pick called per dialog; the first truthy return wins.
 */
async function scanDialogs(client, pick) {
  try {
    for await (const dialog of client.iterDialogs({ limit: DIALOG_SCAN_LIMIT })) {
      const found = pick(dialog);
      if (found) return found;
    }
  } catch (error) {
    log.debug('[lookup] پیمایش دیالوگ‌ها ناموفق بود:', errText(error));
  }
  return null;
}

async function findInDialogs(client, marked) {
  const wanted = String(marked);
  return scanDialogs(client, (dialog) =>
    (String(dialog?.id) === wanted ? dialog.inputEntity ?? dialog.entity ?? null : null));
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

// ------------------------------------------------------------------- chat keys

/** An entry already in a bucket, matched by key, username or title. */
export function findStoredChat(store, bucket, parsed) {
  if (typeof store?.entries !== 'function' || !bucket || !parsed) return null;
  const keys = new Set(parsed.candidates ?? []);
  if (parsed.key) keys.add(parsed.key);
  const named = String(parsed.username || parsed.label || '').replace(/^@+/, '').toLowerCase();

  for (const [key, value] of store.entries(bucket)) {
    if (keys.has(String(key))) return [key, value];
    if (!named) continue;
    if (String(value?.username ?? '').toLowerCase() === named) return [key, value];
    if (String(value?.title ?? '').toLowerCase() === named) return [key, value];
  }
  return null;
}

async function findEntity(client, parsed) {
  try {
    const found = await client.getEntity(parsed.target);
    if (found) return found;
  } catch (error) {
    log.debug('[lookup] یافتن چت هدف ناموفق بود:', errText(error));
  }
  // A username that Telegram refuses to resolve may still be a chat we are in.
  const wanted = new Set(parsed.candidates ?? []);
  if (parsed.key) wanted.add(parsed.key);
  const handle = String(parsed.username ?? '').toLowerCase();
  if (!wanted.size && !handle) return null;
  return scanDialogs(client, (dialog) => {
    const id = idStr(dialog?.id);
    if (id && wanted.has(id)) return dialog.entity ?? dialog.inputEntity ?? null;
    const name = String(dialog?.entity?.username ?? '').toLowerCase();
    return handle && name === handle ? dialog.entity ?? null : null;
  });
}

/**
 * Turns `@channel`, `-1001234567890`, `t.me/channel/12` … into the chat key the
 * message handlers compare `msg.chatId` against.
 *
 * `preferStored` is for the `off` direction: a chat we were kicked from, or that
 * was deleted, can no longer be resolved — and that is exactly when being able
 * to drop it from the list matters. A key already in the bucket therefore wins
 * over any network lookup.
 *
 * @returns {Promise<{chatKey?: string, title?: string, username?: string, stored?: boolean, parsed?: object, failure?: string}>}
 */
export async function resolveTargetChat(client, input, { store = null, bucket = '', preferStored = false } = {}) {
  const parsed = parseTarget(input);
  if (!parsed) return { failure: TARGET_FAILURES.INVALID };

  const fromStore = () => {
    const hit = findStoredChat(store, bucket, parsed);
    if (!hit) return null;
    return {
      chatKey: hit[0],
      title: hit[1]?.title || parsed.label,
      username: hit[1]?.username || parsed.username || '',
      stored: true,
      parsed,
    };
  };

  if (preferStored) {
    const hit = fromStore();
    if (hit) return hit;
  }

  const entity = await findEntity(client, parsed);
  if (entity) {
    const chatKey = peerKey(entity);
    if (chatKey) {
      return {
        chatKey,
        title: displayName(entity) || parsed.label,
        username: String(entity.username ?? parsed.username ?? ''),
        entity,
        parsed,
      };
    }
  }

  // A marked id needs no entity: mirroring only ever compares it to `msg.chatId`,
  // so a channel this session has never seen can still be subscribed to.
  if (parsed.key) return { chatKey: parsed.key, title: parsed.label, username: '', parsed };

  return fromStore() ?? { failure: TARGET_FAILURES.PEER, parsed };
}

/** Exposed for tests and for a clean restart between sessions. */
export function clearPeerCache() {
  peerCache.clear();
}
