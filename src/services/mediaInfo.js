import { Api } from 'telegram';

export const MEDIA_LABELS = {
  photo: 'عکس 🖼',
  video: 'ویدیو 🎬',
  round: 'ویدیو مسیج 📹',
  gif: 'گیف 🎞',
  sticker: 'استیکر 🎭',
  voice: 'وویس 🎤',
  audio: 'آهنگ 🎵',
  document: 'داکیومنت 📄',
  media: 'رسانه 📎',
};

const TYPE_EXTENSIONS = {
  photo: '.jpg',
  video: '.mp4',
  round: '.mp4',
  gif: '.mp4',
  sticker: '.webp',
  voice: '.ogg',
  audio: '.mp3',
  document: '.bin',
  media: '.bin',
};

const MIME_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/flac': '.flac',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-tgsticker': '.tgs',
};

const UNSAFE_FILENAME = /[\x00-\x1f\\/:*?"<>|]/g;

/** gramjs sometimes hands back documents without an attributes array. */
function attributesOf(msg) {
  const list = msg?.document?.attributes;
  return Array.isArray(list) ? list : [];
}

export function findAttribute(msg, className) {
  return attributesOf(msg).find((attr) => attr?.className === className) || null;
}

/** Stable machine readable media type — never branch on the Persian labels. */
export function mediaType(msg) {
  if (!msg?.media) return null;
  if (msg.photo) return 'photo';
  if (msg.document) {
    if (findAttribute(msg, 'DocumentAttributeSticker')) return 'sticker';
    if (findAttribute(msg, 'DocumentAttributeAnimated')) return 'gif';
    const video = findAttribute(msg, 'DocumentAttributeVideo');
    if (video) return video.roundMessage ? 'round' : 'video';
    const audio = findAttribute(msg, 'DocumentAttributeAudio');
    if (audio) return audio.voice ? 'voice' : 'audio';
    return 'document';
  }
  return 'media';
}

export function mediaKind(msg) {
  const type = mediaType(msg);
  return type ? MEDIA_LABELS[type] ?? MEDIA_LABELS.media : null;
}

/** Seconds a one-time-view media survives after opening (0 when not TTL). */
export function ttlSeconds(msg) {
  const media = msg?.media;
  if (!media) return 0;
  if (media.className !== 'MessageMediaPhoto' && media.className !== 'MessageMediaDocument') return 0;
  return Number(media.ttlSeconds) || 0;
}

export function isSelfDestruct(msg) {
  return ttlSeconds(msg) > 0;
}

/** True for TTL media *and* messages inside chats with an auto-delete timer. */
export function isExpiring(msg) {
  return isSelfDestruct(msg) || Number(msg?.ttlPeriod) > 0;
}

/**
 * Re-uploading as a plain file only makes sense where Telegram cannot rebuild
 * the original bubble (documents, stickers). Voice, round video and gif must
 * keep their native type or they lose playback behaviour.
 */
export function shouldForceDocument(msg) {
  const type = mediaType(msg);
  return type === 'document' || type === 'sticker';
}

export function sanitizeFilename(name, fallback = 'file') {
  const cleaned = String(name ?? '')
    .replace(UNSAFE_FILENAME, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || fallback).slice(0, 120);
}

export function guessFilename(msg) {
  const type = mediaType(msg) || 'media';
  const named = findAttribute(msg, 'DocumentAttributeFilename');
  if (named?.fileName) return sanitizeFilename(named.fileName, `elegram_${msg?.id ?? 0}`);
  const mime = msg?.document?.mimeType;
  const ext = MIME_EXTENSIONS[mime] || TYPE_EXTENSIONS[type] || '.bin';
  const prefix = type === 'photo' ? 'photo' : 'elegram';
  return `${prefix}_${msg?.id ?? 0}${ext}`;
}

/** Rebuilds document attributes so a re-uploaded file keeps its metadata. */
export function rebuildAttributes(msg, fileName) {
  if (!msg?.document) return [];
  const out = [];
  let hasFilename = false;
  for (const attr of attributesOf(msg)) {
    try {
      switch (attr.className) {
        case 'DocumentAttributeFilename':
          out.push(new Api.DocumentAttributeFilename({ fileName }));
          hasFilename = true;
          break;
        case 'DocumentAttributeAudio':
          out.push(new Api.DocumentAttributeAudio({
            voice: attr.voice,
            duration: attr.duration,
            title: attr.title,
            performer: attr.performer,
            waveform: attr.waveform,
          }));
          break;
        case 'DocumentAttributeVideo':
          out.push(new Api.DocumentAttributeVideo({
            duration: attr.duration,
            w: attr.w,
            h: attr.h,
            roundMessage: attr.roundMessage,
            supportsStreaming: attr.supportsStreaming,
            nosound: attr.nosound,
          }));
          break;
        case 'DocumentAttributeImageSize':
          out.push(new Api.DocumentAttributeImageSize({ w: attr.w, h: attr.h }));
          break;
        case 'DocumentAttributeAnimated':
          out.push(new Api.DocumentAttributeAnimated());
          break;
        case 'DocumentAttributeSticker':
          out.push(new Api.DocumentAttributeSticker({
            alt: attr.alt,
            stickerset: attr.stickerset,
            maskCoords: attr.maskCoords,
          }));
          break;
        default:
          break;
      }
    } catch {
      /* skip malformed attribute */
    }
  }
  if (out.length && !hasFilename) {
    out.unshift(new Api.DocumentAttributeFilename({ fileName }));
  }
  return out;
}

export function buildLink(msg) {
  const id = msg?.id;
  if (!id) return '';
  const chatId = msg?.chatId != null ? String(msg.chatId) : '';
  const username = msg?.chat?.username;
  if (username) return `<a href="https://t.me/${username}/${id}">🔗 مشاهده پیام اصلی</a>`;
  if (chatId.startsWith('-100')) {
    return `<a href="https://t.me/c/${chatId.slice(4)}/${id}">🔗 مشاهده پیام اصلی</a>`;
  }
  if (/^\d+$/.test(chatId)) {
    return `<a href="tg://openmessage?user_id=${chatId}&amp;message_id=${id}">🔗 مشاهده پیام اصلی</a>`;
  }
  return '';
}

export function displayName(entity) {
  if (!entity) return '';
  if (entity.title) return entity.title;
  const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim();
  return name || entity.username || (entity.id != null ? String(entity.id) : '');
}
