// In-memory data and mocked Web Push/Redis. No private DB, real SMS, or outbound requests.
const assert = require('node:assert/strict');
const Database = require('better-sqlite3-multiple-ciphers');
const db = new Database(':memory:');
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports }; };
const RealDate = Date;
let clock = RealDate.parse('2026-11-15T08:00:00Z');
global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } };
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
const sent = [], sessions = new Map();
let fail = false;
stub('web-push', { ...webpush, sendNotification: async (_sub, data) => { if (fail) throw new Error('mock network failure'); sent.push(JSON.parse(data)); } });
stub('../src/config', { push: { ...keys, subject: 'mailto:test@example.invalid' } });
stub('../src/config/db', { getDb: () => db });
stub('../src/config/redis', { redis: { get: async (key) => sessions.get(key) } });
stub('../src/core/logger', { info() {}, warn() {}, error() {} });
for (const migration of require('../src/config/migrations')) typeof migration === 'function' ? migration(db) : db.exec(migration);
db.pragma('foreign_keys = ON');
const { insertUser } = require('../src/plugins/users/user.model');
const { seedDefaults } = require('../src/plugins/users/defaults');
const sms = require('../src/plugins/sms/sms.service');
const payments = require('../src/plugins/notifications/payment-prompts');
const notifications = require('../src/plugins/notifications/notification.service');
const worker = require('../src/plugins/notifications/notification.worker');
const a = insertUser(db, { name: 'A', email: 'payment-a@example.invalid', passwordHash: 'unused' });
const b = insertUser(db, { name: 'B', email: 'payment-b@example.invalid', passwordHash: 'unused' });
seedDefaults(db, a); seedDefaults(db, b);
sms.saveAccounts(a, { accounts: [{ bank: 'sbi', last4: '1111', senders: ['TEST-SBI'] }] });
const device = sms.authenticate(`Bearer ${sms.createDevice(a, { name: 'Synthetic phone' }).token}`);
const { createECDH } = require('node:crypto');
const curve = createECDH('prime256v1'); curve.generateKeys();
const preferences = { ...notifications.DEFAULT_PREFERENCES, tasks: false, habits: false, bills: false };
function subscribe(user, name) {
  const stamp = db.prepare('SELECT password_changed_at FROM users WHERE id = ?').pluck().get(user);
  sessions.set(`squirl:sess:${name}`, JSON.stringify({ userId: user, passwordChangedAt: stamp }));
  return notifications.subscribe(user, name, stamp, { preferences, subscription: {
    endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
    keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') },
  } });
}
const body = (n) => `Dear UPI user A/C X1111 debited by 2.00 on date 15Nov26 trf to SYNTHETIC SHOP Refno ${900000000000 + n} If not u? call-1800000000 for other services-1800000001-SBI`;
const input = (n, overrides = {}) => ({ eventId: `event-${n}`, sender: 'TEST-SBI', body: body(n), receivedAt: new Date().toISOString(), ...overrides });
const promptFor = (tx) => db.prepare('SELECT * FROM payment_prompts WHERE transaction_id = ?').get(tx);
const rowFor = (tx) => db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx);
async function main() {
  subscribe(a, 'a-session'); subscribe(b, 'b-session');
  // Existing subscriptions missing the new preference also get the requested payment prompts.
  db.prepare('UPDATE push_subscriptions SET preferences = ? WHERE user_id = ?').run(JSON.stringify({ tasks: false, habits: false, bills: false, dailyTime: '09:00', habitTime: '20:00' }), a);
  assert.equal(notifications.deviceStatus(a, 'a-session', 'https://fcm.googleapis.com/fcm/send/a-session').preferences.smsPayments, true);
  clock += 1000;
  const first = sms.ingest(device, input(1));
  const prompt = promptFor(first.transactionId);
  assert.equal(first.status, 'captured'); assert(prompt);
  sms.ingest(device, input(1));
  sms.ingest(device, input(1, { eventId: 'rebroadcast-1' }));
  sms.ingest(device, input(2, { body: 'A/C X1111 unknown format' }));
  sms.ingest(device, input(3, { body: 'A/C X1111 OTP 123456' }));
  assert.equal(db.prepare('SELECT count(*) FROM payment_prompts').pluck().get(), 1);
  await worker.runOnce();
  assert.deepEqual(sent.map(({ detail, ...m }) => m), [{ kind: 'sms_payment', tag: `sms-payment-${prompt.id}`, promptId: prompt.id }]);
  assert.equal(sent[0].detail.party.includes('SYNTHETIC SHOP'), true, 'details are on by default');
  assert(sent[0].detail.amount > 0 && ['debit', 'credit'].includes(sent[0].detail.type));
  await worker.runOnce(); assert.equal(sent.length, 1);
  await assert.rejects(payments.get(b, prompt.id), (e) => e.statusCode === 404);
  await assert.rejects(payments.reply(b, prompt.id, 'Wrong account'), /no longer available/);
  db.prepare("UPDATE transactions SET source = 'import', notes = 'Existing annotation' WHERE id = ?").run(first.transactionId);
  const saved = await payments.reply(a, prompt.id, 'Lunch');
  assert.equal(saved.transaction.notes, 'Existing annotation\nLunch');
  assert.equal(rowFor(first.transactionId).description.includes('SYNTHETIC SHOP'), true);
  assert.equal(rowFor(first.transactionId).amount_paise, 200);
  assert(saved.answeredAt);
  await payments.reply(a, prompt.id, 'Lunch');
  assert.equal(rowFor(first.transactionId).notes, 'Existing annotation\nLunch');
  await assert.rejects(payments.reply(a, prompt.id, 'Different answer'), (e) => e.code === 'PAYMENT_ALREADY_ANSWERED');
  assert.equal(db.prepare('SELECT notes FROM transactions WHERE user_id = ?').pluck().get(b), undefined);

  clock += 1000;
  const second = sms.ingest(device, input(4));
  fail = true; await worker.runOnce();
  const receipt = db.prepare('SELECT * FROM push_deliveries WHERE reminder_key = ?').get(`sms-payment:${promptFor(second.transactionId).id}`);
  assert.equal(receipt.sent_at, null); assert(receipt.retry_at > clock);
  fail = false; await worker.runOnce(); assert.equal(sent.length, 1);
  clock += 180_000; await worker.runOnce(); assert.equal(sent.length, 2);
  await worker.runOnce(); assert.equal(sent.length, 2);

  db.prepare('UPDATE push_subscriptions SET preferences = ? WHERE user_id = ?').run(JSON.stringify({ ...preferences, smsPayments: false }), a);
  const muted = sms.ingest(device, input(5));
  await worker.runOnce(); assert.equal(sent.length, 2, 'device preference suppresses payment pushes');
  db.prepare('UPDATE transactions SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), muted.transactionId);
  await assert.rejects(payments.reply(a, promptFor(muted.transactionId).id, 'Archived'), /no longer available/);
  db.prepare('UPDATE push_subscriptions SET preferences = ? WHERE user_id = ?').run(JSON.stringify(preferences), a);
  await worker.runOnce(); assert.equal(sent.length, 2, 'archived payments stay excluded');

  const full = sms.ingest(device, input(6));
  db.prepare('UPDATE transactions SET notes = ? WHERE id = ?').run('x'.repeat(1000), full.transactionId);
  await assert.rejects(payments.reply(a, promptFor(full.transactionId).id, 'Extra'), (e) => e.code === 'PAYMENT_NOTE_FULL');
  assert.equal(promptFor(full.transactionId).answered_at, null, 'failed writes do not consume the prompt');
  assert.equal(rowFor(full.transactionId).notes.length, 1000);
  const count = db.prepare('SELECT count(*) FROM payment_prompts').pluck().get();
  const transactionsBefore = db.prepare('SELECT count(*) FROM transactions').pluck().get();
  db.exec("CREATE TEMP TRIGGER fail_sms_link BEFORE UPDATE OF transaction_id ON sms_events WHEN NEW.event_key = 'atomic-failure' BEGIN SELECT RAISE(ABORT, 'synthetic failure after prompt creation'); END");
  assert.throws(() => sms.ingest(device, input(8, { eventId: 'atomic-failure' })), /synthetic failure/);
  assert.equal(db.prepare('SELECT count(*) FROM payment_prompts').pluck().get(), count, 'failed ingestion rolls back the prompt');
  assert.equal(db.prepare('SELECT count(*) FROM transactions').pluck().get(), transactionsBefore, 'failed ingestion rolls back the payment too');
  db.exec('DROP TRIGGER fail_sms_link');
  const sub = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').get(a);
  const pending = payments.pending(db, sub, new Date());
  assert(pending.some((p) => p.promptId === promptFor(second.transactionId).id));
  const plain = payments.pending(db, { ...sub, preferences: JSON.stringify({ details: false }) }, new Date());
  assert(plain.length && plain.every((p) => !p.detail), 'details off sends no amount or merchant');
  assert.deepEqual(payments.pending(db, { ...sub, created_at: new Date(clock + 1).toISOString() }, new Date()), [], 'new subscriptions do not receive historical payment prompts');
  assert.deepEqual(payments.pending(db, sub, new Date(clock + 2 * 86400_000)), [], 'old unanswered prompts expire from delivery');
  const reset = sms.ingest(device, input(7));
  db.prepare('UPDATE users SET financial_generation = financial_generation + 1 WHERE id = ?').run(a);
  await worker.runOnce(); assert.equal(sent.length, 2, 'reset invalidates old prompts');
  await assert.rejects(payments.get(a, promptFor(reset.transactionId).id), /no longer available/);
  db.prepare('DELETE FROM transactions WHERE user_id = ?').run(a);
  db.prepare('DELETE FROM categories WHERE user_id = ? AND parent_id IS NOT NULL').run(a);
  db.prepare('DELETE FROM categories WHERE user_id = ?').run(a);
  db.prepare('DELETE FROM users WHERE id = ?').run(a);
  assert.equal(db.prepare('SELECT count(*) FROM payment_prompts').pluck().get(), 0);
  assert.equal(db.pragma('foreign_key_check').length, 0);
  console.log('Passed: SMS prompt creation/deduplication, private payloads, owner isolation, device opt-out, retry receipts, append/idempotence, statement rows, deleted/reset guards, limits, and cascade cleanup.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { global.Date = RealDate; db.close(); });
