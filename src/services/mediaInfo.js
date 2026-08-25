import { Api } from 'telegram';

export function mediaKind(msg) {
  if (!msg || !msg.media) return null;
  if (msg.photo) return 'عکس 🖼';
  const doc = msg.document;
  if (doc) {
    const classes = new Set(doc.attributes.map((a) => a.className));
    if (classes.has('DocumentAttributeSticker')) return 'استیکر 🎭';
    if (classes.has('DocumentAttributeAnimated')) return 'گیف 🎞';
    if (classes.has('DocumentAttributeVideo')) {
      const v = doc.attributes.find((a) => a.className === 'DocumentAttributeVideo');
      return v?.roundMessage ? 'ویدیو مسیج 📹' : 'ویدیو 🎬';
    }
    if (classes.has('DocumentAttributeAudio')) {
      const a = doc.attributes.find((x) => x.className === 'DocumentAttributeAudio');
      return a?.voice ? 'وویس 🎤' : 'آهنگ 🎵';
    }
    return 'داکیومنت 📄';
  }
  return 'رسانه 📎';
}

export function isSelfDestruct(msg) {
  if (!msg) return false;
  if (msg.ttlPeriod) return true;
  const m = msg.media;
  if (!m) return false;
  if (m.className !== 'MessageMediaPhoto' && m.className !== 'MessageMediaDocument') return false;
  return Boolean(m.ttlSeconds);
}

export function guessFilename(msg) {
  const doc = msg?.document;
  if (doc) {
    const f = doc.attributes.find((a) => a.className === 'DocumentAttributeFilename');
    if (f?.fileName) return f.fileName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    const extMap = {
      'ویدیو 🎬': '.mp4',
      'گیف 🎞': '.mp4',
      'استیکر 🎭': '.webp',
      'وویس 🎤': '.ogg',
      'آهنگ 🎵': '.mp3',
      'ویدیو مسیج 📹': '.mp4',
    };
    const ext = extMap[mediaKind(msg)] || '.bin';
    return `elegram_${msg.id}${ext}`;
  }
  if (msg?.photo) return `photo_${msg.id}.jpg`;
  return `file_${msg?.id ?? 0}`;
}

export function rebuildAttributes(msg, fileName) {
  const doc = msg?.document;
  if (!doc) return [];
  const out = [];
  for (const a of doc.attributes) {
    try {
      switch (a.className) {
        case 'DocumentAttributeFilename':
          out.push(new Api.DocumentAttributeFilename({ fileName }));
          break;
        case 'DocumentAttributeAudio':
          out.push(new Api.DocumentAttributeAudio({
            voice: a.voice,
            duration: a.duration,
            title: a.title,
            performer: a.performer,
            waveform: a.waveform,
          }));
          break;
        case 'DocumentAttributeVideo':
          out.push(new Api.DocumentAttributeVideo({
            duration: a.duration,
            w: a.w,
            h: a.h,
            roundMessage: a.roundMessage,
            supportsStreaming: a.supportsStreaming,
            nosound: a.nosound,
          }));
          break;
        case 'DocumentAttributeAnimated':
          out.push(new Api.DocumentAttributeAnimated());
          break;
        case 'DocumentAttributeSticker':
          out.push(new Api.DocumentAttributeSticker({
            alt: a.alt,
            stickerset: a.stickerset,
            maskCoords: a.maskCoords,
          }));
          break;
        default:
          break;
      }
    } catch {
      /* skip malformed attribute */
    }
  }
  return out;
}

export function buildLink(msg) {
  const cid = msg?.chatId != null ? String(msg.chatId) : '';
  const mid = msg?.id;
  if (!mid) return '';
  const uname = msg.chat?.username;
  if (uname) return `<a href="https://t.me/${uname}/${mid}">🔗 مشاهده پیام اصلی</a>`;
  if (cid.startsWith('-100')) return `<a href="https://t.me/c/${cid.slice(4)}/${mid}">🔗 مشاهده پیام اصلی</a>`;
  if (/^\d+$/.test(cid)) return `<a href="tg://openmessage?user_id=${cid}&message_id=${mid}">🔗 مشاهده پیام اصلی</a>`;
  return '';
}

export function displayName(entity) {
  if (!entity) return '';
  if (entity.title) return entity.title;
  const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim();
  return name || entity.username || (entity.id != null ? String(entity.id) : '');
}
