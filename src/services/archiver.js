import fs from 'node:fs/promises';
import path from 'node:path';
import * as cards from '../ui/cards.js';
import { humanBytes, esc, faDate, joinWithin, percent } from '../utils/format.js';
import { LruMap } from '../utils/lru.js';
import { withRetry, isNotModified } from '../utils/retry.js';
import { log, errText } from '../utils/logger.js';
import {
  buildMessageLink,
  displayName,
  guessFilename,
  idStr,
  isSelfDestruct,
  mediaKind,
  mediaSize,
  shouldForceDocument,
} from './mediaInfo.js';
import { rebuildAttributes } from './attributes.js';

const CAPTION_LIMIT = 1024;
const TITLE_CACHE_LIMIT = 500;
// Telegram rate-limits edits hard, and editing to identical text is a 400.
const PROGRESS_MIN_INTERVAL_MS = 2500;
const PROGRESS_MIN_STEP = 7;

const peerOf = (msg) => msg?.peerId ?? msg?.chatId;

/**
 * teleproto is not consistent about progress callbacks: `downloadMedia` reports
 * `(received, total)` in bytes, while `sendFile` hands the upload over as a
 * single 0..1 fraction with no second argument. Reading that fraction as a byte
 * count against the file size pinned every upload card at 0%.
 */
const progressPercent = (received, total) => {
  if (total == null) {
    const fraction = Number(received);
    if (!Number.isFinite(fraction) || fraction <= 0) return 0;
    return fraction <= 1 ? percent(fraction, 1) : 0;
  }
  return percent(received, total);
};

let jobCounter = 0;
const nextJobId = () => {
  jobCounter = (jobCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${jobCounter.toString(36)}`;
};

/**
 * The archive engine.
 *
 * Two strategies, picked per message:
 *   direct   — hand Telegram the existing media reference. Instant, no bytes
 *              cross the wire, keeps original quality. Fails for protected
 *              (`noforwards`) chats, and is *never* used for TTL media because
 *              the archived copy would inherit the self-destruct timer.
 *   reupload — download to a temp file, then upload a fresh copy. Slower, but
 *              it is the only way past a forward lock or a TTL timer.
 */
export class Archiver {
  constructor(client, store, { tmpDir, dest = 'me', timezone, uploadWorkers = 4, doneReaction = '' } = {}) {
    this.client = client;
    this.store = store;
    this.tmpDir = tmpDir;
    this.dest = dest || 'me';
    this.timezone = timezone;
    this.uploadWorkers = Math.max(1, Number(uploadWorkers) || 1);
    this.doneReaction = doneReaction;
    this.titles = new LruMap(TITLE_CACHE_LIMIT);
    this._destPromise = null;
  }

  // ---------------------------------------------------------------- destination

  /**
   * Resolves the archive destination exactly once. Memoizing the *promise*
   * (not the value) is what stops N concurrent jobs from firing N identical
   * `getInputEntity` calls straight into a flood wait on startup.
   */
  destPeer() {
    if (!this._destPromise) {
      this._destPromise = this._resolveDest().catch((error) => {
        this._destPromise = null;
        throw error;
      });
    }
    return this._destPromise;
  }

  async _resolveDest() {
    if (this.dest && this.dest !== 'me') {
      try {
        const peer = await this.client.getInputEntity(this.dest);
        log.ok(`مقصد آرشیو: ${this.dest}`);
        return peer;
      } catch (error) {
        log.warn(`مقصد آرشیو «${this.dest}» در دسترس نیست؛ Saved Messages استفاده می‌شود.`, errText(error));
        this.dest = 'me';
      }
    }
    return this.client.getInputEntity('me');
  }

  sendFile(options, label = 'sendFile') {
    return withRetry(async () => this.client.sendFile(await this.destPeer(), options), { label });
  }

  /**
   * Writes a card to the archive chat.
   *
   * `replyTo` is what turns the mirror into a readable thread: an edit or delete
   * notice hangs off the original copy instead of drifting apart from it.
   */
  sendText(message, { replyTo = null } = {}) {
    return withRetry(
      async () => this.client.sendMessage(await this.destPeer(), {
        message,
        parseMode: 'html',
        linkPreview: false,
        ...(replyTo ? { replyTo } : {}),
      }),
      { label: 'sendMessage' },
    );
  }

  // ------------------------------------------------------------------ metadata

  async chatTitle(msg, chatId) {
    if (!chatId) return '';
    const cached = this.titles.get(chatId);
    if (cached != null) return cached;
    let title = msg?.chat ? displayName(msg.chat) : '';
    if (!title) {
      try {
        title = displayName(await this.client.getEntity(chatId));
      } catch {
        title = '';
      }
    }
    this.titles.set(chatId, title);
    return title;
  }

  async describe(msg) {
    const chatId = idStr(msg?.chatId);
    const senderId = idStr(msg?.senderId);
    const seconds = Number(msg?.date) || Math.floor(Date.now() / 1000);
    const info = {
      kind: mediaKind(msg) ?? 'رسانه \u{1F4CE}',
      size: mediaSize(msg),
      ttl: isSelfDestruct(msg),
      chatTitle: await this.chatTitle(msg, chatId),
      senderName: '',
      date: faDate(new Date(seconds * 1000), this.timezone),
      link: buildMessageLink(msg),
    };

    if (senderId && senderId === chatId) {
      info.senderName = info.chatTitle;
    } else if (senderId) {
      let sender = msg.sender;
      if (!sender) {
        try {
          sender = await this.client.getEntity(senderId);
        } catch {
          sender = null;
        }
      }
      info.senderName = sender ? displayName(sender) : '';
    }
    return info;
  }

  caption(info) {
    const lines = ['\u{1F4E5} <b>آرشیو شد</b>', cards.LINE, `\u{1F5C2} نوع: <b>${esc(info.kind)}</b>`];
    if (info.size) lines.push(`\u{1F4BE} حجم: <b>${humanBytes(info.size)}</b>`);
    if (info.chatTitle) lines.push(`\u{1F4AC} منبع: <b>${esc(info.chatTitle)}</b>`);
    if (info.senderName && info.senderName !== info.chatTitle) {
      lines.push(`\u{1F464} فرستنده: <b>${esc(info.senderName)}</b>`);
    }
    if (info.date) lines.push(`\u{1F5D3} زمان اصلی: <i>${esc(info.date)}</i>`);
    if (info.link) lines.push(cards.link(info.link, '\u{1F517} مشاهده پیام اصلی'));
    if (info.ttl) lines.push('', '\u23F3 <b>رسانه محوشونده — بلافاصله ذخیره شد</b>');
    return joinWithin(lines, CAPTION_LIMIT);
  }

  albumCaption(count, info) {
    const lines = [`\u{1F5C3} <b>آلبوم ${count} رسانه‌ای ذخیره شد</b>`, cards.LINE];
    if (info.chatTitle) lines.push(`\u{1F4AC} منبع: <b>${esc(info.chatTitle)}</b>`);
    if (info.senderName && info.senderName !== info.chatTitle) {
      lines.push(`\u{1F464} فرستنده: <b>${esc(info.senderName)}</b>`);
    }
    if (info.date) lines.push(`\u{1F5D3} زمان اصلی: <i>${esc(info.date)}</i>`);
    if (info.link) lines.push(cards.link(info.link, '\u{1F517} مشاهده پیام اصلی'));
    return joinWithin(lines, CAPTION_LIMIT);
  }

  // -------------------------------------------------------------- status message

  /**
   * editMessage(entity, { message, text }): the target id goes in `message`,
   * the new body in `text`. Keep them in that order or the edit is rejected.
   */
  async safeEdit(message, text) {
    if (!message?.id || !text) return false;
    try {
      await this.client.editMessage(peerOf(message), {
        message: message.id,
        text,
        parseMode: 'html',
        linkPreview: false,
      });
      return true;
    } catch (error) {
      if (!isNotModified(error)) {
        log.debug('[archiver] ویرایش پیام وضعیت ناموفق بود:', errText(error));
      }
      return false;
    }
  }

  hide(message) {
    if (!message?.delete) return;
    Promise.resolve(message.delete({ revoke: true })).catch(() => {});
  }

  /** Cosmetic "done" mark on the source message; failure is never interesting. */
  async react(msg) {
    if (!this.doneReaction || !msg?.id) return;
    try {
      await this.client.sendReaction(peerOf(msg), msg.id, this.doneReaction);
    } catch (error) {
      log.debug('[archiver] ری‌اکشن ثبت نشد:', errText(error));
    }
  }

  /**
   * One throttled progress reporter per job. v1 built one per *file*, which
   * reset the throttle on every item of an album and spammed Telegram.
   */
  createProgress(statusMsg, info) {
    let stopped = false;
    let lastStage = '';
    let lastPct = -1;
    let lastAt = 0;

    const report = (stage, received, total) => {
      if (stopped || !statusMsg) return;
      const pct = progressPercent(received, total);
      const now = Date.now();
      // An edit needs a real jump AND a cooled-down timer: repeating the same
      // percentage is a MESSAGE_NOT_MODIFIED, and editing on every callback is
      // the fastest way into a flood wait. A stage change always gets through.
      const stageChanged = stage !== lastStage;
      const moved = pct !== lastPct;
      const cooledDown = now - lastAt >= PROGRESS_MIN_INTERVAL_MS;
      const bigStep = pct - lastPct >= PROGRESS_MIN_STEP || pct === 100;
      if (!stageChanged && !(moved && cooledDown && bigStep)) return;

      lastStage = stage;
      lastPct = pct;
      lastAt = now;
      void this.safeEdit(statusMsg, cards.progressCard({
        stage,
        pct,
        kind: info.kind,
        size: humanBytes(info.size),
        urgent: info.ttl,
      }));
    };
    report.stop = () => {
      stopped = true;
    };
    return report;
  }

  // ----------------------------------------------------------------------- jobs

  async runJob(job) {
    const { statusMsg, explicit } = job ?? {};
    const messages = (job?.messages ?? []).filter((msg) => msg?.media);
    if (!messages.length) return { bytes: 0, count: 0, method: 'skipped' };

    const workDir = path.join(this.tmpDir, nextJobId());
    try {
      const result = messages.length === 1
        ? await this.archiveOne(messages[0], statusMsg, workDir)
        : await this.archiveAlbum(messages, statusMsg, workDir);
      this.store.countArchive(result.bytes, result.count);
      this.hide(statusMsg);
      if (explicit) await this.react(messages[0]);
      log.ok(`آرشیو شد: ${result.count} مورد \u2022 ${humanBytes(result.bytes)} \u2022 روش ${result.method}`);
      return result;
    } catch (error) {
      this.store.countFailure();
      const text = errText(error);
      log.error('آرشیو ناموفق:', text);
      await this.safeEdit(statusMsg, cards.errorCard(text));
      throw error;
    } finally {
      // One temp dir per job means a crashed job can never orphan bytes and two
      // messages with the same id from different chats cannot collide.
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async archiveOne(msg, statusMsg, workDir) {
    const info = await this.describe(msg);
    const progress = this.createProgress(statusMsg, info);
    try {
      await this.safeEdit(statusMsg, cards.progressCard({
        stage: 'download',
        pct: 0,
        kind: info.kind,
        size: humanBytes(info.size),
        urgent: info.ttl,
      }));
      return await this.archiveMessage(msg, this.caption(info), progress, info, workDir);
    } finally {
      progress.stop();
    }
  }

  async archiveMessage(msg, caption, progress, info, workDir) {
    if (!info.ttl) {
      try {
        await this.sendFile(
          { file: msg.media, caption, parseMode: 'html', workers: this.uploadWorkers },
          'sendFile:direct',
        );
        return { bytes: mediaSize(msg), count: 1, method: 'direct' };
      } catch (error) {
        log.warn('ارسال مستقیم ناموفق؛ دانلود و بازآپلود…', errText(error));
      }
    }
    return this.reupload(msg, caption, progress, workDir);
  }

  async reupload(msg, caption, progress, workDir) {
    const fileName = guessFilename(msg);
    const target = path.join(workDir, `${msg.id ?? 0}_${fileName}`);
    await fs.mkdir(workDir, { recursive: true });

    const declared = mediaSize(msg);
    progress?.('download', 0, declared || 1);
    await withRetry(
      () => this.client.downloadMedia(msg, {
        outputFile: target,
        progressCallback: (received, total) => progress?.('download', received, total || declared),
      }),
      { label: 'downloadMedia' },
    );

    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.size) throw new Error('دانلود رسانه ناموفق بود (فایل خالی).');

    const attributes = rebuildAttributes(msg, fileName);
    const options = {
      file: target,
      caption,
      parseMode: 'html',
      forceDocument: shouldForceDocument(msg),
      workers: this.uploadWorkers,
      // Handed straight through: an absent total means teleproto is reporting a
      // 0..1 fraction, which `progressPercent` knows how to read.
      progressCallback: (sent, total) => progress?.('upload', sent, total),
    };
    if (attributes.length) options.attributes = attributes;
    if (msg?.document?.mimeType) options.mimeType = msg.document.mimeType;

    await this.sendFile(options, 'sendFile:reupload');
    return { bytes: stat.size, count: 1, method: 'reupload' };
  }

  async archiveAlbum(messages, statusMsg, workDir) {
    const head = await this.describe(messages[0]);
    const declared = messages.reduce((sum, msg) => sum + mediaSize(msg), 0);
    const hasTtl = messages.some(isSelfDestruct);
    const progress = this.createProgress(statusMsg, { ...head, size: declared });

    try {
      await this.safeEdit(statusMsg, cards.albumCard(messages.length, head.kind, humanBytes(declared)));

      if (!hasTtl) {
        try {
          await this.sendFile({
            file: messages.map((msg) => msg.media),
            caption: this.albumCaption(messages.length, head),
            parseMode: 'html',
            workers: this.uploadWorkers,
          }, 'sendFile:album');
          return { bytes: declared, count: messages.length, method: 'direct' };
        } catch (error) {
          log.warn('ارسال مستقیم آلبوم ناموفق؛ ذخیره تک‌تک…', errText(error));
        }
      }

      let bytes = 0;
      for (const [index, msg] of messages.entries()) {
        const info = index === 0 ? head : await this.describe(msg);
        const item = await this.archiveMessage(msg, this.caption(info), progress, info, workDir);
        bytes += item.bytes;
      }
      await this.sendText(this.albumCaption(messages.length, head));
      return { bytes: bytes || declared, count: messages.length, method: 'reupload' };
    } finally {
      progress.stop();
    }
  }
}
