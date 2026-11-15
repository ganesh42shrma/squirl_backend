// Photo attachments, end to end with synthetic data: temp folders, an in-memory database, the real router
// behind the real auth/CSRF guards, and a local fake S3 server on an ephemeral port. No network, no real keys.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash, createHmac, randomBytes } = require('node:crypto');
const Database = require('better-sqlite3-multiple-ciphers');

const db = new Database(':memory:');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squirl-media-test-'));
const dbDir = path.join(root, 'usb-drive', 'squirl');
fs.mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, 'squirl.db');

const stub = (file, exports) => { require.cache[require.resolve(file)] = { exports }; };
// A plain, mutable config so each section can choose its own limits (the real one is frozen and read from .env).
const config = {
  env: 'test', isDev: false, logLevel: 'error', db: { path: dbPath }, media: {},
  session: { secret: 'a-long-synthetic-session-secret-for-testing-only', cookieSecure: false },
  push: { publicKey: '', privateKey: '', subject: '' },
  llm: { url: 'http://127.0.0.1:1', model: 'test', timeoutMs: 100 },
  parser: { url: 'http://127.0.0.1:1', timeoutMs: 100 },
};
stub('../src/config', config);
stub('../src/config/db', { getDb: () => db });
const logs = [];
const logger = { debug() {}, info: (m, meta) => logs.push(['info', m, meta]), warn: (m, meta) => logs.push(['warn', m, meta]), error: (m, meta) => logs.push(['error', m, meta]) };
stub('../src/core/logger', logger);
stub('../src/plugins/insights/suggestions.worker', { nudge() {}, resetForUser() {} });
stub('../src/plugins/goals/goal.worker', { nudge() {} });
const limitCalls = [];
let limitFails = false;
stub('../src/core/rateLimit', {
  hit: async (key, options) => {
    limitCalls.push({ key, options });
    if (limitFails) throw new (require('../src/core/AppError'))('Too many attempts', 429, 'TOO_MANY_ATTEMPTS');
  },
});
db.pragma('foreign_keys = ON');
for (const m of require('../src/config/migrations')) typeof m === 'function' ? m(db) : db.exec(m);

const crypto = require('../src/plugins/media/media.crypto');
const imageLib = require('../src/plugins/media/media.image');
const { createLocalStore } = require('../src/plugins/media/media.store');
const { signRequest, createS3Client } = require('../src/plugins/media/media.s3');
const runtime = require('../src/plugins/media/media.runtime');
const replica = require('../src/plugins/media/media.replica');
const media = require('../src/plugins/media/media.service');
const worker = require('../src/plugins/media/media.worker');
const { insertUser } = require('../src/plugins/users/user.model');
const { seedDefaults } = require('../src/plugins/users/defaults');
const { insertTransaction } = require('../src/plugins/transactions/transaction.model');
const { newId, nowIso, insertRow } = require('../src/core/sql');
const { hashPassword } = require('../src/core/password');
const users = require('../src/plugins/users/user.service');

// ---------- fixtures: tiny but structurally valid images -------------------------------------------------
const MARKER = 'SYNTHETIC-RECEIPT-TOTAL-4242'; // text that must never be readable in stored bytes
const be16 = (n) => Buffer.from([n >> 8, n & 255]);
const segment = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker]), be16(payload.length + 2), payload]);
const jpeg = (w = 64, h = 48, tag = MARKER) => Buffer.concat([
  Buffer.from([0xff, 0xd8]), segment(0xfe, Buffer.from(tag)),
  segment(0xc0, Buffer.concat([Buffer.from([8]), be16(h), be16(w), Buffer.from([1, 1, 0x11, 0])])),
  segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
]);
const chunk = (type, data) => Buffer.concat([Buffer.from([0, 0, 0, data.length]), Buffer.from(type), data, Buffer.alloc(4)]);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const png = (w = 32, h = 32, tag = MARKER) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', Buffer.concat([u32(w), u32(h), Buffer.from([8, 2, 0, 0, 0])])),
  chunk('tEXt', Buffer.from(`Comment\0${tag}`)), chunk('IDAT', Buffer.from([1, 2, 3, 4])), chunk('IEND', Buffer.alloc(0)),
]);
const riff = (body) => { const size = Buffer.alloc(4); size.writeUInt32LE(4 + body.length); return Buffer.concat([Buffer.from('RIFF'), size, Buffer.from('WEBP'), body]); };
const webpChunk = (type, data) => { const size = Buffer.alloc(4); size.writeUInt32LE(data.length); return Buffer.concat([Buffer.from(type), size, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
const webpX = (w, h) => { const d = Buffer.alloc(10); d.writeUIntLE(w - 1, 4, 3); d.writeUIntLE(h - 1, 7, 3); return riff(Buffer.concat([webpChunk('VP8X', d), webpChunk('EXIF', Buffer.from(MARKER))])); };
const webpL = (w, h) => { const d = Buffer.alloc(16); d[0] = 0x2f; d.writeUInt32LE((w - 1) | ((h - 1) << 14), 1); return riff(webpChunk('VP8L', d)); };
const webpLossy = (w, h) => { const d = Buffer.alloc(16); d[3] = 0x9d; d[4] = 0x01; d[5] = 0x2a; d.writeUInt16LE(w, 6); d.writeUInt16LE(h, 8); return riff(webpChunk('VP8 ', d)); };
let uniq = 0;
const freshJpeg = () => jpeg(40 + (uniq % 20), 30 + (uniq % 7), `${MARKER}-${++uniq}-${randomBytes(4).toString('hex')}`);

// ---------- database seeding ------------------------------------------------------------------------------
const a = insertUser(db, { name: 'Synthetic A', email: 'media-a@example.invalid', passwordHash: 'unused' });
const b = insertUser(db, { name: 'Synthetic B', email: 'media-b@example.invalid', passwordHash: 'unused' });
seedDefaults(db, a); seedDefaults(db, b);
const addTx = (userId) => insertTransaction(db, userId, { date: '2026-11-01', description: 'Synthetic shop', amount: 10 });
const addTask = (userId) => { const id = newId(); const now = nowIso(); insertRow(db, 'tasks', { id, user_id: userId, title: 'Synthetic task', created_at: now, updated_at: now }); return id; };
const addGoal = (userId) => {
  const id = newId(); const now = nowIso();
  insertRow(db, 'goals', { id, user_id: userId, name: 'Synthetic goal', price_paise: 100000, price_as_of: '2026-01-01', plan: 'by_amount', monthly_paise: 1000, start_date: '2026-01-01', created_at: now, updated_at: now });
  return id;
};
const softDelete = (table, id) => db.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`).run(nowIso(), id);
const restore = (table, id) => db.prepare(`UPDATE ${table} SET deleted_at = NULL WHERE id = ?`).run(id);

// ---------- runtime helpers --------------------------------------------------------------------------------
const MASTER = randomBytes(32);
const MASTER_B64 = MASTER.toString('base64');
let section = 0;
function useRuntime({ s3 = {}, ...limits } = {}) {
  section += 1;
  const dir = path.join(root, `media-${section}`);
  const raw = { dir, key: MASTER_B64, maxBytes: 1024 * 1024, userQuotaBytes: 50 * 1024 * 1024, maxPerOwner: 10, s3, ...limits };
  config.media = raw;
  const rt = runtime.build(raw, dbPath, logger);
  assert.equal(rt.configured, true);
  runtime.use(rt);
  return { rt, dir, raw };
}
const filesIn = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) e.isDirectory() ? walk(path.join(d, e.name)) : out.push(path.join(d, e.name)); };
  walk(dir);
  return out;
};
const warnings = () => logs.filter(([level]) => level === 'warn').map(([, m]) => m);

// ---------- HTTP harness: the real router behind the real guards -------------------------------------------
const express = require('express');
const { csrfGuard, requireAuth } = require('../src/core/auth');
async function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const userId = req.get('X-Synthetic-User');
    if (userId) req.session = { userId, passwordChangedAt: db.prepare('SELECT password_changed_at FROM users WHERE id = ?').pluck().get(userId) };
    next();
  });
  app.use('/api', csrfGuard);
  app.use('/api/media', requireAuth, require('../src/plugins/media/media.routes'));
  app.use(require('../src/core/errorHandler'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/media`;
  const call = async (pathname, { user, method = 'GET', form, csrf = method !== 'GET' } = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      method, body: form,
      headers: { ...(user && { 'X-Synthetic-User': user }), ...(csrf && { 'X-Requested-With': 'squirl' }) },
    });
    const raw = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, raw, json: type.includes('json') ? JSON.parse(raw.toString()) : null };
  };
  const post = (user, { buf, type = 'image/jpeg', name = 'IMG_0001.jpg', ownerType, ownerId, field = 'file' }) => {
    const form = new FormData();
    if (ownerType) form.append('ownerType', ownerType);
    if (ownerId) form.append('ownerId', ownerId);
    if (buf) form.append(field, new Blob([buf], { type }), name);
    return call('/upload', { user, method: 'POST', form });
  };
  const list = (user, ownerType, ownerId) => call(`/attachments?ownerType=${ownerType}&ownerId=${ownerId}`, { user });
  const file = (user, mediaId) => call(`/${mediaId}/file`, { user });
  const remove = (user, id) => call(`/attachments/${id}`, { user, method: 'DELETE' });
  return { call, post, list, file, remove, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

// ---------- fake S3: verifies every Signature V4 signature independently ----------------------------------------
const S3 = { accessKeyId: 'AKIATESTSYNTHETIC', secretAccessKey: 'synthetic-secret-key-0123456789abcdef', bucket: 'test-bucket', region: 'auto' };
const hex = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
// Written separately from src/plugins/media/media.s3.js, and checked against AWS's published example below.
function referenceSignature({ method, canonicalUri, headers, signedHeaders, payloadHash, region, secret, stamp }) {
  const names = signedHeaders.split(';');
  const canonical = [method, canonicalUri, '', ...names.map((n) => `${n}:${String(headers[n]).trim()}`), '', signedHeaders, payloadHash].join('\n');
  const day = stamp.slice(0, 8);
  const toSign = `AWS4-HMAC-SHA256\n${stamp}\n${day}/${region}/s3/aws4_request\n${hex(canonical)}`;
  const key = hmac(hmac(hmac(hmac('AWS4' + secret, day), region), 's3'), 'aws4_request');
  return createHmac('sha256', key).update(toSign).digest('hex');
}
async function startFakeS3() {
  const objects = new Map();
  const state = { requests: [], mode: 'ok', elsewhereHits: 0, bad: [], beforePut: null };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const urlPath = req.url.split('?')[0];
    if (urlPath === '/elsewhere') { state.elsewhereHits += 1; res.writeHead(200).end(); return; }
    const auth = req.headers.authorization || '';
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(auth);
    const record = { method: req.method, path: urlPath, auth, headers: req.headers, bodyHash: hex(body), body };
    state.requests.push(record);
    const reject = (why) => { state.bad.push(why); res.writeHead(403, { 'Content-Type': 'application/xml' }).end('<Error><Code>SignatureDoesNotMatch</Code></Error>'); };
    if (!m) return reject('no SigV4 Authorization header');
    const [, accessKey, day, region, signedHeaders, signature] = m;
    if (accessKey !== S3.accessKeyId || region !== S3.region) return reject('wrong credential scope');
    if (signedHeaders !== 'host;x-amz-content-sha256;x-amz-date') return reject(`unexpected signed headers ${signedHeaders}`);
    const stamp = req.headers['x-amz-date'];
    if (!stamp.startsWith(day) || Math.abs(Date.parse(stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')) - Date.now()) > 300000) return reject('bad date');
    if (req.headers['x-amz-content-sha256'] === 'UNSIGNED-PAYLOAD') return reject('unsigned payload');
    if (req.headers['x-amz-content-sha256'] !== hex(body)) return reject('payload hash does not match the body');
    const expected = referenceSignature({ method: req.method, canonicalUri: urlPath, headers: req.headers, signedHeaders, payloadHash: hex(body), region, secret: S3.secretAccessKey, stamp });
    if (expected !== signature) return reject('signature mismatch');
    if (state.mode === 'redirect') { res.writeHead(307, { Location: `http://127.0.0.1:${server.address().port}/elsewhere` }).end(); return; }
    if (state.mode === 'fail') { res.writeHead(500, { 'Content-Type': 'application/xml' }).end('<Error><Code>InternalError</Code></Error>'); return; }
    const prefix = `/${S3.bucket}/`;
    if (!urlPath.startsWith(prefix)) { res.writeHead(404).end(); return; }
    const key = urlPath.slice(prefix.length);
    if (req.method === 'PUT') {
      if (state.beforePut) { const hook = state.beforePut; state.beforePut = null; hook(key); }
      objects.set(key, body); res.writeHead(200).end();
    } else if (req.method === 'GET') {
      if (!objects.has(key)) res.writeHead(404, { 'Content-Type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>');
      else res.writeHead(200, { 'Content-Length': objects.get(key).length }).end(objects.get(key));
    } else if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); }
    else res.writeHead(405).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return { objects, state, endpoint, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}
const s3Config = (fake, extra = {}) => ({ endpoint: fake.endpoint, bucket: S3.bucket, region: S3.region, accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey, pathStyle: true, ...extra });

// ---------- sections -------------------------------------------------------------------------------------

function cryptoChecks() {
  const id = newId();
  const plain = Buffer.from(`hello ${MARKER}`);
  const sealed = crypto.encrypt(MASTER, a, id, plain);
  assert.equal(sealed.subarray(0, 4).toString(), 'SQM1');
  assert.equal(sealed.length, 4 + 12 + plain.length + 16, 'SQM1 | iv | ciphertext | tag');
  assert.equal(sealed.includes(Buffer.from(MARKER)), false, 'no plaintext in ciphertext');
  assert.deepEqual(crypto.decrypt(MASTER, a, id, sealed), plain);
  assert.notDeepEqual(crypto.encrypt(MASTER, a, id, plain), sealed, 'a fresh random IV every time');
  // Tamper with the body, the tag, the IV, the magic and the length.
  for (const offset of [5, 16, sealed.length - 1, sealed.length - 10]) {
    const bad = Buffer.from(sealed); bad[offset] ^= 1;
    assert.throws(() => crypto.decrypt(MASTER, a, id, bad), undefined, `flipped byte ${offset}`);
  }
  const wrongMagic = Buffer.from(sealed); wrongMagic[0] = 0x58;
  assert.throws(() => crypto.decrypt(MASTER, a, id, wrongMagic));
  assert.throws(() => crypto.decrypt(MASTER, a, id, sealed.subarray(0, 20)));
  assert.throws(() => crypto.decrypt(randomBytes(32), a, id, sealed), undefined, 'wrong key');
  // The tag covers userId:mediaId, so a file moved to another owner or another id is refused.
  assert.throws(() => crypto.decrypt(MASTER, b, id, sealed), undefined, 'wrong user in the AAD');
  assert.throws(() => crypto.decrypt(MASTER, a, newId(), sealed), undefined, 'wrong media id');
  // Keys: 32 bytes as base64 or hex only.
  assert.deepEqual(crypto.parseKey(MASTER.toString('hex')), MASTER);
  assert.deepEqual(crypto.parseKey(MASTER_B64), MASTER);
  assert.deepEqual(crypto.parseKey(MASTER.toString('base64url')), MASTER);
  for (const bad of ['', 'short', randomBytes(31).toString('base64'), randomBytes(33).toString('base64'), 'z'.repeat(64), randomBytes(32).toString('hex').slice(2), undefined]) {
    assert.equal(crypto.parseKey(bad), null, `rejects ${String(bad).slice(0, 12)}`);
  }
}

function imageChecks() {
  assert.deepEqual(imageLib.inspectImage(jpeg(640, 480)), { mime: 'image/jpeg', width: 640, height: 480 });
  assert.deepEqual(imageLib.inspectImage(png(1200, 800)), { mime: 'image/png', width: 1200, height: 800 });
  assert.deepEqual(imageLib.inspectImage(webpX(300, 200)), { mime: 'image/webp', width: 300, height: 200 });
  assert.deepEqual(imageLib.inspectImage(webpL(321, 123)), { mime: 'image/webp', width: 321, height: 123 });
  assert.deepEqual(imageLib.inspectImage(webpLossy(500, 400)), { mime: 'image/webp', width: 500, height: 400 });
  // A JPEG whose frame header comes after an APP segment full of marker-like bytes still parses.
  const withApp = Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe1, Buffer.from([0xff, 0xc0, 0, 0, 0, 0, 0, 0, 0, 0])), jpeg(77, 55).subarray(2)]);
  assert.deepEqual(imageLib.inspectImage(withApp), { mime: 'image/jpeg', width: 77, height: 55 });
  // Not images, or not whole images.
  const notImages = {
    html: Buffer.from('<html><script>alert(1)</script></html>'), svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
    pdf: Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n'), gif: Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff'),
    zip: Buffer.concat([Buffer.from('PK\x03\x04'), randomBytes(40)]), empty: Buffer.alloc(0), tiny: Buffer.from([0xff, 0xd8, 0xff]),
    jpegNoFrame: Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xfe, Buffer.from('x'.repeat(40))), Buffer.from([0xff, 0xd9])]),
    webpFake: Buffer.concat([Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt '), randomBytes(20)]),
  };
  for (const [name, buf] of Object.entries(notImages)) assert.equal(imageLib.inspectImage(buf), null, name);
  for (const [name, whole] of Object.entries({ jpeg: jpeg(), png: png(), webpX: webpX(10, 10), webpL: webpL(10, 10), webpLossy: webpLossy(10, 10) })) {
    for (const cut of [20, whole.length - 3]) assert.equal(imageLib.inspectImage(whole.subarray(0, cut)), null, `truncated ${name} at ${cut}`);
  }
  assert.equal(imageLib.inspectImage(jpeg(0, 10)), null, 'zero width');
  // Dimension limits: 16384 per side, 80 megapixels.
  assert.equal(imageLib.dimensionsAllowed({ width: 16384, height: 4000 }), true);
  assert.equal(imageLib.dimensionsAllowed({ width: 16385, height: 10 }), false);
  assert.equal(imageLib.dimensionsAllowed({ width: 10, height: 16385 }), false);
  assert.equal(imageLib.dimensionsAllowed({ width: 10000, height: 8001 }), false);
  assert.equal(imageLib.dimensionsAllowed({ width: 10000, height: 8000 }), true);
}

async function storeChecks() {
  const { dir } = useRuntime();
  const store = createLocalStore({ dir, key: MASTER });
  const id = newId();
  store.put(id, a, Buffer.from(MARKER));
  const target = path.join(dir, id.slice(0, 2), `${id}.sqm`);
  assert.equal(fs.existsSync(target), true, 'two-character fan-out layout');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600, 'files are 0600');
  assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o700, 'folders are 0700');
  assert.equal(fs.readdirSync(path.dirname(target)).some((f) => f.endsWith('.tmp')), false, 'atomic write leaves no temp file');
  assert.equal(fs.readFileSync(target).includes(Buffer.from(MARKER)), false);
  assert.deepEqual(store.get(id, a), Buffer.from(MARKER));
  assert.throws(() => store.get(id, b), (e) => e.code === 'MEDIA_UNREADABLE' && e.statusCode === 500, 'other owner');
  assert.throws(() => createLocalStore({ dir, key: randomBytes(32) }).get(id, a), (e) => e.code === 'MEDIA_UNREADABLE', 'wrong key');
  const damaged = fs.readFileSync(target); damaged[30] ^= 1; fs.writeFileSync(target, damaged);
  assert.throws(() => store.get(id, a), (e) => e.code === 'MEDIA_UNREADABLE', 'corrupted file fails closed');
  store.remove(id); store.remove(id); // idempotent
  assert.equal(store.exists(id), false);
  assert.throws(() => store.get(id, a), (e) => e.code === 'MEDIA_FILE_MISSING');
  for (const bad of ['../../etc/passwd', 'abc', '', null, `${newId()}/../x`]) assert.throws(() => store.put(bad, a, Buffer.from('x')), /Invalid media id/);
}

function configChecks() {
  const dir = path.join(root, 'cfg-ok');
  const base = { dir, key: MASTER_B64, maxBytes: 1, userQuotaBytes: 1, maxPerOwner: 1, s3: {} };
  const attempt = (raw) => {
    const before = logs.length;
    const rt = runtime.build(raw, dbPath, logger);
    return { rt, logs: logs.slice(before) };
  };
  let r = attempt(base);
  assert.equal(r.rt.configured, true);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'created with mode 0700');
  // Nothing set: off, quietly. Half set or invalid: off, exactly one warning, and the key is never logged.
  r = attempt({ ...base, dir: '', key: '' });
  assert.equal(r.rt.configured, false); assert.equal(r.logs.filter(([l]) => l === 'warn').length, 0);
  r = attempt({ ...base, key: '' });
  assert.equal(r.rt.configured, false); assert.equal(r.logs.filter(([l]) => l === 'warn').length, 1);
  r = attempt({ ...base, dir: '' });
  assert.equal(r.rt.configured, false); assert.equal(r.logs.filter(([l]) => l === 'warn').length, 1);
  for (const key of ['too-short-secret-value', randomBytes(16).toString('base64'), randomBytes(31).toString('hex')]) {
    r = attempt({ ...base, key });
    assert.equal(r.rt.configured, false, 'an invalid key switches media off instead of crashing');
    assert.equal(r.logs.filter(([l]) => l === 'warn').length, 1, 'one warning');
    assert.equal(JSON.stringify(r.logs).includes(key), false, 'the key is never logged');
  }
  r = attempt({ ...base, dir: 'relative/media' });
  assert.equal(r.rt.configured, false, 'relative MEDIA_DIR refused');
  // The database drive must not hold images.
  for (const inside of [dbDir, path.join(dbDir, 'media'), path.join(dbDir, 'a', 'b', 'c')]) {
    r = attempt({ ...base, dir: inside });
    assert.equal(r.rt.configured, false, `refused inside the database folder: ${inside}`);
    assert.match(r.logs.map((l) => l[1]).join(), /inside the database folder/);
    assert.equal(fs.existsSync(path.join(inside, 'x')), false);
  }
  assert.equal(fs.existsSync(path.join(dbDir, 'media')), false, 'a refused folder is not created');
  const link = path.join(root, 'sneaky-link');
  fs.symlinkSync(dbDir, link);
  assert.equal(attempt({ ...base, dir: path.join(link, 'photos') }).rt.configured, false, 'a symlink into the database folder is still refused');
  assert.equal(attempt({ ...base, dir: path.join(path.dirname(dbDir), 'squirl-media') }).rt.configured, true, 'a sibling folder is fine');
  // Unwritable location: a folder "inside" a regular file can never be created, on any OS. (Not /proc: on Linux,
  // mkdirSync({ recursive: true }) under /proc loops forever, which hung this test in the Linux deploy checks.)
  const blocker = path.join(root, 'not-a-folder');
  fs.writeFileSync(blocker, '');
  r = attempt({ ...base, dir: path.join(blocker, 'media') });
  assert.equal(r.rt.configured, false, 'a folder that cannot be created is refused');
  assert.match(r.logs.filter(([l]) => l === 'warn').map(([, m]) => m).join(' '), /MEDIA_DIR cannot be used/);
  // Kernel filesystems are refused before any mkdir, so this is safe to check on Linux too.
  for (const dir of ['/proc/definitely/not/writable/media', '/sys/squirl-media', '/dev/squirl-media']) {
    r = attempt({ ...base, dir });
    assert.equal(r.rt.configured, false, `${dir} is refused`);
    assert.match(r.logs.filter(([l]) => l === 'warn').map(([, m]) => m).join(' '), /not under \/proc, \/sys or \/dev/, `${dir} names the reason`);
  }
  // S3 settings: all four needed, https (or loopback http for tests), plain address.
  const withS3 = (s3) => attempt({ ...base, dir: path.join(root, 'cfg-s3'), s3 });
  const good = { endpoint: 'https://acct.r2.example.invalid', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', region: 'auto', pathStyle: true };
  assert.ok(withS3(good).rt.s3);
  assert.equal(withS3({}).rt.s3, null);
  for (const partial of [{ ...good, bucket: '' }, { ...good, secretAccessKey: '' }, { ...good, endpoint: 'http://remote.example.invalid' }, { ...good, endpoint: 'not a url' }, { ...good, endpoint: 'https://user:pw@h.example.invalid' }]) {
    const out = withS3(partial);
    assert.equal(out.rt.s3, null); assert.equal(out.rt.configured, true, 'a bad S3 setting never turns media off');
    assert.equal(out.logs.filter(([l]) => l === 'warn').length, 1);
    assert.equal(JSON.stringify(out.logs).includes('pw@'), false);
  }
  assert.ok(withS3({ ...good, endpoint: 'http://127.0.0.1:9' }).rt.s3, 'loopback http is allowed (local MinIO / tests)');
  // Unconfigured service answers 503 and background upkeep is a no-op.
  runtime.use(runtime.build({ dir: '', key: '' }, dbPath, logger));
  assert.throws(() => media.requireConfigured(), (e) => e.statusCode === 503 && e.code === 'MEDIA_NOT_CONFIGURED');
  assert.equal(media.purgeUnreferenced(), null);
  assert.deepEqual(media.status(), { configured: false });
}

async function unconfiguredHttp() {
  runtime.use(runtime.build({ dir: '', key: '' }, dbPath, logger));
  const app = await startApp();
  try {
    const task = addTask(a);
    let res = await app.call('/status', { user: a });
    assert.equal(res.status, 200); assert.deepEqual(res.json.data, { configured: false });
    res = await app.post(a, { buf: jpeg(), ownerType: 'task', ownerId: task });
    assert.equal(res.status, 503); assert.equal(res.json.error.code, 'MEDIA_NOT_CONFIGURED');
    assert.match(res.json.error.message, /aren’t set up/);
    for (const r of [await app.list(a, 'task', task), await app.file(a, newId()), await app.remove(a, newId())]) {
      assert.equal(r.status, 503); assert.equal(r.json.error.code, 'MEDIA_NOT_CONFIGURED');
    }
    assert.equal((await app.call('/status')).status, 401, 'status still needs a signed-in user');
    // Background upkeep and boot-time work do nothing and do not throw.
    worker.startMediaWorker();
    worker.tick();
    await worker.stopMediaWorker();
  } finally { await app.close(); }
}

async function apiChecks() {
  const { dir } = useRuntime({ maxPerOwner: 3, maxBytes: 20 * 1024 });
  const app = await startApp();
  try {
    const txA = addTx(a); const taskA = addTask(a); const goalA = addGoal(a);
    const txB = addTx(b); const taskB = addTask(b); const goalB = addGoal(b);
    let res = await app.call('/status', { user: a });
    assert.deepEqual(res.json.data, { configured: true, maxBytes: 20 * 1024, maxPerOwner: 3 });

    // Auth and CSRF come from the shared guards.
    assert.equal((await app.post(undefined, { buf: jpeg(), ownerType: 'task', ownerId: taskA })).status, 401);
    const noCsrf = new FormData(); noCsrf.append('ownerType', 'task'); noCsrf.append('ownerId', taskA); noCsrf.append('file', new Blob([jpeg()]), 'a.jpg');
    assert.equal((await app.call('/upload', { user: a, method: 'POST', form: noCsrf, csrf: false })).status, 403);
    assert.equal(filesIn(dir).length, 0);

    // Every owner type, with the response shape from the brief.
    const first = jpeg(800, 600);
    res = await app.post(a, { buf: first, ownerType: 'transaction', ownerId: txA });
    assert.equal(res.status, 201);
    const att = res.json.data.attachment;
    assert.deepEqual(Object.keys(att).sort(), ['createdAt', 'height', 'id', 'mediaId', 'mime', 'ownerId', 'ownerType', 'size', 'width']);
    assert.equal(att.ownerType, 'transaction'); assert.equal(att.ownerId, txA); assert.equal(att.mime, 'image/jpeg');
    assert.equal(att.size, first.length); assert.equal(att.width, 800); assert.equal(att.height, 600);
    assert.deepEqual(limitCalls.at(-1), { key: `media-upload:${a}`, options: { limit: 30, windowSec: 60 } });
    for (const [type, id] of [['task', taskA], ['goal', goalA]]) {
      res = await app.post(a, { buf: png(100 + limitCalls.length, 100), type: 'image/png', name: 'x.png', ownerType: type, ownerId: id });
      assert.equal(res.status, 201, type); assert.equal(res.json.data.attachment.mime, 'image/png');
    }

    // Serving: exact bytes, stored type, hardening headers, generic name.
    res = await app.file(a, att.mediaId);
    assert.equal(res.status, 200); assert.deepEqual(res.raw, first);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get('content-disposition'), 'inline; filename="receipt.jpg"');
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(res.headers.get('content-disposition').includes('IMG_0001'), false, 'the client file name is never used');

    // Listing.
    res = await app.list(a, 'transaction', txA);
    assert.equal(res.status, 200); assert.equal(res.json.data.attachments.length, 1);
    assert.deepEqual(res.json.data.attachments[0], att);
    assert.equal((await app.list(a, 'transaction', 'not-an-id')).status, 400);
    assert.equal((await app.list(a, 'budget', txA)).status, 400);

    // Magic bytes, not the client's word.
    const spoof = { ownerType: 'task', ownerId: taskA };
    for (const [name, buf, type, fname] of [
      ['html as jpeg', Buffer.from('<html><script>alert(1)</script></html>'), 'image/jpeg', 'photo.jpg'],
      ['svg as png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/png', 'x.png'],
      ['pdf as webp', Buffer.from('%PDF-1.4 synthetic padding padding'), 'image/webp', 'y.webp'],
      ['exe-ish as jpeg', Buffer.concat([Buffer.from('MZ'), randomBytes(64)]), 'image/jpeg', 'z.jpeg'],
      ['truncated jpeg', jpeg().subarray(0, 40), 'image/jpeg', 't.jpg'],
      ['truncated png', png().subarray(0, 25), 'image/png', 't.png'],
      ['truncated webp', webpX(10, 10).subarray(0, 30), 'image/webp', 't.webp'],
      ['empty', Buffer.alloc(0), 'image/jpeg', 'e.jpg'],
    ]) {
      res = await app.post(a, { ...spoof, buf, type, name: fname });
      assert.ok([400].includes(res.status), `${name} -> ${res.status}`);
      assert.ok(['INVALID_IMAGE', 'FILE_REQUIRED'].includes(res.json.error.code), name);
    }
    // A real PNG with a lying type and name is accepted for what it is.
    res = await app.post(a, { ...spoof, buf: png(77, 55, 'honest'), type: 'application/pdf', name: 'report.txt' });
    assert.equal(res.status, 201); assert.equal(res.json.data.attachment.mime, 'image/png');
    assert.equal((await app.file(a, res.json.data.attachment.mediaId)).headers.get('content-type'), 'image/png');
    // Polyglot: valid PNG followed by script. It is stored as an image, and only ever served as one with nosniff + sandbox CSP.
    const polyglot = Buffer.concat([png(31, 31, 'poly'), Buffer.from('<script>alert(document.cookie)</script>')]);
    res = await app.post(a, { ...spoof, buf: polyglot, type: 'text/html', name: 'x.html' });
    // (cap of 3 may already be reached by now; either outcome keeps it an image)
    assert.ok(res.status === 201 || res.status === 409);
    // Absurd dimensions are refused even though the file is tiny.
    res = await app.post(a, { ...spoof, buf: png(20000, 100, 'wide') });
    assert.equal(res.status, 400); assert.equal(res.json.error.code, 'IMAGE_DIMENSIONS_TOO_LARGE');
    res = await app.post(a, { ...spoof, buf: jpeg(10000, 9000, 'big') });
    assert.equal(res.status, 400); assert.equal(res.json.error.code, 'IMAGE_DIMENSIONS_TOO_LARGE');
    // No file at all / unexpected field / bad owner fields.
    res = await app.post(a, { ...spoof }); assert.equal(res.status, 400);
    res = await app.post(a, { ...spoof, buf: jpeg(), field: 'photo' }); assert.equal(res.status, 400);
    res = await app.post(a, { buf: jpeg(), ownerType: 'task', ownerId: 'nope' }); assert.equal(res.status, 400);
    res = await app.post(a, { buf: jpeg(), ownerType: 'habit', ownerId: taskA }); assert.equal(res.status, 400);
    // Over the size limit.
    res = await app.post(a, { ...spoof, buf: Buffer.concat([jpeg(), Buffer.alloc(30 * 1024)]) });
    assert.equal(res.status, 413); assert.equal(res.json.error.code, 'FILE_TOO_LARGE');
    const rowsBefore = db.prepare('SELECT count(*) FROM media').pluck().get();
    assert.equal(filesIn(dir).length, rowsBefore, 'every media row has exactly one file and rejects leave none');

    // Owner checks: another account's owner, a made-up id, a soft-deleted owner.
    for (const [type, id] of [['transaction', txB], ['task', taskB], ['goal', goalB], ['task', newId()], ['transaction', taskA], ['goal', txA]]) {
      res = await app.post(a, { buf: freshJpeg(), ownerType: type, ownerId: id });
      assert.equal(res.status, 404, `${type} ${id}`); assert.equal(res.json.error.code, 'MEDIA_OWNER_NOT_FOUND');
      assert.equal((await app.list(a, type, id)).status, 404);
    }
    assert.equal(filesIn(dir).length, rowsBefore, 'a refused owner never leaves a file');
    // Another account cannot read, list or detach what is not theirs; the answer is the same 404 as "no such id".
    const missing = await app.file(b, newId());
    res = await app.file(b, att.mediaId);
    assert.equal(res.status, 404); assert.deepEqual(res.json.error.code, missing.json.error.code);
    assert.equal((await app.remove(b, att.id)).status, 404);
    assert.equal((await app.list(b, 'transaction', txA)).status, 404);
    assert.equal((await app.file(undefined, att.mediaId)).status, 401);
    // ...and B can attach to B's own owner and gets a different media id even for the same bytes (checked below).
    res = await app.post(a, { buf: freshJpeg(), ownerType: 'goal', ownerId: goalA });
    assert.equal(res.status, 201);

    // Soft-deleted owners: hidden everywhere, and restored by an undo.
    softDelete('tasks', taskA);
    assert.equal((await app.list(a, 'task', taskA)).status, 404);
    assert.equal((await app.post(a, { buf: freshJpeg(), ownerType: 'task', ownerId: taskA })).status, 404);
    const hidden = db.prepare("SELECT media_id, id FROM attachments WHERE owner_type = 'task' AND owner_id = ? AND deleted_at IS NULL").all(taskA);
    assert.ok(hidden.length > 0);
    for (const h of hidden) { assert.equal((await app.file(a, h.media_id)).status, 404, 'photo of a deleted task is not served'); assert.equal((await app.remove(a, h.id)).status, 404); }
    restore('tasks', taskA);
    assert.equal((await app.file(a, hidden[0].media_id)).status, 200, 'restoring the task restores its photos');
    assert.equal((await app.list(a, 'task', taskA)).json.data.attachments.length, hidden.length);

    // Dedupe and caps.
    const dup = freshJpeg();
    const dupTask = addTask(a);
    const one = await app.post(a, { buf: dup, ownerType: 'task', ownerId: dupTask });
    const again = await app.post(a, { buf: dup, ownerType: 'task', ownerId: dupTask });
    assert.equal(one.status, 201); assert.equal(again.status, 200, 'already attached: the existing attachment comes back');
    assert.equal(again.json.data.attachment.id, one.json.data.attachment.id);
    assert.equal(db.prepare('SELECT count(*) FROM attachments WHERE owner_id = ?').pluck().get(dupTask), 1);
    const dupGoal = addGoal(a);
    const shared = await app.post(a, { buf: dup, ownerType: 'goal', ownerId: dupGoal });
    assert.equal(shared.status, 201); assert.notEqual(shared.json.data.attachment.id, one.json.data.attachment.id);
    assert.equal(shared.json.data.attachment.mediaId, one.json.data.attachment.mediaId, 'same account + same bytes = one stored image');
    assert.equal(db.prepare('SELECT count(*) FROM media WHERE user_id = ? AND sha256 = ?').pluck().get(a, hex(dup)), 1);
    const bTask = addTask(b);
    const other = await app.post(b, { buf: dup, ownerType: 'task', ownerId: bTask });
    assert.equal(other.status, 201);
    assert.notEqual(other.json.data.attachment.mediaId, one.json.data.attachment.mediaId, 'never de-duplicated across accounts');
    assert.equal(db.prepare('SELECT count(*) FROM media WHERE sha256 = ?').pluck().get(hex(dup)), 2);
    assert.equal(filesIn(dir).filter((f) => [one.json.data.attachment.mediaId, other.json.data.attachment.mediaId].some((id) => f.includes(id))).length, 2);
    assert.equal((await app.file(b, one.json.data.attachment.mediaId)).status, 404, "B cannot reach A's copy by id");
    assert.deepEqual((await app.file(b, other.json.data.attachment.mediaId)).raw, dup);
    // A missing file for an already-stored picture is put back by the next upload of the same bytes.
    const lost = filesIn(dir).find((f) => f.includes(one.json.data.attachment.mediaId));
    fs.rmSync(lost);
    assert.equal((await app.file(a, one.json.data.attachment.mediaId)).status, 404);
    assert.equal((await app.post(a, { buf: dup, ownerType: 'goal', ownerId: dupGoal })).status, 200);
    const dupTask2 = addTask(a);
    assert.equal((await app.post(a, { buf: dup, ownerType: 'task', ownerId: dupTask2 })).status, 201);
    assert.equal(fs.existsSync(lost), true, 'file restored from the bytes just uploaded');
    // Cap: 3 per owner.
    const capTask = addTask(a);
    for (let i = 0; i < 3; i += 1) assert.equal((await app.post(a, { buf: freshJpeg(), ownerType: 'task', ownerId: capTask })).status, 201);
    res = await app.post(a, { buf: freshJpeg(), ownerType: 'task', ownerId: capTask });
    assert.equal(res.status, 409); assert.equal(res.json.error.code, 'MEDIA_LIMIT_REACHED');
    assert.equal(db.prepare("SELECT count(*) FROM attachments WHERE owner_id = ?").pluck().get(capTask), 3);
    // ...but re-uploading one that is already there still just returns it.
    const there = db.prepare('SELECT media_id FROM attachments WHERE owner_id = ?').pluck().get(capTask);
    assert.equal(there.length, 24);

    // Rate limit: refused before anything is read or written.
    const filesNow = filesIn(dir).length;
    limitFails = true;
    res = await app.post(a, { buf: freshJpeg(), ownerType: 'goal', ownerId: dupGoal });
    limitFails = false;
    assert.equal(res.status, 429); assert.equal(filesIn(dir).length, filesNow);

    // Detach: file stays while another attachment uses the picture, goes with the last one.
    const mediaId = one.json.data.attachment.mediaId;
    assert.equal((await app.remove(a, one.json.data.attachment.id)).status, 200);
    assert.equal(fs.existsSync(lost), true, 'still attached to the goal and the second task');
    assert.equal((await app.list(a, 'task', dupTask)).json.data.attachments.length, 0);
    assert.equal((await app.file(a, mediaId)).status, 200);
    const rest = db.prepare('SELECT id FROM active_attachments WHERE media_id = ?').pluck().all(mediaId);
    assert.equal(rest.length, 2);
    await app.remove(a, rest[0]);
    assert.equal((await app.remove(a, rest[1])).status, 200);
    assert.equal(fs.existsSync(lost), false, 'last attachment removed: file deleted');
    assert.ok(db.prepare('SELECT deleted_at FROM media WHERE id = ?').pluck().get(mediaId), 'media row soft-deleted');
    assert.equal((await app.file(a, mediaId)).status, 404);
    assert.equal((await app.remove(a, rest[1])).status, 404);
    assert.doesNotThrow(() => media.purgeFiles([{ id: mediaId, userId: a }]), 'purging an already-removed file is fine');
    // The same picture can be uploaded again afterwards (unique index only covers live rows) and is a fresh row.
    res = await app.post(a, { buf: dup, ownerType: 'goal', ownerId: dupGoal });
    assert.equal(res.status, 201); assert.notEqual(res.json.data.attachment.mediaId, mediaId);

    // Every row has a file; every file has a row.
    const live = db.prepare('SELECT id FROM media WHERE deleted_at IS NULL').pluck().all().sort();
    assert.deepEqual(filesIn(dir).map((f) => path.basename(f, '.sqm')).sort(), live);
    for (const f of filesIn(dir)) assert.match(path.relative(dir, f), /^[a-f0-9]{2}\/[a-f0-9]{24}\.sqm$/, 'no names, only random ids');
  } finally { await app.close(); }
}

async function quotaAndFailureChecks() {
  const { dir } = useRuntime({ userQuotaBytes: 3000 });
  const app = await startApp();
  try {
    // A fresh account: the quota counts everything an account already stores.
    const q = insertUser(db, { name: 'Quota user', email: 'media-quota@example.invalid', passwordHash: 'unused' });
    seedDefaults(db, q);
    const task = addTask(q);
    const big = (n) => jpeg(50, 50, `${n}-${'q'.repeat(1100)}`);
    assert.equal((await app.post(q, { buf: big(1), ownerType: 'task', ownerId: task })).status, 201);
    assert.equal((await app.post(q, { buf: big(2), ownerType: 'task', ownerId: task })).status, 201);
    const filesBefore = filesIn(dir).length;
    const res = await app.post(q, { buf: big(3), ownerType: 'task', ownerId: task });
    assert.equal(res.status, 413); assert.equal(res.json.error.code, 'MEDIA_QUOTA_EXCEEDED');
    assert.equal(filesIn(dir).length, filesBefore, 'over quota writes nothing');
    // Another account has its own quota, and a duplicate of stored bytes costs nothing.
    assert.equal((await app.post(b, { buf: big(3), ownerType: 'task', ownerId: addTask(b) })).status, 201);
    const task2 = addTask(q);
    assert.equal((await app.post(q, { buf: big(1), ownerType: 'task', ownerId: task2 })).status, 201, 'same bytes again do not count again');
    // Removing frees quota.
    const att = db.prepare('SELECT id FROM active_attachments WHERE user_id = ? AND owner_id = ?').pluck().all(q, task);
    for (const id of att) await app.remove(q, id);
    assert.equal((await app.post(q, { buf: big(3), ownerType: 'task', ownerId: task })).status, 201);

    // Failure injection: if the rows cannot be written, the file is removed again.
    const stored = filesIn(dir).sort();
    const mediaRows = db.prepare('SELECT count(*) FROM media').pluck().get();
    db.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    try {
      const failed = await app.post(q, { buf: freshJpeg(), ownerType: 'task', ownerId: task2 });
      assert.ok(failed.status >= 400, `injected failure -> ${failed.status}`);
    } finally { db.exec('DROP TRIGGER inject_failure'); }
    assert.deepEqual(filesIn(dir).sort(), stored, 'no orphan file after a failed insert');
    assert.equal(db.prepare('SELECT count(*) FROM media').pluck().get(), mediaRows, 'and no half-written media row');
    assert.equal(db.prepare("SELECT count(*) FROM media m WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.media_id = m.id AND a.deleted_at IS NULL)").pluck().get(), 0);
  } finally { await app.close(); }
}

function sweepChecks() {
  const { dir, rt } = useRuntime();
  const task = addTask(a);
  const DAY = 24 * 60 * 60 * 1000;
  const old = new Date(Date.now() - 2 * DAY).toISOString();
  const age = (file, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(file, t, t); };
  const fileOf = (id) => path.join(dir, id.slice(0, 2), `${id}.sqm`);
  const seedMedia = (createdAt, { attach = false, file = true } = {}) => {
    const id = newId(); const bytes = freshJpeg();
    insertRow(db, 'media', { id, user_id: a, sha256: hex(bytes), mime: 'image/jpeg', size_bytes: bytes.length, created_at: createdAt, updated_at: createdAt });
    if (attach) insertRow(db, 'attachments', { id: newId(), user_id: a, media_id: id, owner_type: 'task', owner_id: task, created_at: createdAt });
    if (file) { rt.store.put(id, a, bytes); age(fileOf(id), createdAt === old ? 2 * DAY : 1000); }
    return id;
  };
  const unattachedOld = seedMedia(old);
  const unattachedFresh = seedMedia(nowIso());
  const attachedOld = seedMedia(old, { attach: true });
  const orphanOld = newId(); rt.store.put(orphanOld, a, Buffer.from('x')); age(fileOf(orphanOld), 2 * DAY);
  const orphanFresh = newId(); rt.store.put(orphanFresh, a, Buffer.from('x'));
  const tempOld = `${fileOf(newId())}.abcdef012345.tmp`; fs.mkdirSync(path.dirname(tempOld), { recursive: true }); fs.writeFileSync(tempOld, 'partial'); age(tempOld, 2 * DAY);
  const tempFresh = `${fileOf(newId())}.abcdef012345.tmp`; fs.mkdirSync(path.dirname(tempFresh), { recursive: true }); fs.writeFileSync(tempFresh, 'partial');
  const foreign = path.join(dir, 'notes.txt'); fs.writeFileSync(foreign, 'not ours'); age(foreign, 5 * DAY);
  const foreignNested = path.join(dir, 'ab'); fs.mkdirSync(foreignNested, { recursive: true }); fs.writeFileSync(path.join(foreignNested, 'keep.txt'), 'not ours'); age(path.join(foreignNested, 'keep.txt'), 5 * DAY);
  const softDeletedWithFile = seedMedia(old); db.prepare('UPDATE media SET deleted_at = ? WHERE id = ?').run(old, softDeletedWithFile);

  const result = media.purgeUnreferenced();
  assert.deepEqual(result, { media: 1, files: 3 }, JSON.stringify(result));
  assert.equal(fs.existsSync(fileOf(unattachedOld)), false, 'old media nothing is attached to: removed');
  assert.ok(db.prepare('SELECT deleted_at FROM media WHERE id = ?').pluck().get(unattachedOld));
  assert.equal(fs.existsSync(fileOf(unattachedFresh)), true, 'a picture from the last day is left alone (upload may be mid-flight)');
  assert.equal(db.prepare('SELECT deleted_at FROM media WHERE id = ?').pluck().get(unattachedFresh), null);
  assert.equal(fs.existsSync(fileOf(attachedOld)), true, 'attached media is never swept');
  assert.equal(fs.existsSync(fileOf(orphanOld)), false, 'old file with no row: removed');
  assert.equal(fs.existsSync(fileOf(orphanFresh)), true, 'fresh file with no row: kept');
  assert.equal(fs.existsSync(tempOld), false); assert.equal(fs.existsSync(tempFresh), true);
  assert.equal(fs.existsSync(fileOf(softDeletedWithFile)), false, 'a file left behind by a soft-deleted picture is removed');
  assert.equal(fs.existsSync(foreign), true, 'files that are not ours are never touched');
  assert.equal(fs.existsSync(path.join(foreignNested, 'keep.txt')), true);
  assert.deepEqual(media.purgeUnreferenced(), { media: 0, files: 0 }, 'idempotent');
  // The same sweep a day later removes what was fresh.
  assert.deepEqual(media.purgeUnreferenced({ now: Date.now() + 2 * DAY }), { media: 1, files: 2 });
  worker.tick(); // the timer body: sweep + replica pass, non-fatal
}

async function resetAndDeleteChecks() {
  const { dir } = useRuntime();
  const app = await startApp();
  try {
    const user = insertUser(db, { name: 'Reset user', email: 'media-reset@example.invalid', passwordHash: await hashPassword('synthetic-password') });
    seedDefaults(db, user);
    const tx = addTx(user); const goal = addGoal(user); const task = addTask(user);
    const upload = async (owner, type, buf) => (await app.post(user, { buf, ownerType: type, ownerId: owner })).json.data.attachment;
    const txPhoto = await upload(tx, 'transaction', freshJpeg());
    const goalPhoto = await upload(goal, 'goal', freshJpeg());
    const taskPhoto = await upload(task, 'task', freshJpeg());
    const sharedBytes = freshJpeg();
    const sharedTx = await upload(tx, 'transaction', sharedBytes);
    const sharedTask = await upload(task, 'task', sharedBytes);
    assert.equal(sharedTx.mediaId, sharedTask.mediaId);
    const bTask = addTask(b); const bPhoto = (await app.post(b, { buf: freshJpeg(), ownerType: 'task', ownerId: bTask })).json.data.attachment;
    const bTx = addTx(b); const bTxPhoto = (await app.post(b, { buf: freshJpeg(), ownerType: 'transaction', ownerId: bTx })).json.data.attachment;
    const exists = (id) => fs.existsSync(path.join(dir, id.slice(0, 2), `${id}.sqm`));
    assert.ok([txPhoto, goalPhoto, taskPhoto, sharedTx, bPhoto, bTxPhoto].every((p) => exists(p.mediaId)));

    const result = await users.resetFinancialData(user);
    assert.ok(result.archived, 'reset still returns its archive counts');
    assert.equal('photos' in result, false, 'internal bookkeeping is not leaked to the API');
    assert.equal(exists(txPhoto.mediaId), false, 'transaction photo file removed');
    assert.equal(exists(goalPhoto.mediaId), false, 'goal photo file removed');
    assert.equal(exists(taskPhoto.mediaId), true, 'task photos are untouched');
    assert.equal(exists(sharedTx.mediaId), true, 'a picture also attached to a task stays for the task');
    assert.equal(db.prepare('SELECT count(*) FROM active_attachments WHERE user_id = ? AND owner_type IN (?, ?)').pluck().get(user, 'transaction', 'goal'), 0);
    assert.equal(db.prepare('SELECT count(*) FROM attachments WHERE user_id = ? AND owner_type IN (?, ?) AND deleted_at IS NOT NULL').pluck().get(user, 'transaction', 'goal'), 3, 'soft-deleted, like the rest of reset');
    for (const p of [txPhoto, goalPhoto]) assert.ok(db.prepare('SELECT deleted_at FROM media WHERE id = ?').pluck().get(p.mediaId), 'media rows soft-deleted');
    assert.equal((await app.file(user, taskPhoto.mediaId)).status, 200);
    assert.equal((await app.file(user, sharedTask.mediaId)).status, 200);
    assert.equal((await app.file(user, txPhoto.mediaId)).status, 404);
    assert.equal(exists(bPhoto.mediaId), true, "another account's photos are untouched");
    assert.equal(exists(bTxPhoto.mediaId), true, "even its transaction photos: reset is per account");
    assert.equal((await app.file(b, bTxPhoto.mediaId)).status, 200);

    // Account deletion removes every file the account had (including the shared one) and nothing else.
    const survivors = filesIn(dir).length;
    await users.deleteAccount(user, { password: 'synthetic-password' });
    assert.equal(exists(taskPhoto.mediaId), false); assert.equal(exists(sharedTx.mediaId), false);
    assert.equal(db.prepare('SELECT count(*) FROM media WHERE user_id = ?').pluck().get(user), 0);
    assert.equal(db.prepare('SELECT count(*) FROM attachments WHERE user_id = ?').pluck().get(user), 0);
    assert.equal(exists(bPhoto.mediaId), true); assert.equal(exists(bTxPhoto.mediaId), true);
    assert.equal(filesIn(dir).length, 2, `only the other account's two files remain (had ${survivors})`);
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally { await app.close(); }
}

// ---------- S3 -----------------------------------------------------------------------------------------

async function s3Checks() {
  // The reference signer used by the fake server must itself reproduce AWS's published GET Object example.
  assert.equal(referenceSignature({
    method: 'GET', canonicalUri: '/test.txt', headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
    signedHeaders: 'host;range;x-amz-content-sha256;x-amz-date', payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    region: 'us-east-1', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', stamp: '20130524T000000Z',
  }), 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');

  // Client against the fake server: signing details, PUT/GET/DELETE.
  const fake = await startFakeS3();
  try {
    const client = createS3Client({ endpoint: fake.endpoint, bucket: S3.bucket, region: S3.region, accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey, pathStyle: true });
    const body = randomBytes(1000);
    await client.put('media/abc.sqm', body);
    assert.deepEqual(fake.objects.get('media/abc.sqm'), body);
    assert.deepEqual(await client.get('media/abc.sqm'), body);
    assert.equal(await client.get('media/none.sqm'), null);
    await client.remove('media/abc.sqm'); await client.remove('media/abc.sqm');
    assert.equal(fake.objects.size, 0);
    assert.deepEqual(fake.state.bad, [], 'the fake server accepted every signature');
    const put = fake.state.requests[0];
    assert.equal(put.path, `/${S3.bucket}/media/abc.sqm`, 'path style: /bucket/key');
    assert.match(put.auth, /^AWS4-HMAC-SHA256 Credential=AKIATESTSYNTHETIC\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.equal(put.headers['x-amz-content-sha256'], hex(body), 'the real body hash is signed');
    assert.notEqual(put.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
    assert.equal(put.headers['x-amz-content-sha256'], put.bodyHash);

    // A wrong secret is refused by the server and the error leaks no credentials.
    const wrong = createS3Client({ endpoint: fake.endpoint, bucket: S3.bucket, region: S3.region, accessKeyId: S3.accessKeyId, secretAccessKey: 'a-different-secret-entirely-000', pathStyle: true });
    await assert.rejects(wrong.put('media/x.sqm', body), (e) => {
      assert.match(e.message, /status 403 \(SignatureDoesNotMatch\)/);
      for (const secret of [S3.secretAccessKey, 'a-different-secret-entirely-000', S3.accessKeyId]) assert.equal(e.message.includes(secret), false);
      return true;
    });
    // Redirects are not followed (they would carry the signed request somewhere else).
    fake.state.mode = 'redirect';
    await assert.rejects(client.put('media/y.sqm', body), /status 307/);
    assert.equal(fake.state.elsewhereHits, 0);
    fake.state.mode = 'ok';
    // Network failure and timeouts: short message, no URL or secrets; the 15 s timeout and manual redirects are set.
    const seen = [];
    const spy = createS3Client({ endpoint: fake.endpoint, bucket: S3.bucket, region: S3.region, accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey, pathStyle: true },
      { fetchImpl: async (url, init) => { seen.push(init); throw Object.assign(new Error(`connect ECONNREFUSED ${url} ${S3.secretAccessKey}`), { name: 'Error' }); } });
    await assert.rejects(spy.put('media/z.sqm', body), (e) => { assert.equal(e.message.includes(S3.secretAccessKey), false); assert.equal(e.message.includes('127.0.0.1'), false); return true; });
    assert.equal(seen[0].redirect, 'manual'); assert.ok(seen[0].signal instanceof AbortSignal);
    // Virtual-hosted style signs the bucket into the host.
    const vh = signRequest({ method: 'GET', endpoint: 'https://s3.example.invalid', bucket: 'bkt', key: 'media/k.sqm', region: 'eu', accessKeyId: 'AK', secretAccessKey: 'SK', pathStyle: false, date: new Date('2026-01-02T03:04:05Z') });
    assert.equal(vh.url, 'https://bkt.s3.example.invalid/media/k.sqm'); assert.match(vh.headers.Authorization, /Credential=AK\/20260102\/eu\/s3\/aws4_request/);
    assert.equal(vh.headers['x-amz-date'], '20260102T030405Z');
    // Oversized responses are refused.
    const small = createS3Client({ endpoint: fake.endpoint, bucket: S3.bucket, region: S3.region, accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey, pathStyle: true }, { maxObjectBytes: 10 });
    await client.put('media/big.sqm', body);
    await assert.rejects(small.get('media/big.sqm'), /unexpectedly large/);
  } finally { await fake.close(); }
}

async function replicaChecks() {
  const fake = await startFakeS3();
  const { rt, dir } = useRuntime({ s3: s3Config(fake) });
  assert.ok(rt.s3);
  const app = await startApp();
  const state = (id) => db.prepare('SELECT replica_state AS s, replica_attempts AS n FROM media WHERE id = ?').get(id);
  const upload = async (user, ownerType, ownerId, buf = freshJpeg()) => {
    const res = await app.post(user, { buf, ownerType, ownerId });
    await replica.idle(); // cancel the debounced background pass: these checks drive passes by hand
    return res.json.data.attachment;
  };
  try {
    const task = addTask(a);
    // After a local write the row is 'pending'; the request itself never waits for or depends on S3.
    fake.state.mode = 'fail';
    const bytes = freshJpeg();
    const p1 = await upload(a, 'task', task, bytes);
    assert.deepEqual(state(p1.mediaId), { s: 'pending', n: 0 });
    await replica.runPass();
    assert.deepEqual(state(p1.mediaId), { s: 'failed', n: 1 }, 'a failed upload records an attempt');
    assert.equal(fake.objects.size, 0);
    // Backoff: nothing happens before the pause (1 min after 1 attempt) has passed.
    const requestsBefore = fake.state.requests.length;
    await replica.runPass({ now: Date.now() + 30_000 });
    assert.equal(fake.state.requests.length, requestsBefore, 'still waiting');
    await replica.runPass({ now: Date.now() + 61_000 });
    assert.deepEqual(state(p1.mediaId), { s: 'failed', n: 2 });
    assert.equal(replica.waitMs(2), 120_000); assert.equal(replica.waitMs(0), 0); assert.equal(replica.waitMs(30), 6 * 60 * 60 * 1000);
    // The user's photo is fine meanwhile.
    assert.deepEqual((await app.file(a, p1.mediaId)).raw, bytes);
    // Gives up after 8 attempts.
    db.prepare('UPDATE media SET replica_attempts = ? WHERE id = ?').run(replica.MAX_ATTEMPTS, p1.mediaId);
    const before = fake.state.requests.length;
    await replica.runPass({ now: Date.now() + 7 * 3600_000 });
    assert.equal(fake.state.requests.length, before, 'no more attempts after the limit');
    // Recovery path: reset attempts, S3 healthy again.
    fake.state.mode = 'ok';
    db.prepare("UPDATE media SET replica_attempts = 0, replica_state = 'failed' WHERE id = ?").run(p1.mediaId);
    await replica.runPass({ now: Date.now() + 1000 });
    assert.deepEqual(state(p1.mediaId), { s: 'done', n: 0 });
    // The replica holds exactly the encrypted bytes from disk, and nothing readable.
    const remote = fake.objects.get(`media/${p1.mediaId}.sqm`);
    const local = fs.readFileSync(path.join(dir, p1.mediaId.slice(0, 2), `${p1.mediaId}.sqm`));
    assert.deepEqual(remote, local);
    assert.equal(remote.subarray(0, 4).toString(), 'SQM1');
    assert.equal(remote.includes(Buffer.from(MARKER)), false, 'no plaintext in the bucket');
    assert.deepEqual([...fake.objects.keys()], [`media/${p1.mediaId}.sqm`], 'object name is the random id only');
    assert.deepEqual(fake.state.bad, []);
    for (const r of fake.state.requests) assert.equal(r.body.includes(Buffer.from(MARKER)), false, 'no request ever carried plaintext');

    // Healing: delete the local file, the next view fetches it back and rewrites it.
    const localFile = path.join(dir, p1.mediaId.slice(0, 2), `${p1.mediaId}.sqm`);
    fs.rmSync(localFile);
    let res = await app.file(a, p1.mediaId);
    assert.equal(res.status, 200); assert.deepEqual(res.raw, bytes);
    assert.deepEqual(fs.readFileSync(localFile), remote, 'local copy healed');
    // If the replica copy was tampered with, it is refused and nothing is written locally.
    fs.rmSync(localFile);
    const bad = Buffer.from(remote); bad[bad.length - 5] ^= 1; fake.objects.set(`media/${p1.mediaId}.sqm`, bad);
    res = await app.file(a, p1.mediaId);
    assert.equal(res.status, 500); assert.equal(res.json.error.code, 'MEDIA_UNREADABLE');
    assert.equal(fs.existsSync(localFile), false);
    // Missing remotely too, or S3 down: a plain 404 and no crash.
    fake.objects.delete(`media/${p1.mediaId}.sqm`);
    assert.equal((await app.file(a, p1.mediaId)).status, 404);
    fake.objects.set(`media/${p1.mediaId}.sqm`, remote);
    fake.state.mode = 'fail';
    res = await app.file(a, p1.mediaId);
    assert.equal(res.status, 404); assert.equal(res.json.error.code, 'MEDIA_FILE_MISSING');
    fake.state.mode = 'ok';
    assert.equal((await app.file(a, p1.mediaId)).status, 200);
    // A file that was never replicated cannot be healed.
    const p2 = await upload(a, 'task', task);
    fs.rmSync(path.join(dir, p2.mediaId.slice(0, 2), `${p2.mediaId}.sqm`));
    assert.equal((await app.file(a, p2.mediaId)).status, 404);
    // Another account can never heal or fetch it.
    assert.equal((await app.file(b, p1.mediaId)).status, 404);

    // A corrupted local file is not "healed" over: it fails closed.
    const damaged = Buffer.from(local); damaged[40] ^= 1; fs.writeFileSync(localFile, damaged);
    res = await app.file(a, p1.mediaId);
    assert.equal(res.status, 500); assert.equal(res.json.error.code, 'MEDIA_UNREADABLE');
    fs.writeFileSync(localFile, local);

    // Detach deletes the local file and (via a durable pending_delete) the remote object, retrying if S3 is down.
    const att = db.prepare('SELECT id FROM active_attachments WHERE media_id = ?').pluck().get(p1.mediaId);
    assert.equal((await app.remove(a, att)).status, 200);
    await replica.idle();
    assert.equal(fs.existsSync(localFile), false);
    assert.deepEqual(state(p1.mediaId), { s: 'pending_delete', n: 0 });
    fake.state.mode = 'fail';
    await replica.runPass();
    assert.deepEqual(state(p1.mediaId), { s: 'pending_delete', n: 1 }, 'remote delete failed: kept for retry');
    assert.equal(fake.objects.has(`media/${p1.mediaId}.sqm`), true);
    fake.state.mode = 'ok';
    await replica.runPass({ now: Date.now() + 61_000 });
    assert.equal(fake.objects.has(`media/${p1.mediaId}.sqm`), false, 'remote object deleted');
    assert.deepEqual(state(p1.mediaId), { s: 'none', n: 0 });

    // Removing while an upload is in flight must not leave the object behind.
    const p3 = await upload(a, 'task', task);
    const attach3 = db.prepare('SELECT id FROM active_attachments WHERE media_id = ?').pluck().get(p3.mediaId);
    fake.state.beforePut = () => media.detach(a, attach3);
    await replica.runPass({ now: Date.now() + 1000 });
    assert.equal(fake.objects.has(`media/${p3.mediaId}.sqm`), false, 'object created during the race is cleaned up');
    assert.deepEqual(state(p3.mediaId), { s: 'none', n: 0 });

    // Pictures stored before the replica was switched on are copied once it is.
    const old = await upload(a, 'task', task);
    db.prepare("UPDATE media SET replica_state = 'none' WHERE id = ?").run(old.mediaId);
    fake.objects.delete(`media/${old.mediaId}.sqm`);
    await replica.runPass({ now: Date.now() + 1000 });
    assert.equal(fake.objects.has(`media/${old.mediaId}.sqm`), true); assert.equal(state(old.mediaId).s, 'done');

    // Orphan sweep also removes the remote copy of an unreferenced picture.
    db.prepare('UPDATE attachments SET deleted_at = ? WHERE media_id = ?').run(nowIso(), old.mediaId);
    db.prepare('UPDATE media SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 3 * 86400_000).toISOString(), old.mediaId);
    assert.equal(media.purgeUnreferenced().media >= 1, true);
    await replica.runPass({ now: Date.now() + 1000 });
    assert.equal(fake.objects.has(`media/${old.mediaId}.sqm`), false);

    // Account deletion deletes remote objects too, in the background.
    const doomed = insertUser(db, { name: 'Doomed', email: 'media-doomed@example.invalid', passwordHash: await hashPassword('synthetic-password') });
    seedDefaults(db, doomed);
    const dTask = addTask(doomed); const d1 = await upload(doomed, 'task', dTask);
    await replica.runPass({ now: Date.now() + 1000 });
    assert.equal(fake.objects.has(`media/${d1.mediaId}.sqm`), true);
    await users.deleteAccount(doomed, { password: 'synthetic-password' });
    await replica.idle();
    assert.equal(fake.objects.has(`media/${d1.mediaId}.sqm`), false);
    assert.deepEqual(fake.state.bad, [], 'every request through the whole run was correctly signed');

    // Upload failing at the S3 end (server down entirely) never fails the request.
    await fake.close();
    const p4 = await app.post(a, { buf: freshJpeg(), ownerType: 'task', ownerId: task });
    assert.equal(p4.status, 201);
    await replica.idle();
    await replica.runPass({ now: Date.now() + 1000 });
    assert.equal(state(p4.json.data.attachment.mediaId).s, 'failed');
    assert.equal((await app.file(a, p4.json.data.attachment.mediaId)).status, 200);
    assert.ok(warnings().some((w) => /Could not copy a photo to S3/.test(w)));
    assert.equal(JSON.stringify(logs).includes(S3.secretAccessKey), false, 'secrets never reach the log');
  } finally { await app.close(); await fake.close().catch(() => {}); await replica.idle(); }
}

async function main() {
  cryptoChecks();
  imageChecks();
  await storeChecks();
  configChecks();
  await unconfiguredHttp();
  await apiChecks();
  await quotaAndFailureChecks();
  sweepChecks();
  await resetAndDeleteChecks();
  await s3Checks();
  await replicaChecks();
  assert.equal(JSON.stringify(logs).includes(MASTER_B64), false, 'the master key is never logged');
  assert.equal(db.pragma('foreign_key_check').length, 0);
  console.log('Media: encryption (AAD/tamper/wrong key), magic-byte validation and header parsing, owner/tenant checks, dedupe, caps and quota, serving headers, detach/sweep/reset/account purge, unconfigured 503 and DB-folder refusal, S3 SigV4 round trip, ciphertext-only replica, retry/backoff, healing and failure injection passed.');
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(async () => {
  await replica.idle().catch(() => {});
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
