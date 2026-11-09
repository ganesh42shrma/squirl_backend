// Statement immutability and optional notes, using synthetic in-memory data only.
const assert = require('node:assert/strict');
const Database = require('better-sqlite3-multiple-ciphers');
const db = new Database(':memory:');
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports }; };
stub('../src/config/db', { getDb: () => db });
stub('../src/core/logger', { info() {}, warn() {}, error() {} });
for (const m of require('../src/config/migrations')) typeof m === 'function' ? m(db) : db.exec(m);
db.pragma('foreign_keys = ON');
const { insertUser } = require('../src/plugins/users/user.model');
const { seedDefaults } = require('../src/plugins/users/defaults');
const { insertTransaction } = require('../src/plugins/transactions/transaction.model');
const { toTransaction } = require('../src/plugins/imports/import.helper');
const { newId, nowIso, insertRow } = require('../src/core/sql');
const service = require('../src/plugins/transactions/transaction.service');
const { updateTransaction: schema } = require('../src/plugins/transactions/transaction.validation');
const makeUser = (name) => {
  const id = insertUser(db, { name, email: `${name}@example.invalid`, passwordHash: 'unused' });
  seedDefaults(db, id); return id;
};
const user = makeUser('statement-notes'); const other = makeUser('other-notes');
const batch = newId(); const now = nowIso();
insertRow(db, 'imports', { id: batch, user_id: user, bank: 'kotak', file_name: 'synthetic.pdf', status: 'completed', created_at: now, updated_at: now });
const imported = insertTransaction(db, user, { ...toTransaction({ date: '2026-11-09', description: 'Synthetic bank payment', debit: 100, refNo: 'TEST123', balance: 900 }, { bank: 'kotak', importId: batch }), autoCategorized: true });
const manual = insertTransaction(db, user, { date: '2026-11-09', description: 'Manual purchase', amount: 50, account: 'cash' });
const raw = () => db.prepare('SELECT * FROM transactions WHERE id = ?').get(imported);
const category = db.prepare('SELECT id FROM active_categories WHERE user_id = ? AND type = ? LIMIT 1').pluck().get(user, 'expense');
const body = (value) => schema.parse({ params: { id: imported }, body: value }).body;
async function main() {
  // Partial updates must not introduce a default type and accidentally trip the lock.
  assert.deepEqual(body({ notes: '  Birthday gift  ' }), { notes: 'Birthday gift' });
  assert.equal(schema.safeParse({ params: { id: imported }, body: { notes: 'x'.repeat(1001) } }).success, false);
  const original = raw();
  let saved = await service.updateTransaction(user, imported, body({ notes: '  Birthday gift  ' }));
  assert.equal(saved.notes, 'Birthday gift');
  assert.equal(saved.autoCategorized, true, 'notes do not confirm an automatic category');
  for (const key of ['date', 'description', 'amount_paise', 'type', 'account', 'ref_no', 'balance_paise', 'hash', 'import_id', 'source']) assert.equal(raw()[key], original[key], key);
  let list = await service.listTransactions(user, { search: 'birthday', page: 1, limit: 20, sort: '-date' });
  assert.deepEqual(list.items.map((row) => row._id), [imported]);
  saved = await service.updateTransaction(user, imported, body({ notes: 'Revised note' }));
  assert.equal(saved.notes, 'Revised note');
  saved = await service.updateTransaction(user, imported, body({ notes: '' }));
  assert.equal(saved.notes, '');

  for (const patch of [{ description: 'Edited' }, { date: '2026-10-01' }, { amount: 1 }, { type: 'credit' }, { account: 'sbi' }, { paymentMode: 'cash' }, { notes: 'Must roll back', tags: ['blocked'], category, amount: 1 }]) {
    const snapshot = raw();
    await assert.rejects(() => service.updateTransaction(user, imported, body(patch)), (err) => err.code === 'STATEMENT_READ_ONLY' && err.statusCode === 400);
    assert.deepEqual(raw(), snapshot, 'blocked requests cannot partially update the note or statement');
  }
  saved = await service.updateTransaction(user, imported, body({ category, tags: ['gift'], notes: 'Personal annotation' }));
  assert.equal(saved.category._id, category);
  assert.deepEqual(saved.tags, ['gift']);
  assert.equal(saved.notes, 'Personal annotation');
  saved = await service.updateTransaction(user, imported, body({ category: null, tags: [] }));
  assert.equal(saved.category, null);
  assert.deepEqual(saved.tags, []);
  await assert.rejects(() => service.updateTransaction(other, imported, { notes: 'Wrong user' }), /Transaction not found/);
  saved = await service.updateTransaction(user, manual, { description: 'Updated manual entry', date: '2026-11-08', amount: 70, type: 'credit', account: 'sbi', notes: 'Manual note' });
  assert.equal(saved.description, 'Updated manual entry');
  assert.equal(saved.amount, 70); assert.equal(saved.type, 'credit'); assert.equal(saved.notes, 'Manual note');
  saved = await service.updateTransaction(user, manual, body({ notes: 'Credit note only' }));
  assert.equal(saved.type, 'credit', 'a note-only PATCH must preserve credit direction');
  await service.deleteTransaction(user, imported);
  await assert.rejects(() => service.updateTransaction(user, imported, { notes: 'Archived' }), /Transaction not found/);
  assert.equal(db.pragma('foreign_key_check').length, 0);
  console.log('Passed: immutable statement fields, atomic rejected updates, optional note add/edit/remove/search, category/tag edits, manual editing and tenant/archive isolation.');
}
main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => db.close());
