// Turns a picked file into two downscaled JPEGs: a display copy and a thumbnail.
// iPhone photos are 4–8 MB each; storing originals would exhaust the IndexedDB
// quota within a few dozen kits, so the originals are deliberately discarded.

const DISPLAY_MAX = 1600;
const THUMB_MAX = 400;
const QUALITY = 0.82;

async function decode(file) {
  // `imageOrientation: 'from-image'` applies the EXIF rotation that iPhone
  // photos carry, so portrait shots don't come out sideways.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Older Safari rejects the options bag; fall through to the <img> path.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('could not decode image'));
      img.src = url;
    });
    return img;
  } finally {
    // Safe to revoke: the decoded bitmap no longer references the URL.
    URL.revokeObjectURL(url);
  }
}

function scaleTo(source, max) {
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const ratio = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * ratio)), h: Math.max(1, Math.round(h * ratio)) };
}

function toBlob(canvas) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', QUALITY);
  });
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function render(source, max) {
  const { w, h } = scaleTo(source, max);
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  // JPEG has no alpha; paint white so transparent PNGs don't come out black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  return toBlob(canvas);
}

/**
 * @returns {Promise<{id: string, blob: Blob, thumbBlob: Blob}>}
 */
export async function processImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('That file is not an image.');
  const source = await decode(file);
  try {
    const [blob, thumbBlob] = await Promise.all([
      render(source, DISPLAY_MAX),
      render(source, THUMB_MAX),
    ]);
    return { id: crypto.randomUUID(), blob, thumbBlob };
  } finally {
    source.close?.();
  }
}

/* ── Object URL bookkeeping ───────────────────────────────────── */
// Views create URLs while rendering and call releaseURLs() on teardown.
// Without this, a photo grid leaks every blob URL it ever created.

export function trackURL(bag, blob) {
  const url = URL.createObjectURL(blob);
  bag.push(url);
  return url;
}

export function releaseURLs(bag) {
  for (const url of bag) URL.revokeObjectURL(url);
  bag.length = 0;
}

/* ── Base64 bridging, for JSON export/import ──────────────────── */

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function dataURLToBlob(dataURL) {
  const res = await fetch(dataURL);
  return res.blob();
}
