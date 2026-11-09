// Password hashing with Node's built-in scrypt (memory-hard, no native dependency).
// Stored as "scrypt$N$r$p$<salt b64>$<hash b64>" so parameters can be raised later.
const { scrypt, randomBytes, timingSafeEqual } = require('crypto');

const N = 2 ** 16; // ~64 MB, a few hundred ms: slow for attackers, fine for a login
const R = 8;
const P = 1;
const KEY_LEN = 64;

const derive = (password, salt, n, r, p) =>
  new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LEN, { N: n, r, p, maxmem: 256 * n * r }, (err, key) => (err ? reject(err) : resolve(key))),
  );

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const [scheme, n, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Verifying against this when the email doesn't exist keeps both cases equally slow,
// so response time doesn't reveal which emails have accounts.
let dummyHash = null;
async function verifyDummy(password) {
  dummyHash ||= await hashPassword('not-a-real-password');
  await verifyPassword(password, dummyHash);
  return false;
}

module.exports = { hashPassword, verifyPassword, verifyDummy };
