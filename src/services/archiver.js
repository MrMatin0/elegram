import fs from 'node:fs/promises';
import path from 'node:path';
import { Api } from 'telegram';
import * as cards from '../ui/cards.js';
import { humanBytes, esc, faDate } from '../utils/format.js';
import {
  isSelfDestruct,
  mediaKind,
  guessFilename,
  rebuildAttributes,
  buildLink,
  displayName,
} from './mediaInfo.js';
import { log } from '../utils/logger.js';

export class Archiver {
  constructor(client, store, { tmpDir, dest }) {
    this.client = client;
    this.store = store;
    this.tmpDir = tmpDir;
    this.dest = dest;
    this.titles = new Map();
  }

  cacheTitle(key, title) {
    if (!title) return;
    if (this.titles.size > 500) this.titles.clear();
    this.titles.set(key, title);
  }

  async describe(msg) {
    const d = {
      kind: mediaKind(msg) || 'رسانه 📎',
      size: Number(msg.file?.size || 0),
      ttl: isSelfDestruct(msg),
      chatTitle: '',
      senderName: '',
      date: faDate(new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000)),
      link: buildLink(msg),
    };
    const cid = msg.chatId != null ? String(msg.chatId) : '';
    if (cid) {
      d.chatTitle = this.titles.get(cid) || '';
      if (!d.chatTitle && msg.chat) {
        const t = displayName(msg.chat);
        if (t) {
          d.chatTitle = t;
          this.cacheTitle(cid, t);
        }
      }
      if (!d.chatTitle) {
        try {
          const entity = await this.client.getEntity(cid);
          const t = displayName(entity);
          if (t) {
            d.chatTitle = t;
            this.cacheTitle(cid, t);
          }
        } catch {}
      }
    }
    const sid = msg.senderId != null ? String(msg.senderId) : '';
    if (sid && sid === cid) {
      d.senderName = d.chatTitle;
    } else if (sid) {
      let sender = msg.sender;
      if (!sender) {
        try {
          sender = await this.client.getEntity(sid);
        } catch {}
      }
      d.senderName = sender ? displayName(sender) : '';
    }
    return d;
  }

  caption(d) {
    const lines = ['📥 <b>آرشیو شد</b>', cards.LINE];
    lines.push(`🗂 نوع: <b>${d.kind}</b>`);
    if (d.size) lines.push(`💾 حجم: <b>${humanBytes(d.size)}</b>`);
    if (d.chatTitle) lines.push(`💬 منبع: <b>${esc(d.chatTitle)}</b>`);
    if (d.senderName && d.senderName !== d.chatTitle) lines.push(`👤 فرستنده: <b>${esc(d.senderName)}</b>`);
    if (d.date) lines.push(`🗓 زمان اصلی: <i>${d.date}</i>`);
    if (d.link) lines.push(d.link);
    if (d.ttl) lines.push('', '⏳ <b>رسانه محوشونده — بلافاصله ذخیره شد</b>');
    return lines.join('\n').slice(0, 1024);
  }

  albumMetaText(count, d) {
    const lines = [`🗃 <b>آلبومِ ${count} رسانه‌ای ذخیره شد</b>`, cards.LINE];
    if (d.chatTitle) lines.push(`💬 منبع: <b>${esc(d.chatTitle)}</b>`);
    if (d.senderName && d.senderName !== d.chatTitle) lines.push(`👤 فرستنده: <b>${esc(d.senderName)}</b>`);
    if (d.date) lines.push(`🗓 زمان اصلی: <i>${d.date}</i>`);
    if (d.link) lines.push(d.link);
    return lines.join('\n').slice(0, 1024);
  }

  async safeEdit(message, text) {
    try {
      await message.edit({ text, parseMode: 'html', linkPreview: false });
    } catch {}
  }

  hide(message) {
    message.delete().catch(() => {});
  }

  async fail(message, errText) {
    await this.safeEdit(message, cards.errorCard(errText));
  }

  async react(msg) {
    try {
      const peer = await this.client.getInputEntity(msg.chatId);
      await this.client.invoke(new Api.messages.SendReaction({
        peer,
        msgId: msg.id,
        reaction: [new Api.ReactionEmoji({ emoticon: '⚡️' })],
      }));
    } catch {}
  }

  progressHook(statusMsg, d) {
    if (!statusMsg) return () => {};
    let lastPct = -1;
    let lastStage = '';
    let lastAt = 0;
    return (stage, received, total) => {
      const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
      const now = Date.now();
      if (stage !== lastStage || pct - lastPct >= 10 || now - lastAt > 1500) {
        lastStage = stage;
        lastPct = pct;
        lastAt = now;
        this.safeEdit(statusMsg, cards.progressCard({
          stage,
          pct,
          kind: d.kind,
          size: humanBytes(d.size),
          urgent: d.ttl,
        }));
      }
    };
  }

  async runJob(job) {
    const { messages, statusMsg, explicit } = job;
    try {
      let result;
      if (messages.length === 1) {
        result = await this.archiveSingleFlow(messages[0], statusMsg);
      } else {
        result = await this.archiveAlbum(messages, statusMsg);
      }
      this.store.countArchive(result.bytes);
      if (statusMsg) this.hide(statusMsg);
      if (explicit && messages[0]) await this.react(messages[0]);
      return result;
    } catch (e) {
      const text = e?.errorMessage || e?.message || String(e);
      log.error('آرشیو ناموفق:', text);
      if (statusMsg) await this.fail(statusMsg, text);
      throw e;
    }
  }

  async archiveSingleFlow(msg, statusMsg) {
    const d = await this.describe(msg);
    if (statusMsg) {
      await this.safeEdit(statusMsg, cards.progressCard({
        stage: 'download',
        pct: 0,
        kind: d.kind,
        size: humanBytes(d.size),
        urgent: d.ttl,
      }));
    }
    return this.archiveSingle(msg, this.caption(d), this.progressHook(statusMsg, d));
  }

  async archiveSingle(msg, caption, hook) {
    try {
      await this.client.sendFile(this.dest, {
        file: msg.media,
        caption,
        parseMode: 'html',
        workers: 2,
      });
      return { bytes: Number(msg.file?.size || 0), method: 'direct' };
    } catch (e) {
      log.warn('ارسال مستقیم ناموفق؛ دانلود و بازآپلود…', e?.errorMessage || e?.message || '');
    }
    const fileName = guessFilename(msg);
    const tmpPath = path.join(this.tmpDir, `${msg.chatId ?? 'x'}_${msg.id}_${Date.now()}_${fileName}`);
    hook?.('download', 0, 1);
    await this.client.downloadMedia(msg, {
      outputFile: tmpPath,
      progressCallback: (r, t) => hook?.('download', r, t),
    });
    const stat = await fs.stat(tmpPath).catch(() => null);
    const bytes = stat?.size || 0;
    const attrs = rebuildAttributes(msg, fileName);
    const hasAnim = attrs.some((a) => a.className === 'DocumentAttributeAnimated');
    const hasVoice = attrs.some((a) => a.className === 'DocumentAttributeAudio' && a.voice);
    const hasRound = attrs.some((a) => a.className === 'DocumentAttributeVideo' && a.roundMessage);
    let forceDocument = /استیکر|داکیومنت|مسیج/.test(mediaKind(msg) || '');
    if (hasAnim || hasVoice || hasRound) forceDocument = false;
    const opts = {
      file: tmpPath,
      caption,
      parseMode: 'html',
      forceDocument,
      workers: 2,
      progressCallback: (r, t) => hook?.('upload', r, t),
    };
    if (attrs.length) opts.attributes = attrs;
    try {
      await this.client.sendFile(this.dest, opts);
    } finally {
      fs.rm(tmpPath, { force: true }).catch(() => {});
    }
    return { bytes, method: 'reupload' };
  }

  async archiveAlbum(msgs, statusMsg) {
    const head = await this.describe(msgs[0]);
    const bytes = msgs.reduce((sum, m) => sum + Number(m.file?.size || 0), 0);
    try {
      if (statusMsg) {
        await this.safeEdit(statusMsg, cards.albumCard(msgs.length, head.kind, humanBytes(bytes)));
      }
      await this.client.sendFile(this.dest, {
        file: msgs.map((m) => m.media),
        workers: 3,
      });
    } catch (e) {
      log.warn('آلبوم مستقیم ارسال نشد؛ روش جایگزین…', e?.errorMessage || e?.message || '');
      let i = 0;
      for (const m of msgs) {
        const d = i === 0 ? head : await this.describe(m);
        this.progressHook(statusMsg, d)('download', i + 1, msgs.length + 1);
        await this.archiveSingle(m, this.caption(d), this.progressHook(statusMsg, d));
        i += 1;
      }
    }
    await this.client.sendMessage(this.dest, {
      message: this.albumMetaText(msgs.length, head),
      parseMode: 'html',
      linkPreview: false,
    });
    return { bytes };
  }
}
