// Streaks with photo proof, plus the v29 upgrade and bulk removal of contacts. Synthetic data only: an in-memory
// database, a temp folder for the encrypted photos, no network. The upgrade test starts from a populated v28
// database (a habit with history, imported contacts, a photo on a task) and proves nothing there changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const Database = require('better-sqlite3-multiple-ciphers');

const db = new Database(':memory:');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squirl-streak-photos-'));
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
stub('../src/config', config);
stub('../src/config/db', { getDb: () => db });
stub('../src/core/logger', { debug() {}, info() {}, warn() {}, error() {} });
stub('../src/plugins/insights/suggestions.worker', { nudge() {}, resetForUser() {} });
stub('../src/plugins/insights/llm.client', {});

const migrations = require('../src/config/migrations');
const { insertUser } = require('../src/plugins/users/user.model');
const { newId, nowIso, insertRow } = require('../src/core/sql');

// ── Setup: a v28 database with real-looking data, as production has it today ──
db.pragma('foreign_keys = OFF');
for (const m of migrations.slice(0, 28)) typeof m === 'function' ? m(db) : db.exec(m);
db.pragma('foreign_keys = ON');
const owner = insertUser(db, { email: 'photos-a@example.invalid', name: 'Photos A', passwordHash: 'unused' });
const other = insertUser(db, { email: 'photos-b@example.invalid', name: 'Photos B', passwordHash: 'unused' });
const now = nowIso();
const habitRow = (userId, name) => ({ id: newId(), user_id: userId, name, start_date: '2026-02-20', position: 1, created_at: now, updated_at: now });
const gym = habitRow(owner, 'Gym');
insertRow(db, 'habits', gym);
for (const d of ['2026-02-27', '2026-02-28']) insertRow(db, 'habit_checkins', { id: newId(), habit_id: gym.id, user_id: owner, date: d, kind: 'done', created_at: now });
const task = newId();
insertRow(db, 'tasks', { id: task, user_id: owner, title: 'Synthetic task', created_at: now, updated_at: now });
insertRow(db, 'media', { id: 'a'.repeat(24), user_id: owner, sha256: 'f'.repeat(64), mime: 'image/jpeg', size_bytes: 10, width: 10, height: 10, replica_state: 'none', created_at: now, updated_at: now });
insertRow(db, 'attachments', { id: newId(), user_id: owner, media_id: 'a'.repeat(24), owner_type: 'task', owner_id: task, created_at: now });
for (let i = 0; i < 25; i += 1) {
  const id = newId();
  insertRow(db, 'people', { id, user_id: owner, name: `Imported ${i}`, is_family: i === 0 ? 1 : 0, source: i === 0 ? 'manual' : 'import', aliases: '[]', relationship: '', created_at: now, updated_at: now });
  db.prepare('INSERT INTO person_phones (person_id, user_id, phone, created_at) VALUES (?, ?, ?, ?)').run(id, owner, `98000000${String(i).padStart(2, '0')}`, now);
}
const snapshot = () => ({
  habits: db.prepare('SELECT * FROM habits ORDER BY id').all().map(({ require_photo, ...row }) => row),
  checkins: db.prepare('SELECT * FROM habit_checkins ORDER BY id').all(),
  people: db.prepare('SELECT * FROM people ORDER BY id').all(),
  phones: db.prepare('SELECT * FROM person_phones ORDER BY phone').all(),
  attachments: db.prepare('SELECT id, user_id, media_id, owner_type, owner_id, created_at, deleted_at FROM attachments ORDER BY id').all(),
});
const before = snapshot();

// ── 1. The v29 upgrade changes no existing row and is the last migration ──
assert.equal(typeof migrations[28], 'function');
assert.equal(migrations.length, 29, 'v29 is the newest migration: v28 (already deployed) was not edited');
db.pragma('foreign_keys = OFF');
db.transaction(() => migrations[28](db))();
db.pragma('foreign_keys = ON');
assert.deepEqual(snapshot(), before, 'every existing habit, check-in, contact, number and photo link is unchanged');
assert.equal(db.pragma('foreign_key_check').length, 0);
assert.equal(db.prepare('SELECT require_photo FROM habits WHERE id = ?').pluck().get(gym.id), 0, 'existing habits do not start requiring photos');
assert.equal(db.prepare('SELECT count(*) FROM active_attachments WHERE day IS NULL').pluck().get(), 1);
assert.equal(db.prepare('SELECT count(*) FROM active_habits').pluck().get(), 1);
assert.throws(() => db.prepare('UPDATE habits SET require_photo = 2 WHERE id = ?').run(gym.id), /CHECK/);

// ── 2. Photos on a habit's day ──
const runtime = require('../src/plugins/media/media.runtime');
const media = require('../src/plugins/media/media.service');
const { run } = require('../src/plugins/tasks/context');
const habits = require('../src/plugins/tasks/habit.service');
const schemas = require('../src/plugins/tasks/task.validation');
const mediaSchemas = require('../src/plugins/media/media.validation');
const people = require('../src/plugins/people/people.service');
const peopleSchemas = require('../src/plugins/people/people.validation');
const familyWorker = require('../src/plugins/users/family.worker');

const raw = { dir: path.join(root, 'media'), key: randomBytes(32).toString('base64'), maxBytes: 1024 * 1024, userQuotaBytes: 50 * 1024 * 1024, maxPerOwner: 3, s3: {} };
config.media = raw;
runtime.use(runtime.build(raw, dbPath, require('../src/core/logger')));

const be16 = (n) => Buffer.from([n >> 8, n & 255]);
const segment = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker]), be16(payload.length + 2), payload]);
let uniq = 0;
const jpeg = () => Buffer.concat([
  Buffer.from([0xff, 0xd8]), segment(0xfe, Buffer.from(`synthetic-${++uniq}-${randomBytes(4).toString('hex')}`)),
  segment(0xc0, Buffer.concat([Buffer.from([8]), be16(48), be16(64), Buffer.from([1, 1, 0x11, 0])])),
  segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
]);

const at = (key, hour = 12) => new Date(`${key}T${String(hour).padStart(2, '0')}:00:00+05:30`);
const D1 = '2026-03-01';
const D0 = '2026-02-28';
const asOwner = (when, work) => run(owner, work, { now: at(when) });

function main() {
  // Turning the option on for an existing habit is just an edit; the past stays as it was.
  const edited = asOwner(D1, (ctx) => habits.updateHabit(ctx, gym.id, { requirePhoto: true })).data;
  assert.equal(edited.requirePhoto, true);
  assert.equal(edited.currentStreak, 2, 'turning the option on does not touch the existing streak');
  assert.equal(schemas.updateHabit.safeParse({ params: { id: gym.id }, body: { requirePhoto: 'yes' } }).success, false);

  // No photo, no check-in.
  assert.throws(() => asOwner(D1, (ctx) => habits.checkIn(ctx, gym.id, {})), (e) => e.code === 'PHOTO_REQUIRED');
  assert.equal(db.prepare("SELECT count(*) FROM habit_checkins WHERE habit_id = ? AND date = ?").pluck().get(gym.id, D1), 0);

  // A photo for a different day does not count for today.
  media.upload(owner, { ownerType: 'habit', ownerId: gym.id, day: D0, buffer: jpeg() });
  assert.throws(() => asOwner(D1, (ctx) => habits.checkIn(ctx, gym.id, {})), (e) => e.code === 'PHOTO_REQUIRED');

  // A photo for today does; the streak grows and the photo is listed with its day.
  const today = media.upload(owner, { ownerType: 'habit', ownerId: gym.id, day: D1, buffer: jpeg() });
  assert.equal(today.created, true);
  assert.equal(today.attachment.day, D1);
  const checked = asOwner(D1, (ctx) => habits.checkIn(ctx, gym.id, {})).data;
  assert.equal(checked.doneToday, true);
  assert.equal(checked.currentStreak, 3);
  assert.deepEqual(media.listAttachments(owner, { ownerType: 'habit', ownerId: gym.id, day: D1 }).map((a) => a.day), [D1]);
  assert.equal(media.listAttachments(owner, { ownerType: 'habit', ownerId: gym.id }).length, 2, 'without a day, every photo of the habit');

  // Undo, then check in again with the same photo: allowed (the proof is still attached).
  asOwner(D1, (ctx) => habits.undoCheckIn(ctx, gym.id, D1));
  assert.equal(asOwner(D1, (ctx) => habits.checkIn(ctx, gym.id, {})).data.doneToday, true);

  // The same picture cannot prove two days; the limit is per day, not per habit.
  const reuse = jpeg();
  media.upload(owner, { ownerType: 'habit', ownerId: gym.id, day: D0, buffer: reuse });
  assert.throws(() => media.upload(owner, { ownerType: 'habit', ownerId: gym.id, day: D1, buffer: reuse }), (e) => e.code === 'MEDIA_ALREADY_USED');
  assert.equal(media.upload(owner, { ownerType: 'habit', ownerId: gym.id, day: D0, buffer: reuse }).created, false, 'the same picture twice for one day is a no-op');
  media.upload(owner, { ownerType: 'habit', ownerId: gym.id, day: D1, buffer: jpeg() });
  media.upload(owner, { ownerType: 'habit', ownerId: gym.id, day: D1, buffer: jpeg() });
  assert.throws(() => media.upload(owner, { ownerType: 'habit', ownerId: gym.id, day: D1, buffer: jpeg() }), (e) => e.code === 'MEDIA_LIMIT_REACHED');
  media.upload(owner, { ownerType: 'habit', ownerId: gym.id, day: '2026-02-27', buffer: jpeg() }); // another day still has room

  // Yesterday is logged the same way, and is checked against yesterday's photos.
  asOwner(D1, (ctx) => habits.undoCheckIn(ctx, gym.id, D0));
  assert.equal(asOwner(D1, (ctx) => habits.checkIn(ctx, gym.id, { date: D0 })).data.currentStreak >= 1, true);
  assert.throws(() => asOwner(D1, (ctx) => habits.checkIn(ctx, gym.id, { date: '2026-02-27' })), (e) => e.code === 'OUTSIDE_GRACE');

  // Rest days need no photo, and a habit that does not ask for one is untouched.
  const plain = asOwner(D1, (ctx) => habits.createHabit(ctx, { name: 'Read', startDate: D1 })).data;
  assert.equal(plain.requirePhoto, false);
  assert.equal(asOwner(D1, (ctx) => habits.checkIn(ctx, plain._id, {})).data.doneToday, true);
  const strict = asOwner(D1, (ctx) => habits.createHabit(ctx, { name: 'Run', startDate: D1, requirePhoto: true, skipsPerWeek: 1 })).data;
  assert.equal(strict.requirePhoto, true);
  assert.equal(asOwner(D1, (ctx) => habits.checkIn(ctx, strict._id, { kind: 'skip' })).data.skippedToday, true);

  // Switching the option off lets a check-in through again.
  asOwner(D1, (ctx) => habits.updateHabit(ctx, gym.id, { requirePhoto: false }));
  asOwner(D1, (ctx) => habits.undoCheckIn(ctx, gym.id, D1));
  assert.equal(asOwner(D1, (ctx) => habits.checkIn(ctx, gym.id, {})).data.doneToday, true);

  // Another account's habit is invisible, and a day is only for habits.
  const intruder = jpeg();
  assert.throws(() => media.upload(other, { ownerType: 'habit', ownerId: gym.id, day: D1, buffer: intruder }), (e) => e.code === 'MEDIA_OWNER_NOT_FOUND');
  assert.throws(() => media.listAttachments(other, { ownerType: 'habit', ownerId: gym.id, day: D1 }), (e) => e.code === 'MEDIA_OWNER_NOT_FOUND');
  const ok = (schema, input) => schema.safeParse(input).success;
  assert.equal(ok(mediaSchemas.upload, { body: { ownerType: 'habit', ownerId: gym.id } }), false, 'a habit photo needs a day');
  assert.equal(ok(mediaSchemas.upload, { body: { ownerType: 'task', ownerId: task, day: D1 } }), false, 'only a habit photo has a day');
  assert.equal(ok(mediaSchemas.upload, { body: { ownerType: 'habit', ownerId: gym.id, day: '2026-13-45' } }), false);
  assert.equal(ok(mediaSchemas.upload, { body: { ownerType: 'habit', ownerId: gym.id, day: D1 } }), true);
  assert.equal(ok(mediaSchemas.upload, { body: { ownerType: 'task', ownerId: task } }), true, 'other photos are unchanged');
  assert.equal(media.listAttachments(owner, { ownerType: 'task', ownerId: task }).length, 1, 'the photo that existed before the upgrade is still listed on its task');

  // A deleted habit hides its photos, like a deleted task does.
  const gone = asOwner(D1, (ctx) => habits.createHabit(ctx, { name: 'Gone', startDate: D1, requirePhoto: true })).data;
  const shot = media.upload(owner, { ownerType: 'habit', ownerId: gone._id, day: D1, buffer: jpeg() });
  asOwner(D1, (ctx) => habits.deleteHabit(ctx, gone._id));
  assert.rejects(media.openFile(owner, shot.attachment.mediaId), (e) => e.code === 'MEDIA_NOT_FOUND');
}

// ── 3. Removing contacts in bulk ──
async function bulk() {
  const list = async (extra = {}) => (await people.listPeople(owner, { limit: 100, ...extra })).items;
  assert.equal((await list()).length, 25);
  assert.equal((await people.listPeople(owner, { limit: 1 })).meta.imported, 24, 'the list says how many an "imported" removal would take');
  const bad = (body) => !peopleSchemas.removePeople.safeParse({ body }).success;
  assert.ok(bad({}), 'nothing chosen');
  assert.ok(bad({ ids: [] }));
  assert.ok(bad({ scope: 'everyone' }));
  assert.ok(bad({ scope: 'imported', ids: [newId()] }), 'both chosen');
  assert.ok(bad({ ids: ['not-an-id'] }));
  assert.equal(peopleSchemas.removePeople.safeParse({ body: { ids: [gym.id, gym.id] } }).data.body.ids.length, 1, 'duplicates collapse');

  // Ticked people only; someone else's id is ignored; a repeat is harmless.
  const [first, second] = (await list()).filter((p) => p.source === 'import');
  const foreign = newId();
  insertRow(db, 'people', { id: foreign, user_id: other, name: 'Not yours', aliases: '[]', source: 'import', created_at: now, updated_at: now });
  assert.deepEqual(await people.removeMany(owner, { ids: [first._id, second._id, foreign] }), { removed: 2, family: 0 });
  assert.deepEqual(await people.removeMany(owner, { ids: [first._id] }), { removed: 0, family: 0 });
  assert.equal(db.prepare('SELECT count(*) FROM active_people WHERE user_id = ?').pluck().get(other), 1, 'another account is never touched');
  assert.equal(db.prepare('SELECT count(*) FROM person_phones WHERE person_id = ?').pluck().get(first._id), 0, 'their numbers are freed');

  // The whole imported group leaves family alone and queues no re-sort.
  const queued = () => db.prepare('SELECT ifnull(sum(revision), 0) FROM family_sync_jobs WHERE user_id = ?').pluck().get(owner);
  const queuedBefore = queued();
  const result = await people.removeMany(owner, { scope: 'imported' });
  assert.deepEqual(result, { removed: 22, family: 0 });
  assert.equal(queued(), queuedBefore, 'removing non-family people never queues a re-sort');
  const left = await list();
  assert.equal(left.length, 1);
  assert.equal(left[0].isFamily, true);
  assert.equal(db.prepare('SELECT count(*) FROM people WHERE user_id = ? AND deleted_at IS NOT NULL').pluck().get(owner), 24, 'rows are kept (soft delete), so the data can be recovered');

  // "Everyone except family" keeps family; naming a family person removes them and queues one re-sort.
  await people.createPerson(owner, { name: 'Plain Friend', phones: ['9811111111'], relationship: '', aliases: [], isFamily: false });
  assert.deepEqual(await people.removeMany(owner, { scope: 'non_family' }), { removed: 1, family: 0 });
  assert.equal((await list()).length, 1);
  const revisionBefore = queued();
  assert.deepEqual(await people.removeMany(owner, { ids: [left[0]._id] }), { removed: 1, family: 1 });
  assert.ok(db.prepare('SELECT count(*) FROM family_sync_jobs WHERE user_id = ?').pluck().get(owner) === 1 && queued() >= revisionBefore, 'removing a family person queues the re-sort');
  assert.equal((await list()).length, 0);
  assert.equal(db.pragma('foreign_key_check').length, 0);
}

Promise.resolve().then(main).then(bulk).then(() => {
  console.log('Passed: v29 upgrade leaves a populated v28 database unchanged; photo-required habits (existing and new), per-day photos and limits, reused-photo guard, undo/redo, rest days, option off, tenant isolation, validation; bulk contact removal (ticked, imported group, non-family, family re-sort, tenant isolation, soft delete).');
}).catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => { familyWorker.stopFamilyWorker?.(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
