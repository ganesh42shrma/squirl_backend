// Synthetic in-memory DB and mocked push/Redis only. No real database or notification delivery.
const assert = require('node:assert/strict');
const { createECDH } = require('node:crypto');
const Database = require('better-sqlite3-multiple-ciphers');
const webpush = require('web-push');
const db = new Database(':memory:');
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports }; };
const sessions = new Map();
const push = webpush.generateVAPIDKeys();
const sent = [];
let failure = null;
// web-push exposes ESM bindings; replace the module rather than assigning to a namespace export.
require.cache[require.resolve('web-push')] = { exports: { ...webpush, sendNotification: async (sub, payload, options) => {
  if (failure) throw failure;
  sent.push({ sub, payload: JSON.parse(payload), options });
} } };
stub('../src/config', { push: { publicKey: push.publicKey, privateKey: push.privateKey, subject: 'mailto:tests@example.invalid' } });
stub('../src/config/db', { getDb: () => db });
stub('../src/config/redis', { redis: { get: async (key) => sessions.get(key) || null } });
stub('../src/core/logger', { info() {}, warn() {}, error() {} });
stub('../src/core/rateLimit', { hit: async () => {} });
for (const m of require('../src/config/migrations')) typeof m === 'function' ? m(db) : db.exec(m);
db.pragma('foreign_keys = ON');
const { insertUser } = require('../src/plugins/users/user.model');
const { insertRow } = require('../src/core/sql');
const { DEFAULT_SETTINGS } = require('../src/plugins/tasks/settings');
const { remindersFor } = require('../src/plugins/notifications/reminders');
const schemas = require('../src/plugins/notifications/notification.validation');
const service = require('../src/plugins/notifications/notification.service');
const worker = require('../src/plugins/notifications/notification.worker');
const a = insertUser(db, { name: 'A', email: 'a@example.invalid', passwordHash: 'unused' });
const b = insertUser(db, { name: 'B', email: 'b@example.invalid', passwordHash: 'unused' });
const stamp = db.prepare('SELECT password_changed_at FROM users WHERE id = ?').get(a).password_changed_at;
const at = (date, time) => new Date(`${date}T${time}:00+05:30`);
const date = '2026-03-09'; // Monday
const now = at(date, '20:00');
const prefs = { ...service.DEFAULT_PREFERENCES };
const subKey = createECDH('prime256v1'); subKey.generateKeys();
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-device', keys: {
  p256dh: subKey.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url'),
} };
const subscribe = (user = a, session = 'a-session', sub = subscription) => service.subscribe(user, session, stamp, { subscription: sub, preferences: prefs });
function session(id = 'a-session', user = a, expiry = '2027-01-01T00:00:00Z') {
  sessions.set(`squirl:sess:${id}`, JSON.stringify({ userId: user, passwordChangedAt: stamp, cookie: { expires: expiry } }));
}
function task(id, extra = {}, user = a) {
  insertRow(db, 'tasks', { id, user_id: user, title: `Private title ${id}`, due_date: date, created_at: now.toISOString(), updated_at: now.toISOString(), ...extra });
}
function habit(id, extra = {}) {
  insertRow(db, 'habits', { id, user_id: a, name: `Private habit ${id}`, start_date: date, created_at: now.toISOString(), updated_at: now.toISOString(), ...extra });
}
function checkin(id, habitId, day, extra = {}) {
  insertRow(db, 'habit_checkins', { id, habit_id: habitId, user_id: a, date: day, created_at: now.toISOString(), ...extra });
}

async function main() {
  const body = { subscription, preferences: prefs };
  assert.equal(schemas.subscribe.safeParse({ body }).success, true);
  for (const endpoint of ['http://fcm.googleapis.com/a', 'https://127.0.0.1/a', 'https://fcm.googleapis.com.evil.invalid/a', 'https://fcm.googleapis.com:444/a', 'https://user:pass@fcm.googleapis.com/a']) {
    assert.equal(schemas.subscribe.safeParse({ body: { ...body, subscription: { ...subscription, endpoint } } }).success, false);
  }
  assert.equal(schemas.subscribe.safeParse({ body: { ...body, preferences: { ...prefs, dailyTime: '25:01' } } }).success, false);
  assert.equal(schemas.subscribe.safeParse({ body: { ...body, preferences: { ...prefs, tasks: 'false' } } }).success, false);
  assert.equal(schemas.test.parse({ body: { endpoint: subscription.endpoint } }).body.kind, 'test');
  assert.equal(schemas.test.safeParse({ body: { endpoint: subscription.endpoint, kind: 'sms_payment' } }).success, true);
  assert.equal(schemas.test.safeParse({ body: { endpoint: subscription.endpoint, kind: 'unknown' } }).success, false);
  assert.throws(() => service.subscribe(a, 's', stamp, { ...body, subscription: { ...subscription, keys: { ...subscription.keys, p256dh: Buffer.alloc(65).toString('base64url') } } }), /public key/);
  assert.equal(subscribe().enabled, true);
  // Configuration must be explicit; saving a device never enables outbound delivery by itself.
  const config = require('../src/config');
  config.push.publicKey = '';
  assert.throws(() => subscribe(), /not been configured/);
  config.push.publicKey = push.publicKey;
  assert.equal(service.deviceStatus(b, 'b-session', subscription.endpoint).enabled, false);
  assert.throws(() => subscribe(b, 'b-session'), /another session/);
  service.remove(b, 'b-session', subscription.endpoint);
  assert.equal(service.deviceStatus(a, 'a-session', subscription.endpoint).enabled, true);

  task('due'); task('future-time', { due_time: '21:00' }); task('timed', { due_time: '19:00' }); task('after-midnight', { due_time: '02:00' });
  task('completed', { status: 'done' }); task('deleted', { deleted_at: now.toISOString() });
  task('other-user', {}, b); task('done-parent', { status: 'done' }); task('orphan-subtask', { parent_id: 'done-parent', due_time: '18:00' });
  habit('daily'); habit('rest-day', { cadence: 'weekdays', days_mask: 64 }); habit('archived', { archived_at: now.toISOString() });
  habit('future-habit', { start_date: '2026-03-20' }); habit('done-habit'); checkin('done-check', 'done-habit', date);
  habit('skipped-habit'); checkin('skip-check', 'skipped-habit', date, { kind: 'skip' });
  insertRow(db, 'commitments', { id: 'bill', user_id: a, kind: 'subscription', name: 'Private bill', amount_paise: 50000, due_day: 10, start_date: '2026-01-10', created_at: now.toISOString(), updated_at: now.toISOString() });
  let messages = await remindersFor(db, a, prefs, DEFAULT_SETTINGS, now);
  assert.deepEqual(messages.map((m) => m.kind), ['tasks', 'tasks', 'habits', 'bills']);
  assert(messages.some((m) => m.key === `task:timed:${date}:19:00`));
  // Details on (the default): titles, names and the first bill travel in the encrypted payload.
  assert.deepEqual(messages.find((m) => m.key === `task:timed:${date}:19:00`).detail, { title: 'Private title timed', time: '19:00' });
  assert.equal(messages.find((m) => m.kind === 'habits').detail.count, 1);
  assert.deepEqual(messages.find((m) => m.kind === 'bills').detail, { count: 1, name: 'Private bill', amount: 500, missed: false, daysUntil: 1 });
  // Details off: only the kind leaves the desktop.
  const plain = await remindersFor(db, a, { ...prefs, details: false }, DEFAULT_SETTINGS, now);
  assert.deepEqual(plain.map((m) => m.kind), ['tasks', 'tasks', 'habits', 'bills']);
  assert(!JSON.stringify(plain).includes('Private') && plain.every((m) => !m.detail), 'no titles, names, or amounts leave the desktop');
  assert.deepEqual(await remindersFor(db, a, { ...prefs, tasks: false, habits: false, bills: false }, DEFAULT_SETTINGS, now), []);
  assert.deepEqual(await remindersFor(db, a, prefs, DEFAULT_SETTINGS, at(date, '08:00')), []);
  assert.equal((await remindersFor(db, a, prefs, { ...DEFAULT_SETTINGS, vacationFrom: date, vacationUntil: date }, now)).some((m) => m.kind === 'habits'), false);
  checkin('daily-done', 'daily', date);
  assert.equal((await remindersFor(db, a, prefs, DEFAULT_SETTINGS, now)).some((m) => m.kind === 'habits'), false);
  // A weekly habit already meeting its target needs no reminder, including on a later day.
  habit('weekly', { cadence: 'times_per_week', target_per_period: 1 }); checkin('weekly-done', 'weekly', date);
  assert.equal((await remindersFor(db, a, { ...prefs, tasks: false, bills: false }, DEFAULT_SETTINGS, at('2026-03-10', '20:00'))).some((m) => m.kind === 'habits'), true, 'daily habits become pending again next day');
  db.prepare("UPDATE habits SET archived_at = ? WHERE cadence != 'times_per_week'").run(now.toISOString());
  assert.deepEqual(await remindersFor(db, a, { ...prefs, tasks: false, bills: false }, DEFAULT_SETTINGS, at('2026-03-10', '20:00')), []);
  // The same UTC instant is a different wall-clock time in another timezone.
  assert.deepEqual(await remindersFor(db, a, { ...prefs, habits: false, bills: false }, { ...DEFAULT_SETTINGS, timezone: 'America/Los_Angeles' }, now), []);
  // Before the configured 4AM boundary, the Tasks day is still yesterday.
  assert((await remindersFor(db, a, { ...prefs, dailyTime: '00:00', habits: false, bills: false }, DEFAULT_SETTINGS, at('2026-03-10', '02:00'))).some((m) => m.key === `tasks:${date}`));
  assert((await remindersFor(db, a, { ...prefs, habits: false, bills: false }, DEFAULT_SETTINGS, at('2026-03-10', '02:00'))).some((m) => m.key === `task:after-midnight:${date}:02:00`));

  session();
  await worker.runOnce(now);
  assert.equal(sent.length, 3); // daily tasks, timed task, bill
  assert.equal(sent[0].options.TTL, 3600);
  assert.equal(sent[0].options.vapidDetails.publicKey, push.publicKey);
  await worker.runOnce(now); assert.equal(sent.length, 3, 'durable receipts suppress duplicate scans');
  delete require.cache[require.resolve('../src/plugins/notifications/notification.worker')];
  await require('../src/plugins/notifications/notification.worker').runOnce(now);
  assert.equal(sent.length, 3, 'receipts survive worker restart');
  assert.equal(db.prepare('SELECT count(*) AS n FROM xp_events').get().n, 0, 'reminders never award XP');
  // A temporary delivery failure is retried with backoff, then durably recorded on success.
  db.prepare('DELETE FROM push_deliveries').run(); failure = new Error('private endpoint must never be logged');
  await worker.runOnce(now);
  assert.equal(db.prepare('SELECT count(*) AS n FROM push_deliveries WHERE sent_at IS NULL').get().n, 3);
  failure = null; await worker.runOnce(now); assert.equal(sent.length, 3);
  await worker.runOnce(new Date(now.getTime() + 3 * 60000)); assert.equal(sent.length, 6);
  // Logout and password change revoke subscriptions; other accounts cannot test a device.
  await assert.rejects(service.test(b, 'b-session', subscription.endpoint), /Enable notifications/);
  service.removeSession('a-session'); assert.equal(db.prepare('SELECT count(*) AS n FROM push_subscriptions').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM push_deliveries').get().n, 0, 'delete cascades receipts');
  subscribe(); sessions.delete('squirl:sess:a-session'); await worker.runOnce(now);
  assert.equal(service.deviceStatus(a, 'a-session', subscription.endpoint).enabled, false);
  subscribe(); session(); db.prepare("UPDATE users SET password_changed_at = 'changed' WHERE id = ?").run(a);
  await worker.runOnce(now); assert.equal(db.prepare('SELECT count(*) AS n FROM push_subscriptions').get().n, 0);
  db.prepare('UPDATE users SET password_changed_at = ? WHERE id = ?').run(stamp, a);
  subscribe(); session(); failure = { statusCode: 410 }; await worker.runOnce(now);
  assert.equal(db.prepare('SELECT count(*) AS n FROM push_subscriptions').get().n, 0, 'expired endpoints are removed');
  failure = null;
  subscribe();
  await assert.rejects(service.test(a, 'a-session', subscription.endpoint, 'sms_payment'), /no unanswered SMS payment/);
  const { insertTransaction } = require('../src/plugins/transactions/transaction.model');
  const paymentId = insertTransaction(db, a, { date, description: 'Private SMS merchant', amount: 5, source: 'sms' });
  require('../src/plugins/notifications/payment-prompts').record(db, a, paymentId);
  await service.test(a, 'a-session', subscription.endpoint, 'sms_payment');
  const notice = sent.at(-1).payload;
  assert.equal(notice.kind, 'sms_payment');
  assert.match(notice.promptId, /^[a-f0-9]{24}$/);
  assert.equal(notice.detail.party, 'Private SMS merchant', 'details are on by default');
  db.prepare('UPDATE push_subscriptions SET preferences = ? WHERE user_id = ?').run(JSON.stringify({ ...prefs, details: false }), a);
  await service.test(a, 'a-session', subscription.endpoint, 'sms_payment');
  assert(!JSON.stringify(sent.at(-1).payload).includes('Private SMS merchant'), 'details off keeps the merchant on the desktop');
  assert.equal(db.prepare('SELECT count(*) FROM transactions WHERE id = ?').pluck().get(paymentId), 1, 'testing a reply does not create another payment');
  await assert.rejects(service.test(b, 'a-session', subscription.endpoint, 'sms_payment'), /Enable notifications/);
  db.prepare('DELETE FROM users WHERE id = ?').run(a);
  assert.equal(db.prepare('SELECT count(*) AS n FROM push_subscriptions').get().n, 0, 'account deletion removes device data');
  assert.equal(db.pragma('foreign_key_check').length, 0);
  console.log('Passed: subscription validation and isolation, task/habit/bill eligibility, timezones, rest/vacation/completion, durable dedupe, retry, expired endpoints, session/password revocation, account deletion, and private payloads.');
}
main().then(() => db.close()).catch((err) => { console.error(err); db.close(); process.exitCode = 1; });
