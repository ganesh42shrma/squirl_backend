// Recognises JPEG / PNG / WebP by their first bytes (never by file name or the client's Content-Type) and
// reads the pixel size from the header. Pure, and strict on purpose: if the header can't be understood the
// file is not accepted as an image.

const MAX_SIDE = 16384;
const MAX_PIXELS = 80_000_000;

const u16be = (b, i) => b.readUInt16BE(i);
const u32be = (b, i) => b.readUInt32BE(i);
const u16le = (b, i) => b.readUInt16LE(i);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

// SOF markers carry the frame size: C0-CF except C4 (DHT), C8 (reserved) and CC (DAC).
const isSof = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function jpegSize(b) {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i + 1] === 0xff) i += 1; // fill bytes
    const marker = b[i + 1];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; } // no length field
    if (marker === 0xd9 || marker === 0xda) return null; // image data starts before any frame header
    const length = u16be(b, i + 2);
    if (length < 2) return null;
    if (isSof(marker)) {
      if (i + 9 > b.length) return null;
      const height = u16be(b, i + 5);
      const width = u16be(b, i + 7);
      // A real file ends with the end-of-image marker; a cut-off upload doesn't.
      if (b.indexOf(Buffer.from([0xff, 0xd9]), i + 9) < 0) return null;
      return { width, height };
    }
    i += 2 + length;
  }
  return null;
}

function pngSize(b) {
  // 8-byte signature, then the IHDR chunk: length 13, "IHDR", width, height.
  if (b.length < 33 || u32be(b, 8) !== 13 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  const end = b.lastIndexOf('IEND');
  if (end < 33 || end + 8 > b.length) return null; // no complete end chunk (type + CRC): cut-off upload
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function webpSize(b) {
  if (b.length < 30) return null;
  if (b.readUInt32LE(4) + 8 > b.length) return null; // RIFF length says more than we got: cut off
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    return {
      width: 1 + (b[21] | ((b[22] & 0x3f) << 8)),
      height: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)),
    };
  }
  if (kind === 'VP8X') return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  return null;
}

/** Returns { mime, width, height } for a recognisable, complete-looking image, otherwise null. */
function inspectImage(buffer) {
  const b = buffer;
  if (!Buffer.isBuffer(b) || b.length < 16) return null;
  let mime;
  let size;
  try {
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) { mime = 'image/jpeg'; size = jpegSize(b); }
    else if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) { mime = 'image/png'; size = pngSize(b); }
    else if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') { mime = 'image/webp'; size = webpSize(b); }
  } catch {
    return null; // a read past the end of a truncated header
  }
  if (!size || size.width < 1 || size.height < 1) return null;
  return { mime, ...size };
}

// Rejects absurd dimensions (decompression bombs): a few KB of PNG can claim a billion pixels.
const dimensionsAllowed = ({ width, height }) => width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_PIXELS;

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

module.exports = { MAX_SIDE, MAX_PIXELS, EXTENSIONS, inspectImage, dimensionsAllowed };
