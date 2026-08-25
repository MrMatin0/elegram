import fs from 'node:fs/promises';
import path from 'node:path';
import * as cards from '../ui/cards.js';
import { humanBytes, esc, faDate, joinWithin } from '../utils/format.js';
import {
  isSelfDestruct,
  mediaKind,
  guessFilename,
  rebuildAttributes,
  shouldForceDocument,
  buildLink,
  displayName,
} from './mediaInfo.js';
import { withRetry } from '../utils/retry.js';
import { log, errText } from '../utils/logger.js';

const CAPTION_LIMIT = 1024;
const TITLE_CACHE_LIMIT = 500;
const PROGRESS_MIN_STEP = 10;
const PROGRESS_MIN_INTERVAL = 2000;
const DONE_REACTION = '⚡️';

const peerOf = (msg) => msg?.peerId ?? msg?.chatId;

export class Archiver {
  constructor(client, store, { tmpDir, dest } = {}) {
    this.client = client;
    this.store = store;
    this.tmpDir = tmpDir;
    this.dest = dest || 'me';
    this.titles = new Map();
    this._destPeer = null;
  }

  /** Resolves the archive destination once and falls back to Saved Messages. */
  async resolveDest() {
    if (this._destPeer) return this._destPeer;
    try {
      this._destPeer = await this.client.getInputEntity(this.dest);
    } catch (error) {
      if (this.dest !== 'me') {
        log.warn(`مقصد آرشیو «${this.dest}» در دسترس نیست؛ Saved Messages استفاده می‌شود.`, errText(error));
      }
      this._destPeer = await this.client.getInputEntity('me');
      this.dest = 'me';
    }
    return this._destPeer;
  }

  sendFile(options, label = 'sendFile') {
    return withRetry(async () => this.client.sendFile(await this.resolveDest(), options), { label });
  }

  sendText(message) {
    return withRetry(
      async () => this.client.sendMessage(await this.resolveDest(), { message, parseMode: 'html', linkPreview: false }),
      { label: 'sendMessage' },
    );
  }

  cacheTitle(key, title) {
    if (!key || !title) return;
    if (this.titles.size >= TITLE_CACHE_LIMIT) {
      const oldest = this.titles.keys().next().value;
      this.titles.delete(oldest);
    }
    this.titles.set(key, title);
  }

  async chatTitle(msg, chatId) {
    if (!chatId) return '';
    const cached = this.titles.get(chatId);
    if (cached) return cached;
    let title = msg.chat ? displayName(msg.chat) : '';
    if (!title) {
      try {
        title = displayName(await this.client.getEntity(chatId));
      } catch {
        title = '';
      }
    }
    this.cacheTitle(chatId, title);
    return title;
  }

  async describe(msg) {
    const chatId = msg?.chatId != null ? String(msg.chatId) : '';
    const senderId = msg?.senderId != null ? String(msg.senderId) : '';
    const seconds = Number(msg?.date) || Math.floor(Date.now() / 1000);
    const info = {
      kind: mediaKind(msg) || 'رسانه 📎',
      size: Number(msg?.file?.size || 0),
      ttl: isSelfDestruct(msg),
      chatTitle: await this.chatTitle(msg, chatId),
      senderName: '',
      date: faDate(new Date(seconds * 1000)),
      link: buildLink(msg),
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
    const lines = ['📥 <b>آرشیو شد</b>', cards.LINE, `🗂 نوع: <b>${esc(info.kind)}</b>`];
    if (info.size) lines.push(`💾 حجم: <b>${humanBytes(info.size)}</b>`);
    if (info.chatTitle) lines.push(`💬 منبع: <b>${esc(info.chatTitle)}</b>`);
    if (info.senderName && info.senderName !== info.chatTitle) {
      lines.push(`👤 فرستنده: <b>${esc(info.senderName)}</b>`);
    }
    if (info.date) lines.push(`🗓 زمان اصلی: <i>${esc(info.date)}</i>`);
    if (info.link) lines.push(info.link);
    if (info.ttl) lines.push('', '⏳ <b>رسانه محوشونده — بلافاصله ذخیره شد</b>');
    return joinWithin(lines, CAPTION_LIMIT);
  }

  albumCaption(count, info) {
    const lines = [`🗃 <b>آلبوم攏 ${count} رسانه‌ای ذخیره شد</b>`, cards.LINE];
    if (info.chatTitle) lines.push(`💬 منبع: <b>${esc(info.chatTitle)}</b>`);
    if (info.senderName && info.senderName !== info.chatTitle) {
      lines.push(`👤 فرستنده: <b>${esc(info.senderName)}</b>`);
    }
    if (info.date) lines.push(`🗓 زمان اصلی: <i>${esc(info.date)}</i>`);
    if (info.link) lines.push(info.link);
    return joinWithin(lines, CAPTION_LIMIT);
  }

  /** teleproto takes the new text as `message`, with the id in the same object. */
  async safeEdit(message, text) {
    if (!message) return;
    try {
      await this.client.editMessage(peerOf(message), {
        message: text,
        id: message.id,
        parseMode: 'html',
        linkPreview: false,
      });
    } catch {
      /* the status message may already be gone */
    }
  }

  hide(message) {
    message?.delete?.().catch(() => {});
  }

  /** Cosmetic "done" mark on the source message. */
  async react(msg) {
    if (!msg?.id) return;
    try {
      await this.client.sendReaction(peerOf(msg), msg.id, DONE_REACTION);
    } catch {
      /* reactions are cosmetic */
    }
  }

  /**
   * One throttled reporter per job — the old code rebuilt it per file, which
   * reset the throttle and spammed Telegram with edits.
   */
  createProgress(statusMsg, info) {
    let stopped = false;
    let lastStage = '';
    let lastPct = -1;
    let lastAt = 0;
    const report = (stage, received, total) => {
      if (stopped || !statusMsg) return;
      const totalNum = Number(total) || 0;
      const pct = totalNum > 0
        ? Math.max(0, Math.min(100, Math.floor((Number(received) / totalNum) * 100)))
        : 0;
      const now = Date.now();
      const sameStage = stage === lastStage;
      if (sameStage && pct - lastPct < PROGRESS_MIN_STEP && now - lastAt < PROGRESS_MIN_INTERVAL) return;
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

  async runJob(job) {
    const { statusMsg, explicit } = job;
    const messages = (job.messages || []).filter((msg) => msg && msg.media);
    if (!messages.length) return { bytes: 0, count: 0 };
    try {
      const result = messages.length === 1
        ? await this.archiveOne(messages[0], statusMsg)
        : await this.archiveAlbum(messages, statusMsg);
      this.store.countArchive(result.bytes, result.count);
      this.hide(statusMsg);
      if (explicit) await this.react(messages[0]);
      log.ok(`آرشیو شد: ${result.count} مورد • ${humanBytes(result.bytes)} • روش ${result.method}`);
      return result;
    } catch (error) {
      const text = errText(error);
      log.error('آرشیو ناموفق:', text);
      await this.safeEdit(statusMsg, cards.errorCard(text));
      throw error;
    }
  }

  async archiveOne(msg, statusMsg) {
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
      return await this.archiveMessage(msg, this.caption(info), progress, info);
    } finally {
      progress.stop();
    }
  }

  /**
   * Fast path forwards the media reference; TTL media is always downloaded and
   * re-uploaded, otherwise the archived copy would self-destruct as well.
   */
  async archiveMessage(msg, caption, progress, info) {
    if (!info.ttl) {
      try {
        await this.sendFile({ file: msg.media, caption, parseMode: 'html', workers: 2 }, 'sendFile:direct');
        return { bytes: Number(msg.file?.size || 0), count: 1, method: 'direct' };
      } catch (error) {
        log.warn('ارسال مستقیم ناموفق؛ دانلود و بازآپلود…', errText(error));
      }
    }
    return this.reupload(msg, caption, progress);
  }

  async reupload(msg, caption, progress) {
    const fileName = guessFilename(msg);
    const tmpPath = path.join(this.tmpDir, `${msg.id ?? 0}_${Date.now().toString(36)}_${fileName}`);
    try {
      await fs.mkdir(this.tmpDir, { recursive: true });
      progress?.('download', 0, Number(msg.file?.size || 0) || 1);
      await withRetry(
        () => this.client.downloadMedia(msg, {
          outputFile: tmpPath,
          progressCallback: (received, total) => progress?.('download', received, total),
        }),
        { label: 'downloadMedia' },
      );
      const stat = await fs.stat(tmpPath).catch(() => null);
      if (!stat?.size) throw new Error('دانلود رسانه ناموفق بود (فایل خالی).');

      const attributes = rebuildAttributes(msg, fileName);
      const options = {
        file: tmpPath,
        caption,
        parseMode: 'html',
        forceDocument: shouldForceDocument(msg),
        workers: 2,
        progressCallback: (received, total) => progress?.('upload', received, total),
      };
      if (attributes.length) options.attributes = attributes;
      await this.sendFile(options, 'sendFile:reupload');
      return { bytes: stat.size, count: 1, method: 'reupload' };
    } finally {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  async archiveAlbum(messages, statusMsg) {
    const head = await this.describe(messages[0]);
    const declared = messages.reduce((sum, msg) => sum + Number(msg.file?.size || 0), 0);
    const hasTtl = messages.some(isSelfDestruct);
    const progress = this.createProgress(statusMsg, head);
    try {
      await this.safeEdit(statusMsg, cards.albumCard(messages.length, head.kind, humanBytes(declared)));
      if (!hasTtl) {
        try {
          await this.sendFile({
            file: messages.map((msg) => msg.media),
            caption: this.albumCaption(messages.length, head),
            parseMode: 'html',
            workers: 3,
          }, 'sendFile:album');
          return { bytes: declared, count: messages.length, method: 'direct' };
        } catch (error) {
          log.warn('ارسال مستقیم آلبوم ناموفق؛ ذخیره تک‌تک…', errText(error));
        }
      }
      let bytes = 0;
      for (const [index, msg] of messages.entries()) {
        const info = index === 0 ? head : await this.describe(msg);
        const item = await this.archiveMessage(msg, this.caption(info), progress, info);
        bytes += item.bytes;
      }
      await this.sendText(this.albumCaption(messages.length, head));
      return { bytes: bytes || declared, count: messages.length, method: 'reupload' };
    } finally {
      progress.stop();
    }
  }
}
