// Uses synthetic data and an in-memory database only. No files, real accounts or model calls.
const assert = require('node:assert/strict');
const Database = require('better-sqlite3-multiple-ciphers');
const db = new Database(':memory:');
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports }; };
stub('../src/config/db', { getDb: () => db });
stub('../src/core/logger', { info() {}, warn() {}, error() {} });
stub('../src/plugins/insights/suggestions.worker', { nudge() {}, resetForUser() {} });
let parse;
stub('../src/plugins/imports/import.client', { parseStatement: () => parse() });
let chat;
stub('../src/plugins/insights/llm.client', { chat: () => chat(), parseJson: JSON.parse });
const migrations = require('../src/config/migrations');
db.pragma('foreign_keys = OFF');
for (const m of migrations.slice(0, 9)) typeof m === 'function' ? m(db) : db.exec(m);
const { newId, nowIso, insertRow } = require('../src/core/sql');
const { insertUser } = require('../src/plugins/users/user.model');
const { insertTransaction, addTags } = require('../src/plugins/transactions/transaction.model');
const { insertCommitment } = require('../src/plugins/commitments/commitment.model');
const { toTransaction } = require('../src/plugins/imports/import.helper');
const { merchantKey } = require('../src/plugins/rules/rules.helper');
const a = insertUser(db, { name: 'Synthetic A', email: 'a@example.invalid', passwordHash: 'unused' });
const b = insertUser(db, { name: 'Synthetic B', email: 'b@example.invalid', passwordHash: 'unused' });
const now = nowIso();
const description = 'UPI/DR/123456789012/TEST SHOP/SBIN/testshop@upi/NA';
const parsedRow = { date: '2026-11-01', debit: 100, balance: 1000, description };
const batch = newId();
insertRow(db, 'imports', { id: batch, user_id: a, bank: 'sbi', file_name: 'synthetic.pdf', status: 'completed', created_at: now, updated_at: now });
const cat = newId();
insertRow(db, 'categories', { id: cat, user_id: a, name: 'Custom', slug: 'custom', type: 'expense', created_at: now, updated_at: now });
insertRow(db, 'tags', { id: newId(), user_id: a, name: 'Custom tag', group_name: 'custom', created_at: now, updated_at: now });
const imported = insertTransaction(db, a, { ...toTransaction(parsedRow, { bank: 'sbi', importId: batch }), category: cat });
const manual = insertTransaction(db, a, { date: '2026-11-02', description: 'Manual row', amount: 50 });
const other = insertTransaction(db, b, { date: '2026-11-02', description: 'Other account row', amount: 20 });
addTags(db, a, imported, ['Custom tag']);
for (const kind of ['loan', 'subscription', 'auto_debit']) insertCommitment(db, a, { kind, name: kind, amount: 100, dueDay: 2, startDate: '2026-11-02', category: cat });
insertCommitment(db, b, { kind: 'subscription', name: 'Other account subscription', amount: 100, dueDay: 2, startDate: '2026-11-02' });
const rule = newId();
const suggestion = newId();
insertRow(db, 'merchant_rules', { id: rule, user_id: a, direction: 'debit', merchant_key: merchantKey(description), example: description, category_id: cat, created_at: now, updated_at: now });
insertRow(db, 'merchant_suggestions', { id: suggestion, user_id: a, direction: 'debit', merchant_key: merchantKey(description), merchant: 'TEST SHOP', example: description, category_id: cat, confidence: 'high', created_at: now, updated_at: now });
// Run the populated-table migration with exactly the FK mode used by production.
migrations[9](db);
for (const m of migrations.slice(10)) typeof m === 'function' ? m(db) : db.exec(m);
// Simulate an installation that applied the earlier v10 without the generation column.
db.exec('ALTER TABLE users DROP COLUMN financial_generation');
migrations[11](db);
migrations[11](db); // repair is also safe when the column already exists
assert.equal(db.prepare('SELECT financial_generation FROM users WHERE id = ?').pluck().get(a), 0);
db.pragma('foreign_keys = ON');
assert.equal(db.pragma('foreign_key_check').length, 0);
assert.equal(db.prepare('SELECT count(*) FROM transaction_tags').pluck().get(), 1);
assert.equal(db.prepare('SELECT count(*) FROM active_transactions').pluck().get(), 3);
const { seedDefaults } = require('../src/plugins/users/defaults');
seedDefaults(db, a); seedDefaults(db, b);
const users = require('../src/plugins/users/user.service');
const txs = require('../src/plugins/transactions/transaction.service');
const insights = require('../src/plugins/insights/insights.service');
const commitments = require('../src/plugins/commitments/commitment.service');
const rules = require('../src/plugins/rules/rules.service');
const suggestions = require('../src/plugins/insights/suggestions.service');
const imports = require('../src/plugins/imports/import.service');
const tags = require('../src/plugins/tags/tag.service');
const schema = require('../src/plugins/users/user.validation').resetFinancialData;
const file = { originalname: 'synthetic.pdf', buffer: Buffer.from('synthetic') };
const active = (table, userId = a) => db.prepare(`SELECT count(*) FROM active_${table} WHERE user_id = ?`).pluck().get(userId);
const all = (table, userId = a) => db.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY rowid`).all(userId);

async function main() {
  // Verify the transaction-table rebuild against populated pre-reset storage too.
  const legacy = new Database(':memory:');
  legacy.pragma('foreign_keys = OFF');
  for (const m of migrations.slice(0, 8)) typeof m === 'function' ? m(legacy) : legacy.exec(m);
  const legacyUser = insertUser(legacy, { name: 'Legacy synthetic', email: 'legacy@example.invalid', passwordHash: 'unused' });
  const legacyTx = insertTransaction(legacy, legacyUser, { date: '2026-01-01', description: 'Legacy row', amount: 10, tags: ['retained'] });
  const legacyBefore = legacy.prepare('SELECT * FROM transactions WHERE id = ?').get(legacyTx);
  legacy.exec(migrations[8]);
  assert.deepEqual(legacy.prepare('SELECT * FROM active_transactions WHERE id = ?').get(legacyTx), { rowid: 1, ...legacyBefore, deleted_at: null });
  assert.equal(legacy.prepare('SELECT count(*) FROM transaction_tags').pluck().get(), 1);
  assert.equal(legacy.pragma('foreign_key_check').length, 0);
  legacy.close();
  assert.equal(schema.safeParse({ body: {} }).success, false);
  assert.equal(schema.safeParse({ body: { confirmation: 'RESET' } }).success, true);
  await users.updateProfile(a, { familyContacts: [{ name: 'Known Person', aliases: [], phone: '9000000001', relationship: 'Friend' }] });
  const profile = await users.getProfile(a);
  const snapshots = Object.fromEntries(['transactions', 'imports', 'commitments', 'merchant_rules', 'merchant_suggestions', 'categories', 'tags'].map((t) => [t, all(t)]));
  const otherTransactions = all('transactions', b);
  const otherCommitments = all('commitments', b);
  // A mid-reset failure must roll back every archived row and the reset generation.
  db.exec("CREATE TRIGGER block_reset BEFORE UPDATE OF deleted_at ON commitments BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  await assert.rejects(() => users.resetFinancialData(a), /synthetic failure/);
  assert.deepEqual(all('transactions'), snapshots.transactions);
  assert.equal(db.prepare('SELECT financial_generation FROM users WHERE id = ?').pluck().get(a), 0);
  db.exec('DROP TRIGGER block_reset');

  const result = await users.resetFinancialData(a);
  assert.equal(result.archived.transactions, 2);
  assert.equal(result.archived.commitments, 3);
  assert.equal(require('../src/plugins/users/family.worker').statusFor(a).status, 'cancelled');
  for (const table of ['transactions', 'imports', 'commitments', 'merchant_rules', 'merchant_suggestions']) assert.equal(active(table), 0, table);
  for (const [table, rows] of Object.entries(snapshots)) {
    for (const original of rows) {
      const stored = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(original.id);
      assert.ok(stored.deleted_at, `${table} record retained and archived`);
      for (const [key, value] of Object.entries(original)) if (!['deleted_at', 'updated_at'].includes(key)) assert.deepEqual(stored[key], value, `${table}.${key} preserved`);
    }
  }
  assert.equal(db.prepare('SELECT count(*) FROM transaction_tags WHERE transaction_id = ?').pluck().get(imported), 1);
  assert.deepEqual(all('transactions', b), otherTransactions);
  assert.deepEqual(all('commitments', b), otherCommitments);
  const after = await users.getProfile(a);
  assert.equal(after.name, profile.name); assert.equal(after.email, profile.email);
  assert.deepEqual(after.familyContacts, profile.familyContacts);
  assert.equal(after.stats.transactions, 0); assert.equal(after.stats.imports, 0);
  assert.equal(db.prepare('SELECT count(*) FROM active_categories WHERE user_id = ? AND name = ?').pluck().get(a, 'Custom'), 0);
  assert.ok(active('categories') > 0, 'default categories recreated');
  assert.ok(active('tags') > 0, 'default tags recreated');
  assert.equal((await txs.listTransactions(a, { page: 1, limit: 50 })).meta.total, 0);
  assert.equal((await txs.getSummary(a, { groupBy: 'categoryType' })).totals.count, 0);
  assert.equal((await insights.getBalances(a, {})).total, null);
  assert.deepEqual((await insights.getHistory(a, {})).months, []);
  assert.deepEqual((await commitments.listCommitments(a)).items, []);
  assert.deepEqual((await commitments.searchMerchants(a, '')).items, []);
  assert.equal((await rules.listRules(a)).rules.length, 0);
  assert.equal((await suggestions.listSuggestions(a)).total, 0);
  assert.ok((await tags.listTags(a, {})).every((t) => !t.count));
  await assert.rejects(() => txs.getTransaction(a, imported), /Transaction not found/);
  await assert.rejects(() => txs.updateTransaction(a, manual, { notes: 'hidden' }), /Transaction not found/);
  assert.equal((await txs.bulkUpdateTransactions(a, [imported], { tags: ['hidden'] })).matched, 0);
  await assert.rejects(() => commitments.updateCommitment(a, snapshots.commitments[0].id, { name: 'hidden' }), /Not found/);
  // Re-import the same statement: archived hashes do not suppress new rows, active duplicates do.
  parse = async () => ({ bank: 'sbi', transactions: [parsedRow] });
  await imports.createImport(a, { file, bank: 'sbi' });
  assert.equal(active('transactions'), 1);
  await imports.createImport(a, { file, bank: 'sbi' });
  assert.equal(active('transactions'), 1);
  assert.equal(all('transactions').length, 3);
  assert.equal(active('transactions', b), 1);
  // A parser response completing after reset cannot repopulate the ledger.
  let finish;
  parse = () => new Promise((resolve) => { finish = resolve; });
  const pendingImport = imports.createImport(a, { file, bank: 'sbi' });
  await users.resetFinancialData(a);
  finish({ bank: 'sbi', transactions: [parsedRow] });
  await assert.rejects(() => pendingImport, /reset while this import/);
  assert.equal(active('transactions'), 0);
  assert.equal(active('imports'), 0);
  // An old model response must not insert suggestions after reset either.
  let finishChat;
  chat = () => new Promise((resolve) => { finishChat = resolve; });
  const pendingSuggestion = suggestions.suggestBatch(db, a, [{ direction: 'debit', key: merchantKey(description), merchant: 'TEST SHOP', example: description }]);
  await users.resetFinancialData(a);
  finishChat({ text: '{"items":[]}', model: 'synthetic' });
  assert.equal(await pendingSuggestion, 0);
  assert.equal(active('merchant_suggestions'), 0);
  assert.equal(db.pragma('foreign_key_check').length, 0);
  assert.ok(db.prepare('SELECT 1 FROM transactions WHERE id = ? AND deleted_at IS NULL').get(other));
  console.log('Passed: populated migration, atomic reset/rollback, soft retention of every financial table, profile/contact preservation, tenant isolation, empty reports/balances/commitments, hidden-row mutation guards, fresh imports, dedupe, and in-flight parser/model protection.');
}
main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => { require('../src/plugins/users/family.worker').stopFamilyWorker(); db.close(); });
