// A *namespace* import, for exactly the reason `handlers/messages.js` uses one:
// a missing **named** export is a hard link-time failure in ESM, so a teleproto
// build that ships without the TL constructors we need must disable one feature
// instead of taking the whole bot down at startup.
import * as teleproto from 'teleproto';
import * as cards from '../ui/cards.js';
import { COMMAND_PATTERN } from '../constants.js';
import { renderComment } from '../utils/comment.js';
import { faDate } from '../utils/format.js';
import { LruSet } from '../utils/lru.js';
import { sleep, withRetry } from '../utils/retry.js';
import { buildMessageLink, displayName, idStr } from './mediaInfo.js';
import { log, errText } from '../utils/logger.js';

const Api = teleproto?.Api ?? null;

const SEEN_LIMIT = 1024;
/** Grows with every attempt: 1.2s, 2.4s, 3.6s … */
const LOOKUP_GAP_MS = 1200;
/** Comments are *sends*, which Telegram punishes in bursts far harder than edits. */
const MIN_SEND_GAP_MS = 600;

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

/** Reading `msg.chat` can throw on a peer teleproto has not resolved yet. */
const chatOf = (msg) => {
  try {
    return msg?.chat ?? null;
  } catch {
    return null;
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
 * to that copy. `messages.GetDiscussionMessage` is the one call that hands us
 * that copy, so the whole feature is: find it, reply to it, once per post.
 *
 * Why an album needs care: a multi-item post arrives as N separate updates with
 * one shared `groupedId`. Keyed by post id it would earn N identical comments,
 * so the dedupe key is the group when there is one.
 */
export class FirstCommentService {
  constructor(client, store, archiver, {
    delayMs = 0,
    attempts = 5,
    join = true,
    timezone,
    myId = '',
    report = true,
  } = {}) {
    this.client = client;
    this.store = store;
    this.archiver = archiver;
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this.attempts = Math.max(1, Number(attempts) || 1);
    this.join = Boolean(join);
    this.timezone = timezone;
    this.myId = idStr(myId);
    this.report = Boolean(report);
    this.seen = new LruSet(SEEN_LIMIT);
    // A group we already tried to join once; a second failure is not worth a
    // second request.
    this.joined = new Set();
    this.stats = { posted: 0, failed: 0, skipped: 0 };
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

  /** One serialized lane with a floor between sends. */
  lane(task) {
    const run = async () => {
      const wait = this._nextSendAt - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        this._nextSendAt = Date.now() + MIN_SEND_GAP_MS;
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
      const key = msg.groupedId != null
        ? `${chatKey}|g${idStr(msg.groupedId)}`
        : `${chatKey}|${msg.id}`;
      if (this.seen.add(key)) return null;

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

      return this.lane(() => this.comment(msg, { chatKey, title, link, body }));
    } catch (error) {
      log.error('[comment] پردازش پست ناموفق بود:', errText(error));
      return null;
    }
  }

  /** Resolve the thread, write the comment, report. Never throws. */
  async comment(msg, { chatKey, title, link, body }) {
    if (this.delayMs) await sleep(this.delayMs);

    const thread = await this.discussion(msg);
    if (!thread) {
      this.stats.failed += 1;
      log.warn(`[comment] گروه گفتگوی «${title}» پیدا نشد؛ کامنت گذاشته نشد.`);
      await this.say(cards.commentFailedCard({
        title,
        link,
        reason: 'discussion',
        at: faDate(new Date(), this.timezone),
      }));
      return null;
    }

    try {
      const sent = await this.write(thread, body);
      this.stats.posted += 1;
      const count = this.store.countComment(chatKey);
      log.ok(`[comment] اولین کامنت پست ${msg.id} در «${title}» گذاشته شد.`);
      await this.say(cards.commentPostedCard({
        title,
        link,
        body,
        count,
        at: faDate(new Date(), this.timezone),
      }));
      return sent;
    } catch (error) {
      this.stats.failed += 1;
      const reason = errText(error);
      log.warn(`[comment] ارسال کامنت در «${title}» ناموفق بود:`, reason);
      await this.say(cards.commentFailedCard({
        title,
        link,
        reason,
        at: faDate(new Date(), this.timezone),
      }));
      return null;
    }
  }

  /**
   * The post's copy inside the linked discussion group — the message every
   * comment on that post replies to.
   */
  async discussion(msg) {
    const peer = await this.peerOf(msg);
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      if (attempt) await sleep(LOOKUP_GAP_MS * attempt);
      try {
        const found = await withRetry(
          () => this.client.invoke(new Api.messages.GetDiscussionMessage({ peer, msgId: msg.id })),
          { label: 'getDiscussionMessage', retries: 1 },
        );
        const thread = (found?.messages ?? []).find(isReal);
        if (!thread) continue;
        const target = this.threadPeer(found, thread);
        if (target) return { peer: target.peer, chatKey: target.chatKey, msgId: thread.id };
      } catch (error) {
        const text = errText(error);
        log.debug(`[comment] یافتن پیام گفتگو (تلاش ${attempt + 1}) ناموفق بود:`, text);
        // Only the race is worth another attempt.
        if (!RACE.test(text)) break;
      }
    }
    return null;
  }

  /**
   * An input peer for the discussion group, built from the access hash the same
   * response carries. Reading it from there — instead of asking teleproto to
   * resolve the peer — is what lets us comment in a group this session has never
   * opened.
   */
  threadPeer(found, thread) {
    const channelId = idStr(thread?.peerId?.channelId);
    const chat = (found?.chats ?? []).find((item) => idStr(item?.id) === channelId);
    if (chat?.accessHash != null) {
      return {
        peer: new Api.InputPeerChannel({ channelId: chat.id, accessHash: chat.accessHash }),
        chatKey: `-100${channelId}`,
      };
    }
    if (!thread?.peerId) return null;
    return { peer: thread.peerId, chatKey: channelId ? `-100${channelId}` : '' };
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
}
