import * as cards from '../ui/cards.js';
import { faDate } from '../utils/format.js';
import { LruMap, LruSet } from '../utils/lru.js';
import { idStr } from './mediaInfo.js';
import { log, errText } from '../utils/logger.js';

const SNAPSHOT_LIMIT = 4000;
// Telegram punishes bursts of *writes* far harder than reads, and a mirrored
// group can easily produce messages faster than we are allowed to archive them.
// Everything therefore goes through one serialized lane with a floor between
// calls; ordering is a feature here, not a side effect.
const MIN_SEND_GAP_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

/** `message` is the raw text; `text` is teleproto's formatted view of it. */
const textOf = (msg) => String(msg?.message ?? msg?.text ?? '').trim();

/**
 * Live message mirroring.
 *
 * For every chat the user marked with `.mirror`, the first sighting of a message
 * is archived **as it is** — a forward when Telegram allows one, a byte-for-byte
 * copy when it does not. Nothing of ours is added to that copy: no card, no
 * caption, no header.
 *
 * Whatever happens to the message afterwards (an edit, a delete-for-everyone) is
 * reported as a short notice *in reply to* that copy, so one archived message
 * carries its own history in a thread.
 *
 * The `source_chat_id + source_message_id → saved_message_id` pair is the whole
 * mechanism, and it is written to the store, not just to memory: an edit that
 * lands after a restart still finds its anchor.
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
    // Deletes resolved from disk have no snapshot to mark, so they get their own
    // de-duplication: Telegram happily replays an update after a reconnect.
    this.reported = new LruSet(limit);
    // cacheKey → in-flight archive. An edit or delete that arrives while the
    // copy is still being written waits for it instead of losing its anchor.
    this.inFlight = new Map();
    this.stats = { captured: 0, edits: 0, deletions: 0 };
    this._chain = Promise.resolve();
    this._nextAt = 0;
  }

  // ---------------------------------------------------------------------- lane

  /** One serialized, rate-floored lane for every Telegram write. Never throws. */
  _lane(run) {
    const task = async () => {
      const wait = this._nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      this._nextAt = Date.now() + this.sendGapMs;
      try {
        return await run();
      } catch (error) {
        log.warn('[mirror] نوشتن در آرشیو ناموفق بود:', errText(error));
        return null;
      }
    };
    this._chain = this._chain.then(task, task);
    return this._chain;
  }

  // ------------------------------------------------------------------ metadata

  key(chatKey, id) {
    return `${chatKey || '?'}|${id}`;
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

  /**
   * The archived copy a notice must reply to.
   *
   * The await is the race fix: a delete-for-everyone can beat our own upload,
   * and without waiting the notice would drift off on its own instead of
   * hanging under the copy it belongs to.
   */
  async _anchor(chatKey, id, snapshot = null) {
    if (snapshot?.savedId) return snapshot.savedId;
    const waiting = this.inFlight.get(this.key(chatKey, id));
    if (waiting) await waiting;
    return snapshot?.savedId || this.store.savedIdFor(chatKey, id) || null;
  }

  // -------------------------------------------------------------------- events

  /**
   * First sighting of a message in a mirrored chat.
   * @returns the snapshot, or null when there was nothing new to mirror.
   */
  async capture(msg) {
    try {
      const chatKey = idStr(msg?.chatId);
      const id = Number(msg?.id);
      if (!chatKey || !Number.isFinite(id) || id <= 0) return null;
      // Telegram replays updates after a reconnect; the first copy wins.
      const cacheKey = this.key(chatKey, id);
      if (this.snapshots.has(cacheKey)) return null;

      const snapshot = {
        cacheKey,
        id,
        chatKey,
        text: textOf(msg),
        revisions: 0,
        deleted: false,
        savedId: null,
      };
      this.snapshots.set(cacheKey, snapshot);
      this._index(snapshot);
      this.stats.captured += 1;

      const job = this._lane(() => this.archiver.archiveAsIs(msg)).then((sent) => {
        const savedId = Number(sent?.id);
        snapshot.savedId = Number.isFinite(savedId) && savedId > 0 ? savedId : null;
        if (snapshot.savedId) this.store.rememberMirror(chatKey, id, snapshot.savedId);
        return snapshot.savedId;
      });
      this.inFlight.set(cacheKey, job);
      try {
        await job;
      } finally {
        this.inFlight.delete(cacheKey);
      }
      return snapshot;
    } catch (error) {
      log.error('[mirror] ثبت پیام ناموفق بود:', errText(error));
      return null;
    }
  }

  /** A short notice, in reply to the archived copy. Never throws. */
  _notify(text, replyTo) {
    return this._lane(() => this.archiver.sendText(text, replyTo ? { replyTo } : undefined));
  }

  /**
   * A message we already archived was edited.
   *
   * Telegram also emits an edit update for churn that changes no text at all
   * (pinning, media re-render, our own status-card edits), so an unchanged body
   * is dropped instead of posting a notice that says nothing.
   */
  async onEdit(msg) {
    try {
      const chatKey = idStr(msg?.chatId);
      const id = Number(msg?.id);
      if (!chatKey || !Number.isFinite(id) || id <= 0) return null;
      if (!this.store.isMirror(chatKey)) return null;

      const snapshot = this.get(chatKey, id);
      const next = textOf(msg);
      if (snapshot) {
        if (snapshot.deleted) return null;
        if (next === snapshot.text) return null;
        snapshot.text = next;
        snapshot.revisions += 1;
      }

      const anchor = await this._anchor(chatKey, id, snapshot);
      // No snapshot and no stored pair means this message was never mirrored.
      if (!snapshot && !anchor) return null;

      this.stats.edits += 1;
      await this._notify(cards.mirrorEditNotice({ at: faDate(new Date(), this.timezone), text: next }), anchor);
      return snapshot ?? { chatKey, id, savedId: anchor, text: next, revisions: 1, deleted: false };
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
        if (snapshot) {
          if (snapshot.deleted) continue;
          if (!this.store.isMirror(snapshot.chatKey)) continue;
          // Claimed *before* any await, so a replayed update is a no-op.
          snapshot.deleted = true;
          this.reported.add(snapshot.cacheKey);
          hits.push(snapshot);
          continue;
        }

        // A restart drops the snapshots but not the stored pairs, so a delete
        // can still be reported against the copy it belongs to.
        const savedId = chatKey ? this.store.savedIdFor(chatKey, id) : 0;
        const found = savedId
          ? { chatKey, id, savedId }
          : (chatKey ? null : this.store.findMirrorById(id));
        if (!found?.savedId) continue;
        if (!this.store.isMirror(found.chatKey)) continue;
        if (this.reported.add(this.key(found.chatKey, found.id))) continue;
        hits.push({ ...found, deleted: true, revisions: 0, fromStore: true });
      }
      if (!hits.length) return [];

      this.stats.deletions += hits.length;
      for (const hit of hits) {
        const anchor = hit.fromStore ? hit.savedId : await this._anchor(hit.chatKey, hit.id, hit);
        await this._notify(cards.mirrorDeleteNotice({ at: faDate(new Date(), this.timezone) }), anchor);
      }
      return hits;
    } catch (error) {
      log.error('[mirror] ثبت حذف ناموفق بود:', errText(error));
      return [];
    }
  }
}
