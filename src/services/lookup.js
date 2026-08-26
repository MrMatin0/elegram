import { LINK_FAILURES, parseMessageLink } from '../utils/links.js';
import { LruMap } from '../utils/lru.js';
import { withRetry } from '../utils/retry.js';
import { log, errText } from '../utils/logger.js';

/**
 * Turning a `/save <link>` into a real message.
 *
 * This is the whole point of the link form: in a channel with forwarding and
 * saving disabled there is nothing of ours to reply to, so the user pastes the
 * post link instead and we go fetch the message ourselves.
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

/** Exposed for tests and for a clean restart between sessions. */
export function clearPeerCache() {
  peerCache.clear();
}
