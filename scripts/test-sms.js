// Synthetic bank messages, in-memory SQLite, mocked workers/Redis. Never opens the USB DB.
const assert = require('node:assert/strict');
const Database = require('better-sqlite3-multiple-ciphers');
const db = new Database(':memory:');
db.pragma('foreign_keys = OFF'); // Same migration mode as connectDB; FK checks run afterwards.
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports }; };
stub('../src/config/db', { getDb: () => db });
stub('../src/core/logger', { info() {}, warn() {}, error() {} });
stub('../src/plugins/insights/suggestions.worker', { nudge() {}, resetForUser() {} });
stub('../src/plugins/goals/goal.worker', { nudge() {} });
const limitCalls = [];
stub('../src/core/rateLimit', { hit: async (key, options) => { limitCalls.push({ key, options }); } });
let statement;
stub('../src/plugins/imports/import.client', { parseStatement: async () => statement });
const RealDate = Date;
let clock = RealDate.parse('2026-11-15T08:00:00Z');
global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } };
const migrations = require('../src/config/migrations');
for (const m of migrations.slice(0, 19)) typeof m === 'function' ? m(db) : db.exec(m);
const { insertUser } = require('../src/plugins/users/user.model');
const { seedDefaults } = require('../src/plugins/users/defaults');
const { insertTransaction, addTags } = require('../src/plugins/transactions/transaction.model');
const { newId, nowIso, insertRow } = require('../src/core/sql');
const a = insertUser(db, { name: 'Synthetic A', email: 'sms-a@example.invalid', passwordHash: 'unused' });
const b = insertUser(db, { name: 'Synthetic B', email: 'sms-b@example.invalid', passwordHash: 'unused' });
seedDefaults(db, a); seedDefaults(db, b);
const before = insertTransaction(db, a, { date: '2026-01-01', description: 'Retained legacy row', amount: 10, tags: ['retained'] });
db.prepare('UPDATE transactions SET rowid = 75 WHERE id = ?').run(before);
const beforeRow = db.prepare('SELECT rowid, * FROM transactions WHERE id = ?').get(before);
const oldIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transactions' AND sql IS NOT NULL").pluck().all();
db.transaction(() => migrations[19](db))();
assert.deepEqual(db.prepare('SELECT rowid, * FROM transactions WHERE id = ?').get(before), { ...beforeRow, transfer_id: null });
assert.equal(db.prepare('SELECT count(*) FROM transaction_tags WHERE transaction_id = ?').pluck().get(before), 1);
assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transactions' AND sql IS NOT NULL").pluck().all(), oldIndexes);
db.pragma('foreign_keys = ON');
for (const m of migrations.slice(20)) typeof m === 'function' ? m(db) : db.exec(m);
const sms = require('../src/plugins/sms/sms.service');
const schemas = require('../src/plugins/sms/sms.validation');
const { parseSms } = require('../src/plugins/sms/sms.parser');
const imports = require('../src/plugins/imports/import.service');
const transactions = require('../src/plugins/transactions/transaction.service');
const suggestions = require('../src/plugins/insights/suggestions.service');
const users = require('../src/plugins/users/user.service');

// These are fictional senders, accounts, parties and references; configure real senders explicitly.
const ref = (n) => String(900000000000 + n);
const sbi = (n, { amount = '1.00', date = '15Nov26', last4 = '1111', party = 'SYNTHETIC SHOP' } = {}) =>
  `Dear UPI user A/C X${last4} debited by ${amount} on date ${date} trf to ${party} Refno ${ref(n)} If not u? call-1800000000 for other services-1800000001-SBI`;
const kotak = (n, type = 'credit', { amount = '1.00', party = 'SYNTHETIC SHOP' } = {}) => type === 'credit'
  ? `Received Rs.${amount} in your Kotak Bank AC 2222 from ${party} on 15-11-26.UPI Ref:${ref(n)}`
  : `Sent Rs.${amount} from Kotak Bank A/c X2222 to ${party} on 15-11-26. UPI Ref ${ref(n)}. Not done by you? Tap https://example.invalid/fraud`;
sms.saveAccounts(a, { accounts: [{ bank: 'sbi', last4: '1111', senders: ['TEST-SBI'] }, { bank: 'kotak', last4: '2222', senders: ['TEST-KOTAK'] }] });
sms.saveAccounts(b, { accounts: [{ bank: 'sbi', last4: '1111', senders: ['TEST-SBI'] }] });
const credentials = sms.createDevice(a, { name: 'Synthetic Pixel' });
const otherCredentials = sms.createDevice(b, { name: 'Other user phone' });
const device = sms.authenticate(`Bearer ${credentials.token}`);
const otherDevice = sms.authenticate(`Bearer ${otherCredentials.token}`);
clock += 60_000;
let serial = 0;
const input = (body, sender = 'TEST-SBI', extra = {}) => ({ eventId: `event-${++serial}`, sender, body, receivedAt: nowIso(), ...extra });
const deliver = (body, sender = 'TEST-SBI', extra = {}, d = device) => sms.ingest(d, schemas.ingest.parse({ body: input(body, sender, extra) }).body);
const row = (id) => db.prepare('SELECT * FROM active_transactions WHERE id = ?').get(id);
const upload = async (bank, rows, userId = a) => {
  statement = { bank, transactions: rows };
  return imports.createImport(userId, { bank, file: { originalname: 'synthetic.pdf', buffer: Buffer.from('synthetic') } });
};
const statementRow = (n, extra = {}) => ({ date: '2026-11-15', description: `UPI/DR/${ref(n)}/SYNTHETIC SHOP/SBIN/shop@upi/NA`, refNo: ref(n), debit: 1, balance: 100, ...extra });

async function main() {
  for (const [body, bank, type] of [[sbi(1), 'sbi', 'debit'], [kotak(1), 'kotak', 'credit'], [kotak(2, 'debit'), 'kotak', 'debit']]) {
    assert.equal(parseSms(body).status, 'parsed');
    assert.equal(parseSms(body).bank, bank);
    assert.equal(parseSms(body).type, type);
    assert.equal(parseSms(body).date, '2026-11-15');
  }
  for (const bad of ['0.00', '1,2.00', '9999999999999999999.00']) assert.equal(parseSms(sbi(1, { amount: bad })).status, 'review');
  for (const date of ['31Nov26', '00Nov26', '15Foo26', '29Feb25']) assert.equal(parseSms(sbi(1, { date })).status, 'review');
  assert.equal(parseSms(sbi(1, { amount: '1,23,456.78' })).amount, 123456.78);
  assert.equal(parseSms('Your UPI transaction has failed.').status, 'ignored');
  assert.equal(parseSms('Your OTP is 000000.').status, 'ignored');
  assert.equal(parseSms(sbi(1) + ' Another debit of 500.00').status, 'review');
  for (const body of [{ ...input(sbi(1)), amount: 100 }, { ...input(sbi(1)), body: 'x'.repeat(1501) }, { ...input(sbi(1)), receivedAt: 'yesterday' }]) {
    assert.equal(schemas.ingest.safeParse({ body }).success, false);
  }
  assert.equal(schemas.accounts.safeParse({ body: { accounts: [{ bank: 'sbi', last4: '1111', senders: [] }] } }).success, false);
  assert.equal(JSON.stringify(sms.listDevices(a)).includes(credentials.token), false);
  assert.notEqual(db.prepare('SELECT token_hash FROM sms_devices WHERE id = ?').pluck().get(device.id), credentials.token);
  assert.throws(() => sms.authenticate('Bearer incorrect'), (e) => e.statusCode === 401);
  assert.throws(() => sms.revokeDevice(b, device.id), (e) => e.statusCode === 404);

  const original = input(sbi(1));
  const first = sms.ingest(device, original);
  assert.equal(first.status, 'captured');
  assert.equal(row(first.transactionId).source, 'sms');
  assert.equal(row(first.transactionId).amount_paise, 100);
  assert.equal((await transactions.getTransaction(a, first.transactionId)).smsEvidenceCount, 1);
  assert.deepEqual(sms.ingest(device, original), first);
  assert.throws(() => sms.ingest(device, { ...original, body: sbi(2) }), (e) => e.code === 'SMS_EVENT_REUSED');
  assert.equal(deliver(sbi(1)).transactionId, first.transactionId, 'repeat broadcast cannot double count');
  assert.equal(deliver(sbi(1, { party: 'OTHER NARRATION' })).transactionId, first.transactionId, 'financial identity beats wording');
  const second = deliver(sbi(2));
  assert.notEqual(second.transactionId, first.transactionId, 'same amount/date with a different UPI reference is distinct');
  const isolated = deliver(sbi(1), 'TEST-SBI', {}, otherDevice);
  assert.notEqual(isolated.transactionId, first.transactionId);
  assert.equal(row(isolated.transactionId).user_id, b);
  const countBefore = db.prepare('SELECT count(*) FROM sms_events').pluck().get();
  assert.equal(deliver('Personal chat content', 'FRIEND').reason, 'sender_not_allowed');
  assert.equal(db.prepare('SELECT count(*) FROM sms_events').pluck().get(), countBefore);
  const otp = deliver('OTP 000000. Do not share.');
  assert.equal(otp.status, 'ignored');
  assert.equal(db.prepare('SELECT body FROM sms_events WHERE id = ?').pluck().get(otp.id), null);
  assert.equal(deliver(sbi(3, { last4: '9999' })).reason, 'account_not_mapped');
  assert.equal(deliver(sbi(4), 'TEST-KOTAK').reason, 'sender_bank_mismatch');
  assert.equal(deliver(sbi(4, { date: '01Nov26' })).reason, 'date_outside_window');
  assert.throws(() => deliver(sbi(4), 'TEST-SBI', { receivedAt: '2026-11-16T08:00:00Z' }), (e) => e.code === 'SMS_EVENT_DATE');
  assert.throws(() => deliver(sbi(4), 'TEST-SBI', { receivedAt: '2026-11-14T08:00:00Z' }), (e) => e.code === 'SMS_EVENT_DATE');

  assert.equal(suggestions.pendingGroups(db, a).some((g) => g.ids.includes(first.transactionId)), false, 'SMS descriptions are excluded from AI prompts');
  assert.equal(suggestions.autoCategorize(db, a), 0);
  await assert.rejects(transactions.updateTransaction(a, first.transactionId, { amount: 50 }), (e) => e.code === 'STATEMENT_READ_ONLY');
  await transactions.updateTransaction(a, first.transactionId, { notes: 'User note', tags: ['retained-sms'] });
  const idBefore = row(first.transactionId).rowid;
  const merged = await upload('sbi', [statementRow(1)]);
  assert.equal(merged.stats.reconciled, 1);
  assert.equal(merged.stats.inserted, 0);
  assert.equal(merged.stats.duplicates, 0);
  assert.equal(row(first.transactionId).source, 'import');
  assert.equal(row(first.transactionId).rowid, idBefore);
  const mergedTx = await transactions.getTransaction(a, first.transactionId);
  assert.equal(mergedTx.notes, 'User note');
  assert.deepEqual(mergedTx.tags, ['retained-sms']);
  assert.equal(mergedTx.balance, 100);
  assert.equal((await upload('sbi', [statementRow(1)])).stats.duplicates, 1);
  await imports.deleteImport(a, merged._id);
  assert.equal(row(first.transactionId).source, 'sms', 'undo retains independently captured SMS');
  assert.equal(row(first.transactionId).balance_paise, null);
  assert.equal((await upload('sbi', [statementRow(1)])).stats.reconciled, 1);

  const beforeSms = await upload('sbi', [statementRow(10)]);
  const promptCount = db.prepare('SELECT count(*) FROM payment_prompts').pluck().get();
  const late = deliver(sbi(10));
  assert.equal(db.prepare('SELECT count(*) FROM payment_prompts').pluck().get(), promptCount, 'an already-recorded statement payment does not trigger a new-payment prompt');
  assert.equal(late.status, 'reconciled', 'statement before SMS attaches evidence without a new ledger row');
  assert.equal(row(late.transactionId).import_id, beforeSms._id);
  await imports.deleteImport(a, beforeSms._id);
  assert.equal(row(late.transactionId).source, 'sms');

  const debit = deliver(sbi(20));
  const credit = deliver(kotak(20), 'TEST-KOTAK');
  assert.ok(row(debit.transactionId).transfer_id);
  assert.equal(row(credit.transactionId).transfer_id, row(debit.transactionId).transfer_id);
  const transferCategory = db.prepare('SELECT type FROM categories WHERE id = ?').pluck().get(row(credit.transactionId).category_id);
  assert.equal(transferCategory, 'transfer');
  const familyWorker = require('../src/plugins/users/family.worker');
  db.prepare('UPDATE users SET family_contacts = ? WHERE id = ?').run(JSON.stringify([{ name: 'SYNTHETIC SHOP', aliases: [] }]), a);
  familyWorker.enqueue(db, a);
  while (familyWorker.runBatch(db, a)) { /* finish the synthetic contact scan */ }
  assert.equal(row(debit.transactionId).category_id, row(credit.transactionId).category_id);
  assert.equal(db.prepare('SELECT type FROM categories WHERE id = ?').pluck().get(row(debit.transactionId).category_id), 'transfer');
  db.prepare("UPDATE users SET family_contacts = '[]' WHERE id = ?").run(a);
  const summary = await transactions.getSummary(a, { groupBy: 'categoryType' });
  assert.equal(summary.groups.find((g) => g.key === 'transfer').debit, 1);
  assert.equal(summary.groups.find((g) => g.key === 'transfer').credit, 1);
  const unpaired = deliver(kotak(21, 'debit'), 'TEST-KOTAK');
  assert.equal(row(unpaired.transactionId).transfer_id, null, 'same party name/amount is insufficient');

  const ambiguous = [statementRow(30), statementRow(30, { balance: 200, description: `UPI/DR/${ref(30)}/OTHER SHOP/SBIN/other/NA` })];
  await upload('sbi', ambiguous);
  assert.equal(deliver(sbi(30)).reason, 'ambiguous_match');
  await upload('sbi', [statementRow(31, { debit: 5 })]);
  assert.equal(deliver(sbi(31)).reason, 'reference_conflict', 'a changed amount requires review without double counting');
  const conflict = deliver(sbi(32));
  await transactions.updateTransaction(a, conflict.transactionId, { notes: 'Retained conflicting annotation', tags: ['conflict-note'] });
  await upload('sbi', [statementRow(32, { debit: 5 })]);
  assert.equal(row(conflict.transactionId), undefined, 'conflicting provisional SMS is excluded from totals');
  assert.equal(db.prepare('SELECT reason FROM sms_events WHERE id = ?').pluck().get(conflict.id), 'statement_conflict');
  assert.equal(sms.listEvents(a, { page: 1, limit: 100, status: 'review' }).items.find((e) => e.id === conflict.id).previousTransaction.notes, 'Retained conflicting annotation');
  const resolved = sms.reviewEvent(a, conflict.id, { date: '2026-11-15', amount: 5, type: 'debit', refNo: ref(32), last4: '1111', description: 'Reviewed synthetic payment' });
  assert.equal(resolved.status, 'reconciled');
  const resolvedTx = await transactions.getTransaction(a, resolved.transactionId);
  assert.equal(resolvedTx.notes, 'Retained conflicting annotation');
  assert.deepEqual(resolvedTx.tags, ['conflict-note']);
  const pendingAmbiguous = deliver(sbi(33));
  const ambiguousImport = await upload('sbi', [statementRow(33), statementRow(33, { balance: 50 })]);
  assert.equal(ambiguousImport.stats.inserted, 2);
  assert.equal(ambiguousImport.stats.reconciled, 0);
  assert.equal(row(pendingAmbiguous.transactionId), undefined);
  assert.equal(db.prepare('SELECT reason FROM sms_events WHERE id = ?').pluck().get(pendingAmbiguous.id), 'ambiguous_statement');

  const unknown = deliver('An unfamiliar SBI payment format');
  assert.equal(unknown.status, 'review');
  assert.throws(() => sms.reviewEvent(b, unknown.id), (e) => e.statusCode === 404);
  const confirmed = sms.reviewEvent(a, unknown.id, { date: '2026-11-15', amount: 3, type: 'debit', refNo: ref(40), last4: '1111', description: 'Confirmed synthetic merchant' });
  assert.equal(confirmed.status, 'captured');
  assert.equal(row(confirmed.transactionId).amount_paise, 300);
  assert.equal(sms.reviewEvent(a, deliver('Other unknown SBI format').id).status, 'dismissed');
  await transactions.deleteTransaction(a, second.transactionId);
  assert.equal(deliver(sbi(2, { party: 'RENAMED PARTY' })).reason, 'transaction_deleted');
  const receiptCount = db.prepare('SELECT count(*) FROM sms_events').pluck().get();
  const broken = input(sbi(55));
  db.exec("CREATE TRIGGER break_sms_update BEFORE UPDATE OF status ON sms_events WHEN NEW.status = 'captured' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END");
  assert.throws(() => sms.ingest(device, broken), /synthetic write failure/);
  assert.equal(db.prepare('SELECT count(*) FROM sms_events').pluck().get(), receiptCount);
  assert.equal(db.prepare('SELECT count(*) FROM transactions WHERE user_id = ? AND ref_no = ?').pluck().get(a, ref(55)), 0);
  db.exec('DROP TRIGGER break_sms_update');
  assert.equal(sms.ingest(device, broken).status, 'captured', 'a failed write can be retried atomically');

  await httpChecks(credentials.token);
  const revoked = sms.createDevice(a, { name: 'Revoked' });
  const snapshot = sms.authenticate(`Bearer ${revoked.token}`);
  sms.revokeDevice(a, revoked.id);
  assert.throws(() => sms.authenticate(`Bearer ${revoked.token}`), (e) => e.statusCode === 401);
  assert.throws(() => deliver(sbi(50), 'TEST-SBI', {}, snapshot), (e) => e.statusCode === 401, 'recheck auth inside the write transaction');
  db.prepare('UPDATE users SET password_changed_at = ? WHERE id = ?').run('2026-11-15T09:00:00Z', b);
  assert.throws(() => sms.authenticate(`Bearer ${otherCredentials.token}`), (e) => e.statusCode === 401);
  await users.resetFinancialData(a);
  assert.throws(() => sms.authenticate(`Bearer ${credentials.token}`), (e) => e.statusCode === 401);
  assert.equal(sms.listAccounts(a).length, 0);
  assert.equal(sms.listEvents(a, { page: 1, limit: 100 }).meta.total, 0);
  assert.equal(db.prepare('SELECT count(*) FROM sms_accounts WHERE user_id = ? AND deleted_at IS NULL').pluck().get(b), 1);
  assert.equal(db.pragma('foreign_key_check').length, 0);
  console.log('SMS: migration preservation, bank parsing, pairing/auth/CSRF, review, dedupe, transfers, both import orders, undo, deletion and reset passed.');
}

async function httpChecks(token) {
  const express = require('express');
  const { csrfGuard, requireAuth } = require('../src/core/auth');
  const routes = require('../src/plugins/sms/sms.routes');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const userId = req.get('X-Synthetic-User');
    if (userId) req.session = { userId, passwordChangedAt: db.prepare('SELECT password_changed_at FROM users WHERE id = ?').pluck().get(userId) };
    next();
  });
  app.use(csrfGuard);
  app.use('/api/sms', routes.ingestRouter);
  app.use(requireAuth);
  app.use('/api/sms', routes.router);
  app.use('/api/transactions', require('../src/plugins/transactions/transaction.routes'));
  app.use('/api/notifications', require('../src/plugins/notifications/notification.routes'));
  app.use(require('../src/core/errorHandler'));
  const server = await new Promise((resolve, reject) => {
    const s = require('node:http').createServer(app);
    s.once('error', reject);
    s.once('listening', () => resolve(s));
    s.listen(0, '127.0.0.1');
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const request = (path, { method = 'GET', body, headers = {} } = {}) => fetch(`${base}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body && { body: JSON.stringify(body) }),
    });
    const bridge = { Authorization: `Bearer ${token}`, 'X-Requested-With': 'squirl' };
    assert.equal((await request('/sms/ingest', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: input(sbi(60)) })).status, 403);
    assert.equal((await request('/sms/ingest', { method: 'POST', headers: { 'X-Requested-With': 'squirl' }, body: input(sbi(60)) })).status, 401);
    assert.equal((await request('/sms/ingest', { method: 'POST', headers: bridge, body: input(sbi(60)) })).status, 200);
    assert.ok(limitCalls.some((r) => r.key === `sms-ingest:${device.id}`));
    assert.equal((await request('/sms/ingest', { method: 'POST', headers: bridge, body: { ...input(sbi(61)), userId: b } })).status, 400);
    for (const path of ['/sms/accounts', '/sms/devices', '/sms/events', '/transactions']) assert.equal((await request(path, { headers: bridge })).status, 401, 'bridge token cannot read account data');
    const browser = { 'X-Synthetic-User': a, 'X-Requested-With': 'squirl' };
    const payment = db.prepare('SELECT id FROM payment_prompts WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').get(a).id;
    const paymentPath = `/notifications/payments/${payment}`;
    assert.equal((await request(paymentPath, { headers: bridge })).status, 401);
    assert.equal((await request(`${paymentPath}/reply`, { method: 'POST', headers: bridge, body: { note: 'No browser session' } })).status, 401);
    assert.equal((await request(paymentPath, { headers: { 'X-Synthetic-User': b } })).status, 404);
    assert.equal((await request(`${paymentPath}/reply`, { method: 'POST', headers: { 'X-Synthetic-User': a }, body: { note: 'No CSRF' } })).status, 403);
    for (const body of [{ note: '' }, { note: 'x'.repeat(501) }, { note: 'Valid note', userId: b }])
      assert.equal((await request(`${paymentPath}/reply`, { method: 'POST', headers: browser, body })).status, 400);
    assert.equal((await request(paymentPath, { headers: browser })).status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await request(`${paymentPath}/reply`, { method: 'POST', headers: browser, body: { note: 'Lunch' } })).status, 200);
    assert.equal((await request(`${paymentPath}/reply`, { method: 'POST', headers: browser, body: { note: 'Other note' } })).status, 409);
    assert.equal((await request('/sms/accounts', { headers: browser })).status, 200);
    assert.equal((await request('/sms/devices', { method: 'POST', headers: browser, body: { name: 'Paired by session' } })).status, 201);
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => { global.Date = RealDate; db.close(); });
