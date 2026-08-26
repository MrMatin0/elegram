/**
 * Media introspection.
 *
 * Everything here is duck-typed against teleproto's parsed TL objects and
 * imports nothing, which keeps it unit-testable without a Telegram connection.
 * Anything that needs to *construct* TL objects lives in `attributes.js`.
 */

export const MEDIA_LABELS = Object.freeze({
  photo: 'عکس \u{1F5BC}',
  video: 'ویدیو \u{1F3AC}',
  round: 'ویدیو مسیج \u{1F4F9}',
  gif: 'گیف \u{1F39E}',
  sticker: 'استیکر \u{1F3AD}',
  voice: 'وویس \u{1F3A4}',
  audio: 'آهنگ \u{1F3B5}',
  document: 'داکیومنت \u{1F4C4}',
  media: 'رسانه \u{1F4CE}',
});

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
  'video/x-matroska': '.mkv',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/flac': '.flac',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-tgsticker': '.tgs',
};

/**
 * Every character a file name must not carry: the C0 control range, DEL, and
 * the separators/reserved characters POSIX and Windows choke on.
 *
 * The leading `\x00-` is what makes this a *range*. Written without it the dash
 * was a literal member of the class, so control bytes sailed through while
 * every hyphen in a perfectly good file name got rewritten to `_`.
 */
const UNSAFE_FILENAME = /[\x00-\x1f\x7f\\/:*?"<>|]/g;

/** Telegram ids arrive as BigInt-like objects; never compare them with `===`. */
export const idStr = (value) => (value == null ? '' : String(value));

/** teleproto sometimes hands back a document without an attributes array. */
export function attributesOf(msg) {
  const list = msg?.document?.attributes;
  return Array.isArray(list) ? list : [];
}

export function findAttribute(msg, className) {
  return attributesOf(msg).find((attr) => attr?.className === className) ?? null;
}

/** Stable machine-readable media type. Never branch on the Persian labels. */
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

/** Declared size in bytes, coerced out of whatever numeric shape it arrives in. */
export function mediaSize(msg) {
  const value = Number(msg?.file?.size ?? msg?.document?.size ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Seconds a one-time-view media survives after being opened (0 when not TTL). */
export function ttlSeconds(msg) {
  const media = msg?.media;
  if (!media) return 0;
  if (media.className !== 'MessageMediaPhoto' && media.className !== 'MessageMediaDocument') return 0;
  const value = Number(media.ttlSeconds);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function isSelfDestruct(msg) {
  return ttlSeconds(msg) > 0;
}

/** True for TTL media *and* for messages in a chat with an auto-delete timer. */
export function isExpiring(msg) {
  if (isSelfDestruct(msg)) return true;
  const period = Number(msg?.ttlPeriod);
  return Number.isFinite(period) && period > 0;
}

/**
 * Re-uploading as a plain file only makes sense where Telegram cannot rebuild
 * the original bubble. Voice, round video and gif must keep their native type
 * or they lose their playback behaviour.
 */
export function shouldForceDocument(msg) {
  const type = mediaType(msg);
  return type === 'document' || type === 'sticker';
}

export function sanitizeFilename(name, fallback = 'file') {
  const cleaned = String(name ?? '')
    .replace(UNSAFE_FILENAME, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned || fallback).slice(0, 120);
}

export function guessFilename(msg) {
  const type = mediaType(msg) ?? 'media';
  const named = findAttribute(msg, 'DocumentAttributeFilename');
  if (named?.fileName) return sanitizeFilename(named.fileName, `elegram_${msg?.id ?? 0}`);
  const ext = MIME_EXTENSIONS[msg?.document?.mimeType] ?? TYPE_EXTENSIONS[type] ?? '.bin';
  const prefix = type === 'photo' ? 'photo' : 'elegram';
  return `${prefix}_${msg?.id ?? 0}${ext}`;
}

/** Deep link back to the original message, when one can be built. */
export function buildMessageLink(msg) {
  const id = msg?.id;
  if (!id) return '';
  const chatId = idStr(msg?.chatId);
  const username = msg?.chat?.username;
  if (username) return `https://t.me/${username}/${id}`;
  if (chatId.startsWith('-100')) return `https://t.me/c/${chatId.slice(4)}/${id}`;
  if (/^\d+$/.test(chatId)) return `tg://openmessage?user_id=${chatId}&message_id=${id}`;
  return '';
}

export function displayName(entity) {
  if (!entity) return '';
  if (entity.title) return String(entity.title);
  const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim();
  return name || (entity.username ? String(entity.username) : idStr(entity.id));
}
