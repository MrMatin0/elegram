/**
 * Turning "that post over there" into a list of media messages.
 *
 * Both entry points need exactly this and nothing else: the `.save <link>`
 * command typed from the self account, and the panel's "save by link" prompt.
 * Keeping it here means an album is collected the same way from both — the last
 * copy of this logic lived inside the command handler, where the panel could not
 * reach it without importing a whole Telegram event flow.
 */
import { resolveLinkedMessage } from './lookup.js';
import { idStr } from './mediaInfo.js';
import { log, errText } from '../utils/logger.js';

// A Telegram album holds at most 10 items, so a narrow id window is enough.
const ALBUM_SPAN = 10;

/**
 * Collects every sibling of an album.
 *
 * Asking for a hand-built id range via `getMessages({ ids })` pulls up to 21
 * mostly-nonexistent ids and throws on some peers. Walking history around the
 * anchor is both cheaper and correct.
 */
export async function collectAlbum(client, peer, anchor) {
  const groupId = idStr(anchor?.groupedId);
  if (!groupId) return [anchor];

  const found = new Map([[anchor.id, anchor]]);
  try {
    for await (const item of client.iterMessages(peer, {
      limit: ALBUM_SPAN * 3,
      offsetId: anchor.id + ALBUM_SPAN + 1,
      minId: Math.max(0, anchor.id - ALBUM_SPAN - 1),
    })) {
      if (item?.media && idStr(item.groupedId) === groupId) found.set(item.id, item);
    }
  } catch (error) {
    log.warn('خواندن آلبوم ناموفق بود؛ فقط همان پیام آرشیو می‌شود.', errText(error));
  }
  return [...found.values()].sort((a, b) => a.id - b.id);
}

/** Media messages of an anchor, album-aware and sorted. */
export async function mediaOf(client, peer, anchor) {
  const targets = anchor?.groupedId ? await collectAlbum(client, peer, anchor) : [anchor];
  return targets.filter((item) => item?.media).sort((a, b) => a.id - b.id);
}

/**
 * @returns {Promise<{media?: object[], peer?: object, failure?: string, empty?: boolean}>}
 *   `failure` is a LINK_FAILURES value; `empty` means the post carried no media.
 */
export async function mediaFromLink(client, input) {
  const found = await resolveLinkedMessage(client, input);
  if (found.failure) return { failure: found.failure };
  const media = await mediaOf(client, found.peer, found.message);
  if (!media.length) return { empty: true, peer: found.peer };
  return { media, peer: found.peer };
}
