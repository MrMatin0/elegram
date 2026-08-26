import * as cards from '../ui/cards.js';
import { faDate } from '../utils/format.js';
import { LruMap } from '../utils/lru.js';
import { buildMessageLink, displayName, idStr, mediaKind } from './mediaInfo.js';
import { log, errText } from '../utils/logger.js';

const SNAPSHOT_LIMIT = 4000;
const TITLE_CACHE_LIMIT = 300;
// Telegram punishes bursts of *sends* far harder than edits, and a mirrored
// group can easily produce messages faster than we are allowed to write them.
// Every card therefore goes through one serialized lane with a floor between
// sends; ordering is a feature here, not a side effect.
const MIN_SEND_GAP_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

/** `message` is the raw text; `text` is teleproto's formatted view of it. */
const textOf = (msg) => String(msg?.message ?? msg?.text ?? '').trim();

const secondsOf = (msg) => Number(msg?.date) || Math.floor(Date.now() / 1000);

/**
 * Live message mirroring.
 *
 * For every chat the user marked with `.mirror on`, the first sighting of a
 * message is copied into the archive. That copy is the *original*: whatever
 * happens to the message afterwards — an edit, a delete-for-everyone — is
 * reported as a reply to that copy instead of overwriting it.
 *
 * Why snapshots instead of re-reading the message: once Telegram delivers
 * `updateDeleteMessages` the message is already gone, so the only version that
 * still exists anywhere is the one we kept in memory. Hence a bounded LRU that
 * is written on sight and never on demand.
 */
export class MirrorService {
  constructor(client, store, archiver, {
    timezone,
    myId = '',
    limit = SNAPSHOT_LIMIT,
    sendGapMs = MIN_SEND_GAP_MS,
  } = {}) {
    this.client = client;
    this.store = store;
    this.archiver = archiver;
    this.timezone = timezone;
    this.myId = idStr(myId);
    this.sendGapMs = Math.max(0, Number(sendGapMs) || 0);
    this.snapshots = new LruMap(limit);
    // `updateDeleteMessages` carries no peer for users and basic groups, where
    // message ids are unique per account — so a plain id index closes that gap.
    this.byMessageId = new LruMap(limit);
    this.titles = new LruMap(TITLE_CACHE_LIMIT);
    this.stats = { captured: 0, edits: 0, deletions: 0 };
    this._chain = Promise.resolve();
    this._nextSendAt = 0;
  }

  // ------------------------------------------------------------------- sending

  /** One serialized, rate-floored lane for every mirror card. Never throws. */
  send(text, replyTo = null) {
    const run = async () => {
      if (!text) return null;
      const wait = this._nextSendAt - Date.now();
      if (wait > 0) await sleep(wait);
      this._nextSendAt = Date.now() + this.sendGapMs;
      try {
        return await this.archiver.sendText(text, replyTo ? { replyTo } : undefined);
      } catch (error) {
        log.warn('[mirror] نوشتن کارت آینه ناموفق بود:', errText(error));
        return null;
      }
    };
    this._chain = this._chain.then(run, run);
    return this._chain;
  }

  // ------------------------------------------------------------------ metadata

  key(chatKey, id) {
    return `${chatKey || '?'}|${id}`;
  }

  async chatTitle(msg, chatKey) {
    if (!chatKey) return '';
    const cached = this.titles.get(chatKey);
    if (cached != null) return cached;
    let title = '';
    try {
      title = msg?.chat ? displayName(msg.chat) : '';
    } catch {
      title = '';
    }
    if (!title) {
      try {
        title = displayName(await this.client.getEntity(chatKey));
      } catch {
        title = '';
      }
    }
    this.titles.set(chatKey, title);
    return title;
  }

  /** Empty for a channel post or a DM, where the chat *is* the sender. */
  async senderName(msg, chatKey) {
    const senderId = idStr(msg?.senderId);
    if (!senderId || senderId === chatKey) return '';
    let sender = null;
    try {
      sender = msg.sender ?? null;
    } catch {
      sender = null;
    }
    if (!sender) {
      try {
        sender = await this.client.getEntity(senderId);
      } catch {
        sender = null;
      }
    }
    return sender ? displayName(sender) : `کاربر ${senderId}`;
  }

  _index(snapshot) {
    const id = String(snapshot.id);
    const keys = this.byMessageId.get(id) ?? [];
    if (!keys.includes(snapshot.cacheKey)) keys.push(snapshot.cacheKey);
    this.byMessageId.set(id, keys);
  }

  /** Newest snapshot carrying this id, for delete updates with no peer. */
  _findById(id) {
    const keys = this.byMessageId.get(String(id));
    if (!keys?.length) return null;
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const snapshot = this.snapshots.get(keys[index]);
      if (snapshot && !snapshot.deleted) return snapshot;
    }
    return null;
  }

  get(chatKey, id) {
    return this.snapshots.get(this.key(chatKey, id)) ?? null;
  }

  // -------------------------------------------------------------------- events

  /**
   * First sighting of a message in a mirrored chat.
   * @returns the snapshot, or null when there was nothing new to mirror.
   */
  async capture(msg) {
    try {
      const chatKey = idStr(msg?.chatId);
      if (!chatKey || !msg?.id) return null;
      // Telegram replays updates after a reconnect; the first copy wins.
      const cacheKey = this.key(chatKey, msg.id);
      if (this.snapshots.has(cacheKey)) return null;

      const text = textOf(msg);
      const snapshot = {
        cacheKey,
        id: msg.id,
        chatKey,
        chatTitle: await this.chatTitle(msg, chatKey),
        senderName: await this.senderName(msg, chatKey),
        kind: msg?.media ? mediaKind(msg) ?? '' : '',
        date: faDate(new Date(secondsOf(msg) * 1000), this.timezone),
        link: buildMessageLink(msg),
        original: text,
        text,
        revisions: 0,
        deleted: false,
        cardId: null,
      };
      this.snapshots.set(cacheKey, snapshot);
      this._index(snapshot);
      this.stats.captured += 1;

      const card = await this.send(cards.mirrorCard(snapshot));
      snapshot.cardId = card?.id ?? null;
      return snapshot;
    } catch (error) {
      log.error('[mirror] ثبت پیام ناموفق بود:', errText(error));
      return null;
    }
  }

  /**
   * A message we already mirrored was edited.
   *
   * Telegram also emits an edit update for churn that changes no text at all
   * (pinning, media re-render, our own status-card edits), so an unchanged body
   * is dropped instead of posting a card that says nothing.
   */
  async onEdit(msg) {
    try {
      const chatKey = idStr(msg?.chatId);
      const snapshot = this.get(chatKey, msg?.id);
      if (!snapshot || snapshot.deleted) return null;
      if (!this.store.isMirror(chatKey)) return null;

      const next = textOf(msg);
      const previous = snapshot.text;
      if (next === previous) return null;

      snapshot.revisions += 1;
      snapshot.text = next;
      this.stats.edits += 1;

      await this.send(cards.mirrorEditCard({
        chatTitle: snapshot.chatTitle,
        senderName: snapshot.senderName,
        link: snapshot.link,
        original: snapshot.original,
        previous,
        next,
        revisions: snapshot.revisions,
        at: faDate(new Date(), this.timezone),
      }), snapshot.cardId);
      return snapshot;
    } catch (error) {
      log.error('[mirror] ثبت ویرایش ناموفق بود:', errText(error));
      return null;
    }
  }

  /**
   * Messages were deleted. `chatKey` is empty for users and basic groups, where
   * the update carries no peer at all.
   */
  async onDelete(ids, chatKey = '') {
    try {
      const list = Array.isArray(ids) ? ids : [ids];
      const hits = [];
      for (const raw of list) {
        const id = Number(raw);
        if (!Number.isFinite(id) || id <= 0) continue;
        const snapshot = chatKey ? this.get(chatKey, id) : this._findById(id);
        // No snapshot means we never mirrored it (our own commands land here).
        if (!snapshot || snapshot.deleted) continue;
        if (!this.store.isMirror(snapshot.chatKey)) continue;
        snapshot.deleted = true;
        hits.push(snapshot);
      }
      if (!hits.length) return [];

      this.stats.deletions += hits.length;
      for (const snapshot of hits) {
        await this.send(cards.mirrorDeleteCard({
          ...snapshot,
          at: faDate(new Date(), this.timezone),
        }), snapshot.cardId);
      }
      return hits;
    } catch (error) {
      log.error('[mirror] ثبت حذف ناموفق بود:', errText(error));
      return [];
    }
  }
}
