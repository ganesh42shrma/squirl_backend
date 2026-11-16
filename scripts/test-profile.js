// Profile details and the profile picture, plus the v30 upgrade. Synthetic data only: an in-memory database and a
// temp folder for the encrypted photos, no network. The upgrade starts from a populated v29 database and proves
// every existing row survives, then checks the picture replaces itself, stays private, and validates the details.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const Database = require('better-sqlite3-multiple-ciphers');

const db = new Database(':memory:');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squirl-profile-'));
const dbPath = path.join(root, 'usb-drive', 'squirl', 'squirl.db'); // the photo folder must sit outside the database's folder
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const stub = (file, exports) => { require.cache[require.resolve(file)] = { exports }; };
const config = {
  env: 'test', isDev: false, logLevel: 'error', db: { path: dbPath }, media: {},
  session: { secret: 'a-long-synthetic-session-secret-for-testing-only', cookieSecure: false },
  push: { publicKey: '', privateKey: '', subject: '' },
  llm: { url: 'http://127.0.0.1:1', model: 'test', timeoutMs: 100 },
  parser: { url: 'http://127.0.0.1:1', timeoutMs: 100 },
};
const logger = { debug() {}, info() {}, warn() {}, error() {} };
stub('../src/config', config);
stub('../src/config/db', { getDb: () => db });
stub('../src/core/logger', logger);
stub('../src/plugins/insights/suggestions.worker', { nudge() {}, resetForUser() {} });
stub('../src/plugins/insights/llm.client', {});

const migrations = require('../src/config/migrations');
const { insertUser } = require('../src/plugins/users/user.model');
const { newId, nowIso, insertRow } = require('../src/core/sql');

// ── Setup: a v29 database with real-looking data, as production has it today ──
db.pragma('foreign_keys = OFF');
for (const m of migrations.slice(0, 29)) typeof m === 'function' ? m(db) : db.exec(m);
db.pragma('foreign_keys = ON');
const a = insertUser(db, { email: 'profile-a@example.invalid', name: 'Profile A', passwordHash: 'unused' });
const b = insertUser(db, { email: 'profile-b@example.invalid', name: 'Profile B', passwordHash: 'unused' });
const now = nowIso();
const task = newId();
insertRow(db, 'tasks', { id: task, user_id: a, title: 'Synthetic task', created_at: now, updated_at: now });
insertRow(db, 'media', { id: 'a'.repeat(24), user_id: a, sha256: 'f'.repeat(64), mime: 'image/jpeg', size_bytes: 10, width: 10, height: 10, replica_state: 'none', created_at: now, updated_at: now });
insertRow(db, 'attachments', { id: newId(), user_id: a, media_id: 'a'.repeat(24), owner_type: 'task', owner_id: task, created_at: now });
const snapshot = () => ({
  users: db.prepare('SELECT id, email, name, created_at FROM users ORDER BY id').all(),
  attachments: db.prepare('SELECT * FROM attachments ORDER BY rowid').all(),
  media: db.prepare('SELECT * FROM media ORDER BY id').all(),
});
const before = snapshot();

(async () => {
  // ── 1. The v30 upgrade changes no existing row ──
  assert.ok(migrations.length >= 30, 'v30 exists; later migrations may follow it');
  db.pragma('foreign_keys = OFF');
  db.transaction(() => (typeof migrations[29] === 'function' ? migrations[29](db) : db.exec(migrations[29])))();
  db.pragma('foreign_keys = ON');
  assert.deepEqual(snapshot(), before, 'every existing user, photo and photo link is unchanged');
  assert.equal(db.pragma('foreign_key_check').length, 0);
  assert.equal(db.prepare('SELECT count(*) FROM active_attachments').pluck().get(), 1);
  for (const column of ['phone', 'bio', 'birthday', 'city', 'currency']) {
    assert.equal(db.prepare(`SELECT count(${column}) FROM users`).pluck().get(), 0, `${column} starts empty for everyone`);
  }
  const addAttachment = (owner_type, owner_id) => insertRow(db, 'attachments', { id: newId(), user_id: a, media_id: 'a'.repeat(24), owner_type, owner_id, created_at: now });
  addAttachment('user', a); // the picture owner type is now allowed
  assert.throws(() => addAttachment('nonsense', a), /CHECK/);
  db.prepare("DELETE FROM attachments WHERE owner_type = 'user'").run();

  // ── 2. The profile picture ──
  const runtime = require('../src/plugins/media/media.runtime');
  const raw = { dir: path.join(root, 'media'), key: randomBytes(32).toString('base64'), maxBytes: 1024 * 1024, userQuotaBytes: 5 * 1024 * 1024, maxPerOwner: 1, s3: {} };
  config.media = raw;
  runtime.use(runtime.build(raw, dbPath, logger));
  const media = require('../src/plugins/media/media.service');
  const users = require('../src/plugins/users/user.service');
  const chunk = (type, data) => Buffer.concat([Buffer.from([0, 0, 0, data.length]), Buffer.from(type), data, Buffer.alloc(4)]);
  const u32 = (n) => { const x = Buffer.alloc(4); x.writeUInt32BE(n); return x; };
  const png = (tag) => Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.concat([u32(32), u32(32), Buffer.from([8, 2, 0, 0, 0])])),
    chunk('tEXt', Buffer.from(`Comment\0${tag}`)), chunk('IDAT', Buffer.from([1, 2, 3, 4])), chunk('IEND', Buffer.alloc(0)),
  ]);

  assert.equal((await users.getProfile(a)).avatarMediaId, null);
  const one = media.setAvatar(a, png('one'));
  assert.equal((await users.getProfile(a)).avatarMediaId, one.mediaId);
  const two = media.setAvatar(a, png('two')); // maxPerOwner is 1: a new picture must still replace the old
  assert.equal((await users.getProfile(a)).avatarMediaId, two.mediaId);
  assert.equal(db.prepare("SELECT count(*) FROM active_attachments WHERE owner_type = 'user'").pluck().get(), 1);
  assert.equal(db.prepare('SELECT deleted_at IS NOT NULL FROM media WHERE id = ?').pluck().get(one.mediaId), 1, 'the old picture is released');
  assert.ok((await media.openFile(a, two.mediaId)).buffer.length > 0);
  await assert.rejects(() => media.openFile(b, two.mediaId), (e) => e.code === 'MEDIA_NOT_FOUND', 'another account cannot read it');
  assert.equal((await users.getProfile(b)).avatarMediaId, null);
  assert.equal(media.setAvatar(a, png('two')).id, two.id, 'sending the same picture again changes nothing');
  assert.equal(db.prepare("SELECT count(*) FROM active_attachments WHERE owner_type = 'user'").pluck().get(), 1);
  assert.throws(() => media.setAvatar(a, Buffer.from('not an image')), (e) => e.code === 'INVALID_IMAGE');
  assert.equal((await users.getProfile(a)).avatarMediaId, two.mediaId, 'a rejected upload keeps the current picture');
  media.removeAvatar(a);
  assert.equal((await users.getProfile(a)).avatarMediaId, null);
  media.removeAvatar(a); // nothing to remove is fine

  // ── 3. The details ──
  const { updateProfile } = require('../src/plugins/users/user.validation');
  const parse = (body) => updateProfile.safeParse({ body });
  assert.deepEqual(parse({ phone: ' +91 98765 43210 ', birthday: '', bio: ' x ', currency: 'inr', city: '' }).data.body,
    { phone: '9876543210', birthday: null, bio: 'x', currency: 'INR', city: null });
  for (const bad of [{ birthday: '2999-01-01' }, { birthday: '1990-02-31' }, { phone: '123' }, { currency: 'RUPEES' }, { bio: 'x'.repeat(201) }]) {
    assert.equal(parse(bad).success, false, JSON.stringify(bad));
  }
  const saved = await users.updateProfile(a, { phone: '9876543210', bio: 'hello', birthday: '1990-01-02', city: 'Pune', currency: 'INR' });
  assert.deepEqual([saved.phone, saved.bio, saved.birthday, saved.city, saved.currency], ['9876543210', 'hello', '1990-01-02', 'Pune', 'INR']);
  const cleared = await users.updateProfile(a, { city: null });
  assert.equal(cleared.city, null);
  assert.equal(cleared.bio, 'hello', 'fields that were not sent are left alone');
  assert.equal((await users.getProfile(b)).phone, null, 'another account is untouched');

  console.log('Profile: v30 upgrade keeps every row, picture replaces/removes/stays private, details validated and saved passed.');
})().catch((err) => { console.error(err); process.exit(1); });
