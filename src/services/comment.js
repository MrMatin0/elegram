// A *namespace* import, for exactly the reason `handlers/messages.js` uses one:
// a missing **named** export is a hard link-time failure in ESM, so a teleproto
// build that ships without the TL constructors we need must disable one feature
// instead of taking the whole bot down at startup.
import * as teleproto from 'teleproto';
import * as cards from '../ui/cards.js';
import { COMMAND_PATTERN } from '../constants.js';
import { renderComment } from '../utils/comment.js';
import { faDate } from '../utils/format.js';
import { LruMap, LruSet } from '../utils/lru.js';
import { sleep, withRetry } from '../utils/retry.js';
import { buildMessageLink, displayName, idStr } from './mediaInfo.js';
import { log, errText } from '../utils/logger.js';

const Api = teleproto?.Api ?? null;

const SEEN_LIMIT = 1024;
/** Thread targets, keyed by the post they belong to. */
const COPY_LIMIT = 512;
/** One linked-group peer per watched channel. */
const GROUP_LIMIT = 256;
/** Whatever the configuration says, a poll gap lives inside this window. */
const POLL_MIN_MS = 50;
const POLL_MAX_MS = 1000;
/** Every gap is this much longer than the one before: 150, 210, 294 … */
const POLL_GROWTH = 1.4;
/** Between two channels while warming up. Startup is not a race. */
const WARM_GAP_MS = 1200;

/**
 * Telegram publishes the post first and copies it into the linked group a moment
 * later, so an immediate lookup legitimately answers "no such message". That is
 * a race worth retrying; anything else is a permission or configuration problem
 * that no amount of waiting fixes.
 */
const RACE = /MSG_ID_INVALID|MESSAGE_ID_INVALID|CHANNEL_PRIVATE|CHAT_ID_INVALID/i;
/** Telegram lets you *read* a linked group you never joined, but not write in it. */
const NEEDS_JOIN = /USER_NOT_PARTICIPANT|CHAT_WRITE_FORBIDDEN|CHAT_GUEST_SEND_FORBIDDEN/i;

const textOf = (msg) => String(msg?.message ?? msg?.text ?? '').trim();

/** teleproto pads unknown ids with MessageEmpty instead of leaving a hole. */
const isReal = (item) => Boolean(item?.id) && item.className !== 'MessageEmpty';

/** `-100…` is how a channel id is written everywhere the user sees one. */
const bare = (value) => idStr(value).replace(/^-100/, '');
const marked = (value) => (bare(value) ? `-100${bare(value)}` : '');

/** Reading `msg.chat` can throw on a peer teleproto has not resolved yet. */
const chatOf = (msg) => {
  try {
    return msg?.chat ?? null;
  } catch {
    return null;
  }
};

/**
 * Who posted a message, as a bare channel id, or '' for anything that is not a
 * channel. Same defensive shape as `chatOf`: an unresolved peer can throw.
 */
const senderChannel = (msg) => {
  try {
    return bare(msg?.senderId ?? msg?.fromId?.channelId ?? '');
  } catch {
    return '';
  }
};

/** A broadcast *post*, not just any message that happened to arrive from here. */
export function isChannelPost(msg) {
  if (!msg) return false;
  if (msg.post === true) return true;
  return Boolean(chatOf(msg)?.broadcast);
}

/**
 * The first comment.
 *
 * For every channel the user configured with `.comment`, the moment a new post
 * is published its stored body is written as a reply in the channel's linked
 * discussion group — which is what a "comment" on a channel post actually is:
 * Telegram forwards the post into the linked group and every comment is a reply
 * to that copy.
 *
 * Being *first* is the whole feature, so the hot path is built around the one
 * thing we cannot control — how long Telegram takes to copy the post into the
 * linked group — and around never adding a millisecond of our own:
 *
 *   · **push before pull.** Once we are a member of the linked group, that copy
 *     arrives as an ordinary update. `noteCopy()` indexes it, so the common case
 *     needs *no* `GetDiscussionMessage` round trip at all: the comment is sent
 *     the instant the copy lands.
 *   · **tight polling as the fallback.** For groups we are not in, the lookup is
 *     retried on a small growing gap (150ms, 210ms …) inside a total deadline,
 *     instead of the old 1.2s/2.4s/3.6s ladder that lost the race by seconds.
 *   · **the send queue holds sends only.** Resolving the thread, writing the
 *     archive receipt and bumping counters all happen off the serialized lane,
 *     so post #2 no longer waits for post #1's paperwork.
 *   · **pay at startup.** `warmUp()` resolves and joins every configured
 *     channel's linked group up front, so the first post of a session is as fast
 *     as the tenth.
 *
 * Why an album needs care: a multi-item post arrives as N separate updates with
 * one shared `groupedId`. Keyed by post id it would earn N identical comments,
 * so the dedupe key is the group when there is one.
 */
export class FirstCommentService {
  constructor(client, store, archiver, {
    delayMs = 0,
    attempts = 12,
    join = true,
    timezone,
    report = true,
    pollMs = 150,
    timeoutMs = 10000,
    sendGapMs = 400,
    warm = true,
  } = {}) {
    this.client = client;
    this.store = store;
    this.archiver = archiver;
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this.attempts = Math.max(1, Number(attempts) || 1);
    this.join = Boolean(join);
    this.timezone = timezone;
    this.report = Boolean(report);
    this.pollMs = Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Number(pollMs) || POLL_MIN_MS));
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 1000);
    this.sendGapMs = Math.max(0, Number(sendGapMs) || 0);
    this.warmEnabled = Boolean(warm);
    this.seen = new LruSet(SEEN_LIMIT);
    /** post → the message in the linked group that a comment replies to. */
    this.copies = new LruMap(COPY_LIMIT);
    /** post → callbacks waiting for that copy to show up. */
    this.waiters = new Map();
    /** channel → its linked group, resolved once. */
    this.groups = new LruMap(GROUP_LIMIT);
    this.warmed = new Set();
    // A group we already tried to join once; a second failure is not worth a
    // second request.
    this.joined = new Set();
    this.stats = { posted: 0, failed: 0, skipped: 0, instant: 0, lastMs: 0 };
    this._chain = Promise.resolve();
    this._nextSendAt = 0;
    if (!Api) {
      log.warn('[comment] این نسخه teleproto سازنده‌های TL را صادر نمی‌کند؛ «کامنت اول» غیرفعال ماند.');
    }
  }

  get available() {
    return Boolean(Api);
  }

  // ------------------------------------------------------------------ plumbing

  /**
   * One serialized lane with a floor between sends.
   *
   * It wraps the `sendMessage` and nothing else. Everything slower than the send
   * itself — the thread lookup, the archive receipt — deliberately runs outside,
   * because a lane that also carries paperwork makes every *other* post late.
   */
  lane(task) {
    const run = async () => {
      const wait = this._nextSendAt - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        this._nextSendAt = Date.now() + this.sendGapMs;
      }
    };
    this._chain = this._chain.then(run, run);
    return this._chain;
  }

  /** A receipt in the archive. Never fatal: the comment itself already landed. */
  async say(text) {
    if (!this.report || !text || !this.archiver) return null;
    try {
      return await this.archiver.sendText(text);
    } catch (error) {
      log.debug('[comment] نوشتن رسید در آرشیو ناموفق بود:', errText(error));
      return null;
    }
  }

  async peerOf(msg) {
    try {
      return (await msg.getInputChat?.()) ?? msg.peerId ?? msg.chatId;
    } catch {
      return msg.peerId ?? msg.chatId;
    }
  }

  /** The next gap in the ladder, capped so a long run cannot drift into seconds. */
  nextGap(gap) {
    return Math.min(POLL_MAX_MS, Math.round(gap * POLL_GROWTH));
  }

  /** Caches a channel's linked group. First writer wins; they all agree anyway. */
  noteGroup(channelKey, peer, groupKey) {
    if (!channelKey || !peer || this.groups.has(channelKey)) return;
    this.groups.set(channelKey, { peer, chatKey: marked(groupKey) });
  }

  // -------------------------------------------------------- the copy fast path

  key(chatKey, postId) {
    return `${marked(chatKey)}|${postId}`;
  }

  /**
   * A message seen live in some group, which may be the auto-forwarded copy of a
   * post we are about to comment on.
   *
   * Telegram stamps that copy with the channel and message id it came from, so
   * recognising it is exact rather than a guess — and it arrives on the same
   * update stream as everything else, which makes it *earlier* than any answer
   * `GetDiscussionMessage` could give us. Cheap enough to call on every message:
   * two field reads for anything that is not a copy.
   */
  noteCopy(msg) {
    if (!Api || !msg?.id) return;
    let fwd = null;
    try {
      fwd = msg.fwdFrom ?? null;
    } catch {
      return;
    }
    if (!fwd) return;
    const source = bare(fwd.savedFromPeer?.channelId ?? fwd.fromId?.channelId);
    const postId = Number(fwd.savedFromMsgId ?? fwd.channelPost ?? 0);
    if (!source || !postId) return;
    const chatKey = marked(source);
    if (!this.store.isFirstComment(chatKey)) return;
    if (!this.isLinkedCopy(msg, chatKey, source)) return;
    const key = this.key(chatKey, postId);
    if (this.copies.has(key)) return;
    void this.indexCopy(key, msg, chatKey);
  }

  /**
   * Is this really *the* copy, or just a forward that carries the same stamp?
   *
   * `savedFromPeer`/`savedFromMsgId` are written on every forward of a channel
   * post, not only on the automatic one — so a member of a watched channel
   * re-posting today's announcement into an unrelated group used to be indexed
   * as the comment target, and the first comment landed in a chat the user never
   * named. Two independent facts identify the genuine copy:
   *
   *   · it lives in *that channel's* linked group, which warm-up (or the first
   *     successful lookup) has already taught us;
   *   · it is posted **by the channel itself**, while a human forward is posted
   *     by the human.
   *
   * The group is the stronger signal, so it decides on its own when known. The
   * sender covers the window before it is — a channel enabled mid-run, or
   * `FIRST_COMMENT_WARM=false`.
   */
  isLinkedCopy(msg, chatKey, source) {
    const group = this.groups.get(chatKey);
    if (group) return bare(group.chatKey) === bare(msg.chatId);
    return senderChannel(msg) === source;
  }

  /** Records the copy and hands it to whoever is already waiting for it. */
  async indexCopy(key, msg, channelKey = '') {
    const peer = await this.peerOf(msg);
    if (!peer) return;
    const groupKey = marked(msg.chatId);
    const target = { peer, chatKey: groupKey, msgId: msg.id, pushed: true };
    this.copies.set(key, target);
    // Learning the linked group from a live copy costs nothing and is what makes
    // the guard above exact for every *next* post of the same channel.
    this.noteGroup(channelKey, peer, groupKey);
    const list = this.waiters.get(key);
    if (!list) return;
    this.waiters.delete(key);
    for (const done of list) done(target);
  }

  /**
   * Resolves as soon as the copy is indexed, or with null after `ms`.
   *
   * This is what the poll loop sleeps on instead of a blind `sleep`: waiting for
   * a copy that may arrive in 40ms should not cost the rest of the gap.
   */
  waitForCopy(key, ms) {
    return new Promise((resolve) => {
      let done = null;
      const timer = setTimeout(() => {
        const list = this.waiters.get(key);
        if (list) {
          const at = list.indexOf(done);
          if (at >= 0) list.splice(at, 1);
          if (!list.length) this.waiters.delete(key);
        }
        resolve(null);
      }, Math.max(0, ms));
      timer.unref?.();
      done = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      const list = this.waiters.get(key);
      if (list) list.push(done);
      else this.waiters.set(key, [done]);
    });
  }

  // -------------------------------------------------------------------- events

  /**
   * A new message in a channel we watch.
   *
   * Called for both directions: your own post in your own channel arrives with
   * `out: true`, which the incoming event builder never delivers.
   *
   * @returns the sent comment, or null when there was nothing to do.
   */
  async onPost(msg) {
    try {
      if (!Api) return null;
      const chatKey = idStr(msg?.chatId);
      if (!chatKey || !msg?.id) return null;
      if (!this.store.isFirstComment(chatKey)) return null;
      if (!isChannelPost(msg)) return null;
      // Our own commands are ordinary outgoing messages. Never comment on one.
      if (COMMAND_PATTERN.test(String(msg.message ?? ''))) return null;

      // One comment per post — and per album, which arrives as N updates.
      const dedupe = msg.groupedId != null
        ? `${chatKey}|g${idStr(msg.groupedId)}`
        : `${chatKey}|${msg.id}`;
      if (this.seen.add(dedupe)) return null;

      const entry = this.store.firstCommentEntry(chatKey);
      const template = String(entry?.text ?? '');
      if (!template) {
        this.stats.skipped += 1;
        log.warn(`[comment] برای «${entry?.title || chatKey}» متنی ثبت نشده؛ کامنتی گذاشته نشد.`);
        return null;
      }

      const title = entry?.title || displayName(chatOf(msg)) || chatKey;
      const link = buildMessageLink(msg);
      const body = renderComment(template, {
        title,
        link,
        id: msg.id,
        date: faDate(new Date(), this.timezone),
        text: textOf(msg),
      });
      if (!body) {
        this.stats.skipped += 1;
        return null;
      }

      // A channel enabled after startup has never been warmed. Do it in the
      // background — this post takes the polling path, the next one will not.
      this.warmLater(chatKey, title);
      return await this.comment(msg, { chatKey, title, link, body, dedupe, at: Date.now() });
    } catch (error) {
      log.error('[comment] پردازش پست ناموفق بود:', errText(error));
      return null;
    }
  }

  /** Resolve the thread, write the comment, report. Never throws. */
  async comment(msg, { chatKey, title, link, body, dedupe = '', at = Date.now() }) {
    // The optional "look human" delay is served *while* the thread is being
    // resolved, not before it: waiting is not a reason to postpone a lookup.
    const [thread] = await Promise.all([
      this.discussion(msg).catch((error) => {
        log.debug('[comment] یافتن گروه گفتگو ناموفق بود:', errText(error));
        return null;
      }),
      this.delayMs ? sleep(this.delayMs) : null,
    ]);

    if (!thread) {
      this.stats.failed += 1;
      // Release the dedupe claim. Nothing was sent, so there is nothing to
      // duplicate — and "the copy never showed up" is exactly the failure a
      // replayed update (Telegram re-sends after every reconnect) can still fix.
      if (dedupe) this.seen.delete(dedupe);
      log.warn(`[comment] گروه گفتگوی «${title}» پیدا نشد؛ کامنت گذاشته نشد.`);
      void this.say(cards.commentFailedCard({
        title,
        link,
        reason: 'discussion',
        at: faDate(new Date(), this.timezone),
      }));
      return null;
    }

    let sent = null;
    try {
      sent = await this.lane(() => this.write(thread, body));
    } catch (error) {
      this.stats.failed += 1;
      const reason = errText(error);
      // Deliberately *not* released: a send that threw may still have reached
      // Telegram, and a duplicate comment is worse than a missing one.
      log.warn(`[comment] ارسال کامنت در «${title}» ناموفق بود:`, reason);
      void this.say(cards.commentFailedCard({
        title,
        link,
        reason,
        at: faDate(new Date(), this.timezone),
      }));
      return null;
    }

    // Everything below is bookkeeping. It runs after the comment is already on
    // Telegram's side, and none of it is allowed to delay the next one.
    this.stats.posted += 1;
    if (thread.pushed) this.stats.instant += 1;
    this.stats.lastMs = Date.now() - at;
    const count = this.store.countComment(chatKey);
    log.ok(`[comment] اولین کامنت پست ${msg.id} در «${title}» گذاشته شد (${this.stats.lastMs}ms).`);
    void this.say(cards.commentPostedCard({
      title,
      link,
      body,
      count,
      at: faDate(new Date(), this.timezone),
    }));
    return sent;
  }

  /**
   * The post's copy inside the linked discussion group — the message every
   * comment on that post replies to.
   *
   * Two ways to get it, cheapest first: the live update we may already have
   * indexed, and `messages.GetDiscussionMessage`. The gaps between asks are
   * small and grow slowly, and each one is spent *watching* for the copy rather
   * than sleeping through it, so whichever source wins we act immediately.
   */
  async discussion(msg) {
    const key = this.key(msg.chatId, msg.id);
    const known = this.copies.get(key);
    if (known) return known;

    // Started before the first await: the budget is a wall-clock deadline for the
    // whole search, not for whatever is left once setup has had its share.
    const deadline = Date.now() + this.timeoutMs;
    const channelKey = marked(msg.chatId);
    const peer = await this.peerOf(msg);
    let gap = this.pollMs;

    // When we already know the linked group we are almost certainly inside it,
    // and then the copy is coming to us on the update stream. Telegram writes it
    // *after* publishing the post, so a lookup fired right now is guaranteed to
    // answer "no such message": spend the first gap listening instead of paying
    // a round trip for an answer we can predict.
    if (this.groups.has(channelKey)) {
      const early = await this.waitForCopy(key, Math.min(gap, Math.max(0, deadline - Date.now())));
      if (early) return early;
      gap = this.nextGap(gap);
    }

    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      const pushed = this.copies.get(key);
      if (pushed) return pushed;
      if (Date.now() >= deadline) break;
      try {
        // `retries: 0` on purpose: withRetry's backoff starts at a full second
        // and doubles, which inside a ladder measured in milliseconds would eat
        // the entire deadline in a single attempt. This loop *is* the retry.
        const found = await withRetry(
          () => this.client.invoke(new Api.messages.GetDiscussionMessage({ peer, msgId: msg.id })),
          { label: 'getDiscussionMessage', retries: 0 },
        );
        const thread = (found?.messages ?? []).find(isReal);
        const target = thread ? this.threadPeer(found, thread, msg.chatId) : null;
        if (target) {
          const resolved = { peer: target.peer, chatKey: target.chatKey, msgId: thread.id };
          this.copies.set(key, resolved);
          // The lookup just told us where the linked group is; remember it so the
          // next post of this channel takes the listening path above.
          this.noteGroup(channelKey, target.peer, target.chatKey);
          return resolved;
        }
      } catch (error) {
        const text = errText(error);
        log.debug(`[comment] یافتن پیام گفتگو (تلاش ${attempt + 1}) ناموفق بود:`, text);
        // Only the race is worth another attempt.
        if (!RACE.test(text)) break;
      }
      const left = deadline - Date.now();
      if (left <= 0) break;
      const waited = await this.waitForCopy(key, Math.min(gap, left));
      if (waited) return waited;
      gap = this.nextGap(gap);
    }
    return this.copies.get(key) ?? null;
  }

  /**
   * An input peer for the discussion group, built from the access hash the same
   * response carries. Reading it from there — instead of asking teleproto to
   * resolve the peer — is what lets us comment in a group this session has never
   * opened. A peer cached at warm-up covers the case where the response omits
   * the hash.
   */
  threadPeer(found, thread, sourceKey = '') {
    const channelId = bare(thread?.peerId?.channelId);
    const chat = (found?.chats ?? []).find((item) => bare(item?.id) === channelId);
    if (chat?.accessHash != null) {
      return {
        peer: new Api.InputPeerChannel({ channelId: chat.id, accessHash: chat.accessHash }),
        chatKey: marked(channelId),
      };
    }
    const warm = this.groups.get(marked(sourceKey));
    if (warm?.peer) return { peer: warm.peer, chatKey: warm.chatKey };
    if (!thread?.peerId) return null;
    return { peer: thread.peerId, chatKey: marked(channelId) };
  }

  /**
   * Writes the comment.
   *
   * No `parseMode`: the body is the user's own text and it goes out byte for
   * byte, so a `<` in it is a `<` and not a rejected message.
   */
  write({ peer, msgId, chatKey }, body) {
    const send = () => withRetry(
      () => this.client.sendMessage(peer, { message: body, replyTo: msgId, linkPreview: false }),
      { label: 'sendMessage:comment' },
    );
    return send().catch(async (error) => {
      if (!this.join || this.joined.has(chatKey) || !NEEDS_JOIN.test(errText(error))) throw error;
      this.joined.add(chatKey);
      if (!(await this.joinDiscussion(peer))) throw error;
      return send();
    });
  }

  /** Joining the linked group is the only way to comment in it. Loud on purpose. */
  async joinDiscussion(peer) {
    try {
      await this.client.invoke(new Api.channels.JoinChannel({ channel: peer }));
      log.info('[comment] برای گذاشتن کامنت، عضو گروه گفتگو شدم.');
      return true;
    } catch (error) {
      log.warn('[comment] عضو شدن در گروه گفتگو ناموفق بود:', errText(error));
      return false;
    }
  }

  // ------------------------------------------------------------------- warm-up

  /**
   * Everything that can be paid for before a post exists.
   *
   * Resolving a channel's linked group and joining it used to happen *during* the
   * race — the join only after a send had already been rejected, which is one
   * failed send plus two round trips at the exact moment they cost the most.
   * Doing it at startup also puts us inside the group, which is what turns the
   * copy of every future post into an update we simply receive.
   */
  async warmUp() {
    if (!Api || !this.warmEnabled) return 0;
    const entries = this.store.firstCommentEntries();
    if (!entries.length) return 0;
    let ready = 0;
    let seen = 0;
    for (const [chatKey, entry] of entries) {
      // A gap between every pair of channels, not only after a success: a run of
      // channels that all fail to resolve is precisely the burst that earns a
      // FLOOD_WAIT, and it used to be the one case that got no gap at all.
      if (seen) await sleep(WARM_GAP_MS);
      seen += 1;
      if (await this.warmChannel(chatKey, entry?.title, entry?.username)) ready += 1;
    }
    if (ready) log.info(`[comment] گروه گفتگوی ${ready} کانال آماده شد؛ کامنت اول بدون تأخیر می‌رود.`);
    return ready;
  }

  /** Fire-and-forget warm-up for a channel enabled while we were running. */
  warmLater(chatKey, title) {
    if (!Api || !this.warmEnabled || this.warmed.has(marked(chatKey))) return;
    void this.warmChannel(chatKey, title);
  }

  /** Resolves one channel's linked group, caches its peer, and joins it. */
  async warmChannel(chatKey, title = '', username = '') {
    const key = marked(chatKey);
    if (!key || this.warmed.has(key)) return false;
    this.warmed.add(key);
    const label = title || key;
    try {
      const channel = await this.entityOf(key, username);
      if (!channel) return false;
      const full = await this.client.invoke(new Api.channels.GetFullChannel({ channel }));
      const linkedId = bare(full?.fullChat?.linkedChatId);
      if (!linkedId) {
        log.warn(`[comment] «${label}» گروه گفتگو ندارد؛ کامنتی نمی‌شود گذاشت.`);
        return false;
      }
      const chat = (full?.chats ?? []).find((item) => bare(item?.id) === linkedId);
      if (chat?.accessHash == null) return false;
      const group = {
        peer: new Api.InputPeerChannel({ channelId: chat.id, accessHash: chat.accessHash }),
        chatKey: marked(linkedId),
      };
      this.groups.set(key, group);
      // Already a member? Telegram answers this happily and nothing changes.
      if (this.join && !this.joined.has(group.chatKey)) {
        if (await this.joinDiscussion(group.peer)) this.joined.add(group.chatKey);
      }
      return true;
    } catch (error) {
      log.debug(`[comment] آماده‌سازی «${label}» ناموفق بود:`, errText(error));
      // A channel that could not be warmed is worth a second try on its next
      // post: the failure is usually a cold session, not a permanent one.
      this.warmed.delete(key);
      return false;
    }
  }

  /** The channel itself, by id or — when that fails — by the stored username. */
  async entityOf(chatKey, username = '') {
    try {
      return await this.client.getInputEntity(chatKey);
    } catch (error) {
      const handle = String(username || '').trim().replace(/^@+/, '');
      if (!handle) throw error;
      return this.client.getInputEntity(`@${handle}`);
    }
  }
}
