// Normalise an uploaded photo for the vision model:
// auto-rotate by EXIF, flatten transparency onto white, longest side <= 2000 px, JPEG.

import sharp from 'sharp';

export class ImageError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ImageError';
    this.status = status;
  }
}

export const MAX_SIDE = 2000;

/** True if the bytes look like a HEIC/HEIF file (iPhone photos). */
export function isHeic(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf.toString('latin1', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('latin1', 8, 12);
  return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand);
}

/**
 * @param {Buffer} buf uploaded file bytes
 * @returns {Promise<{buffer:Buffer, width:number, height:number}>}
 */
export async function normaliseImage(buf) {
  if (!buf || !buf.length) throw new ImageError('Filen er tom. Vælg et billede af noderne.');
  const heic = isHeic(buf);
  try {
    const { data, info } = await sharp(buf, { failOn: 'none', limitInputPixels: 100_000_000 })
      .rotate() // EXIF orientation
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  } catch (err) {
    if (heic) {
      throw new ImageError(
        'HEIC-billeder (iPhone-format) kan desværre ikke læses her. Tag et skærmbillede af fotoet, eller vælg "Mest kompatibel" under Indstillinger → Kamera → Formater, og prøv igen.',
        415,
      );
    }
    throw new ImageError('Filen kunne ikke læses som et billede. Brug et JPEG- eller PNG-billede af noderne.', 415);
  }
}
