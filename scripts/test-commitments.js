// Payment matching uses only synthetic accounts and an in-memory database.
const assert = require('node:assert/strict');
const Database = require('better-sqlite3-multiple-ciphers');
const db = new Database(':memory:');
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports }; };
stub('../src/config/db', { getDb: () => db });
for (const m of require('../src/config/migrations')) typeof m === 'function' ? m(db) : db.exec(m);
db.pragma('foreign_keys = ON');
const { insertRow, newId, nowIso } = require('../src/core/sql');
const { insertUser } = require('../src/plugins/users/user.model');
const { insertCommitment } = require('../src/plugins/commitments/commitment.model');
const { counterparty } = require('../src/plugins/rules/rules.helper');
const service = require('../src/plugins/commitments/commitment.service');
const a = insertUser(db, { name: 'Synthetic A', email: 'loan-a@example.invalid', passwordHash: 'unused' });
const b = insertUser(db, { name: 'Synthetic B', email: 'loan-b@example.invalid', passwordHash: 'unused' });
const stamp = nowIso();
const category = newId();
insertRow(db, 'categories', { id: category, user_id: a, name: 'Vehicle Loan', slug: 'vehicle-loan', type: 'expense', created_at: stamp, updated_at: stamp });
const original = 'DEBIT ACHDr NACH123456789 DELTA FINANCI 123456';
const changed = 'DEBIT ACHDr NACH987654321 DELTA LOANEMID 654321';
const oldKey = counterparty(original).key;
const newKey = counterparty(changed).key;
const defaults = { kind: 'loan', name: 'Synthetic loan', amount: 14689, dueDay: 2, startDate: '2026-01-02', matchKey: oldKey, account: 'sbi', category };
const loan = insertCommitment(db, a, defaults);
const payment = newId();
const txn = (id, changes = {}, userId = a) => insertRow(db, 'transactions', {
  id, user_id: userId, date: '2026-11-02', description: changed, amount_paise: 1468900,
  type: 'debit', account: 'sbi', source: 'import', category_id: category, created_at: stamp, updated_at: stamp, ...changes,
});
// A later statement row establishes coverage independently of the EMI candidate.
txn(newId(), { date: '2026-11-14', description: 'Synthetic unrelated purchase', amount_paise: 100 });
txn(payment);
const view = async () => (await service.listCommitments(a, '2026-11-14')).items.find((i) => i._id === loan);
const patch = (table, id, changes) => {
  const names = Object.keys(changes);
  db.prepare(`UPDATE ${table} SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(changes), id);
};

async function main() {
  assert.notEqual(oldKey, newKey, 'reproduce a changed bank narration');
  let item = await view();
  assert.equal(item.last.state, 'paid'); assert.equal(item.last.payment._id, payment);
  assert.equal(item.recentPayments[0]._id, payment);
  assert.equal((await service.listAlerts(a, '2026-11-14')).alerts.length, 0, 'no false missed-payment reminder');
  assert.equal(db.prepare('SELECT match_key FROM commitments WHERE id = ?').get(loan).match_key, oldKey, 'matching is read-only');

  // Every independent piece of evidence is required for a changed narration.
  for (const changes of [
    { amount_paise: 1468901 }, { account: 'kotak' }, { category_id: null },
    { description: 'DEBIT ACHDR NACH987654321 DIFFERENT LOANEMID' },
    { type: 'credit' }, { source: 'manual' }, { deleted_at: stamp }, { date: '2026-10-01' },
  ]) {
    patch('transactions', payment, changes);
    assert.notEqual((await view()).last.state, 'paid', JSON.stringify(changes));
    patch('transactions', payment, { amount_paise: 1468900, account: 'sbi', category_id: category, description: changed, type: 'debit', source: 'import', deleted_at: null, date: '2026-11-02' });
  }
  for (const changes of [{ account: null }, { category_id: null }, { match_key: null }, { kind: 'subscription' }]) {
    patch('commitments', loan, changes);
    assert.notEqual((await view()).last.state, 'paid');
    patch('commitments', loan, { account: 'sbi', category_id: category, match_key: oldKey, kind: 'loan' });
  }
  const duplicate = newId(); txn(duplicate, { date: '2026-11-03' });
  assert.notEqual((await view()).last.state, 'paid', 'two candidates require review');
  patch('transactions', duplicate, { deleted_at: stamp });
  assert.equal((await view()).last.state, 'paid', 'archived rows no longer compete');

  const otherLoan = insertCommitment(db, a, { ...defaults, name: 'Another loan', matchKey: newKey });
  assert.notEqual((await view()).last.state, 'paid', 'an existing exact link takes precedence over a changed narration');
  // The single-item endpoint must check the other commitments too, not just the requested one.
  assert.notEqual((await service.getCommitment(a, loan, '2026-11-14')).last.state, 'paid');
  patch('commitments', otherLoan, { match_key: oldKey });
  assert.notEqual((await view()).last.state, 'paid', 'two similar loans cannot both claim a changed narration');
  patch('commitments', otherLoan, { active: 0 });
  assert.equal((await view()).last.state, 'paid', 'paused commitments do not claim payments');
  insertCommitment(db, b, { ...defaults, category: null });
  txn(newId(), { category_id: null }, b);
  assert.equal((await view()).last.state, 'paid', 'other users cannot affect matching');

  // Existing exact merchant matching still works, but respects the selected bank account.
  patch('transactions', payment, { description: original });
  assert.equal((await view()).last.state, 'paid');
  patch('transactions', payment, { account: 'kotak' });
  assert.notEqual((await view()).last.state, 'paid', 'same merchant on a different account is not payment proof');
  patch('transactions', payment, { account: 'sbi', amount_paise: 1460000 });
  assert.equal((await view()).last.state, 'paid', 'exact links retain the existing amount tolerance');

  // Undoing and re-importing is reflected immediately without stored paid flags or balance writes.
  patch('transactions', payment, { description: changed, amount_paise: 1468900, deleted_at: stamp });
  assert.equal((await view()).last.state, 'missed');
  patch('transactions', payment, { deleted_at: null });
  assert.equal((await view()).last.state, 'paid');
  patch('transactions', payment, { date: '2026-11-25' });
  assert.equal((await view()).next.paid, true, 'a changed narration can identify the next EMI paid early');

  // An unrelated bank's newer statement cannot establish coverage of a selected bank.
  const scopedLoan = insertCommitment(db, b, { ...defaults, category: null, account: 'kotak' });
  assert.equal((await service.listCommitments(b, '2026-11-14')).items.find((i) => i._id === scopedLoan).last.state, 'awaiting');
  txn(newId(), { date: '2026-09-02' }); txn(newId(), { date: '2026-10-02' });
  assert(!(await service.detectRecurring(a)).items.some((i) => i.matchKey === newKey), 'a changed narration is not suggested as a second loan');
  assert.equal(db.pragma('foreign_key_check').length, 0);
  console.log('Passed: changed EMI narrations, exact account/amount/category/lender guards, ambiguous candidates and competing loans, account/user isolation, exact-link compatibility, import undo/reimport, early payments, correct statement coverage, and read-only matching.');
}
main().then(() => db.close()).catch((err) => { console.error(err); db.close(); process.exitCode = 1; });
