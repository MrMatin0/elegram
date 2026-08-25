import { Api } from 'teleproto';
import { attributesOf } from './mediaInfo.js';

/**
 * Rebuilds document attributes for a re-uploaded file.
 *
 * A download/re-upload round trip loses everything Telegram used to render the
 * bubble: duration, dimensions, waveform, "is a voice note", sticker set. We
 * reconstruct the attributes we understand and drop the rest, because a
 * malformed attribute rejects the whole upload.
 */
export function rebuildAttributes(msg, fileName) {
  if (!msg?.document) return [];
  const out = [];
  let hasFilename = false;

  for (const attr of attributesOf(msg)) {
    try {
      switch (attr?.className) {
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
      /* skip a malformed attribute rather than lose the whole file */
    }
  }

  if (out.length && !hasFilename) {
    out.unshift(new Api.DocumentAttributeFilename({ fileName }));
  }
  return out;
}
