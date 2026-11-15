// Encrypts one image for storage. Pure functions: no files, no config, no logging.
//
// On-disk (and in-bucket) layout:  "SQM1" | iv (12 bytes) | ciphertext | GCM tag (16 bytes)
// Each file gets its own key, derived from the master key and the media id, plus its own random IV.
// The tag also covers `userId:mediaId`, so a file copied to another media id or another account's row
// fails to decrypt instead of being served.
const { createCipheriv, createDecipheriv, hkdfSync, randomBytes } = require('node:crypto');

const MAGIC = Buffer.from('SQM1');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const OVERHEAD = MAGIC.length + IV_LENGTH + TAG_LENGTH;

// Accepts 32 bytes as base64 (standard or URL-safe) or 64 hex characters. Returns null for anything else.
function parseKey(text) {
  const value = String(text || '').trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(value)) {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length === 32) return bytes;
  }
  return null;
}

const fileKey = (masterKey, mediaId) => Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), `squirl-media-v1:${mediaId}`, 32));
const aad = (userId, mediaId) => Buffer.from(`${userId}:${mediaId}`);

function encrypt(masterKey, userId, mediaId, plaintext) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', fileKey(masterKey, mediaId), iv);
  cipher.setAAD(aad(userId, mediaId));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

// Throws (a plain Error) for a wrong key, a wrong owner, a modified file or anything that isn't ours.
function decrypt(masterKey, userId, mediaId, data) {
  if (data.length < OVERHEAD || !data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an encrypted media file');
  const iv = data.subarray(MAGIC.length, MAGIC.length + IV_LENGTH);
  const tag = data.subarray(data.length - TAG_LENGTH);
  const body = data.subarray(MAGIC.length + IV_LENGTH, data.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', fileKey(masterKey, mediaId), iv);
  decipher.setAAD(aad(userId, mediaId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

module.exports = { MAGIC, OVERHEAD, parseKey, encrypt, decrypt };
