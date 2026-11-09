// Server pagination on synthetic in-memory transactions with tied dates/amounts.
const assert = require('node:assert/strict');
const Database = require('better-sqlite3-multiple-ciphers');
const db = new Database(':memory:');
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports }; };
stub('../src/config/db', { getDb: () => db });
stub('../src/core/logger', { info() {}, warn() {}, error() {} });
for (const m of require('../src/config/migrations')) typeof m === 'function' ? m(db) : db.exec(m);
db.pragma('foreign_keys = ON');
const { insertUser } = require('../src/plugins/users/user.model');
const { insertTransaction } = require('../src/plugins/transactions/transaction.model');
const { seedDefaults } = require('../src/plugins/users/defaults');
const { newId, nowIso, insertRow } = require('../src/core/sql');
const { listTransactions } = require('../src/plugins/transactions/transaction.service');
const { listTransactions: schema } = require('../src/plugins/transactions/transaction.validation');
const user = insertUser(db, { name: 'Paged user', email: 'paging@example.invalid', passwordHash: 'unused' });
const other = insertUser(db, { name: 'Other user', email: 'other-paging@example.invalid', passwordHash: 'unused' });
seedDefaults(db, user);
const category = db.prepare('SELECT id FROM active_categories WHERE user_id = ? LIMIT 1').pluck().get(user);
const batch = newId(); const now = nowIso();
insertRow(db, 'imports', { id: batch, user_id: user, bank: 'kotak', file_name: 'synthetic.pdf', status: 'completed', created_at: now, updated_at: now });
const ids = [];
for (let i = 0; i < 235; i++) ids.push(insertTransaction(db, user, {
  date: `2026-11-${String(1 + i % 9).padStart(2, '0')}`, description: `Synthetic payment ${i}`,
  amount: 10 + i % 4, type: i % 2 ? 'credit' : 'debit', notes: i % 2 ? 'Shared lunch' : '',
  category: i % 2 ? category : null, tags: i % 2 ? ['lunch'] : [], autoCategorized: i % 2 === 0,
  source: 'import', importId: batch, account: 'kotak',
}));
insertTransaction(db, other, { date: '2026-11-09', description: 'Private other user', amount: 100 });
const archived = insertTransaction(db, user, { date: '2026-11-09', description: 'Archived synthetic', amount: 100 });
db.prepare('UPDATE transactions SET deleted_at = ? WHERE id = ?').run(now, archived);
const outside = insertTransaction(db, user, { date: '2026-10-31', description: 'Previous month', amount: 100 });
const query = (changes = {}) => schema.parse({ query: { from: '2026-11-01', to: '2026-11-30', ...changes } }).query;
const list = (changes) => listTransactions(user, query(changes));
async function main() {
  const first = await list();
  assert.equal(first.items.length, 30);
  assert.deepEqual(first.meta, { page: 1, limit: 30, total: 235, pages: 8 });
  for (const limit of [30, 50, 100, 200]) {
    for (const sort of ['-date', 'date', '-amount', 'amount']) {
      const all = [];
      for (let page = 1; page <= Math.ceil(235 / limit); page++) {
        const result = await list({ page: String(page), limit: String(limit), sort });
        assert.equal(result.meta.total, 235);
        assert.equal(result.items.length, Math.min(limit, 235 - (page - 1) * limit));
        all.push(...result.items.map((item) => item._id));
      }
      assert.equal(all.length, new Set(all).size, 'tied values cannot duplicate rows across pages');
      assert.deepEqual(new Set(all), new Set(ids), 'every active matching transaction is reachable');
    }
  }
  for (const filter of [{ search: 'shared lunch' }, { category }, { tag: 'lunch' }]) {
    const result = await list({ ...filter, page: 2, limit: 30 });
    assert.equal(result.meta.total, 117); assert.equal(result.items.length, 30);
  }
  assert.equal((await list({ category: 'none' })).meta.total, 118);
  assert.equal((await list({ auto: 'true' })).meta.total, 118);
  assert.equal((await list({ importId: batch })).meta.total, 235);
  const empty = await list({ search: 'does-not-exist' });
  assert.deepEqual(empty.meta, { page: 1, limit: 30, total: 0, pages: 0 });
  assert.deepEqual((await list({ page: 9 })).items, []);
  for (const bad of [{ page: 0 }, { page: 1.5 }, { limit: 0 }, { limit: 201 }, { limit: 'abc' }]) assert.equal(schema.safeParse({ query: bad }).success, false);
  assert.equal(query({ limit: 1 }).limit, 1, 'small dashboard/count queries stay supported');
  assert.equal(query({ limit: 6 }).limit, 6);
  assert.ok(!(await list()).items.some((row) => [outside, archived].includes(row._id)));
  console.log('Passed: server 30/50/100/200 paging, stable date/amount ties, complete traversal, filters/counts, month/import scope, tenant/archive isolation and validation.');
}
main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => db.close());
