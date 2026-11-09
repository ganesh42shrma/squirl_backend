// Synthetic overlap regression: never opens statements, a real database or services.
const assert = require('node:assert/strict');
const Database = require('better-sqlite3-multiple-ciphers');
const db = new Database(':memory:');
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports }; };
stub('../src/config/db', { getDb: () => db });
stub('../src/core/logger', { info() {}, warn() {}, error() {} });
stub('../src/plugins/insights/suggestions.worker', { nudge() {} });
let statement; let calls = 0;
stub('../src/plugins/imports/import.client', { parseStatement: async () => { calls++; return statement; } });
for (const m of require('../src/config/migrations')) typeof m === 'function' ? m(db) : db.exec(m);
db.pragma('foreign_keys = ON');
const { insertUser } = require('../src/plugins/users/user.model');
const { seedDefaults } = require('../src/plugins/users/defaults');
const service = require('../src/plugins/imports/import.service');
const makeUser = (name) => {
  const id = insertUser(db, { name, email: `${name}@example.invalid`, passwordHash: 'unused' });
  seedDefaults(db, id); return id;
};
const user = makeUser('overlap'); const other = makeUser('other');
const file = { originalname: 'AccountStatement_01-Aug-2026_31-Oct-2026.pdf', buffer: Buffer.from('synthetic') };
const upload = (transactions, options = {}) => {
  statement = { bank: 'kotak', periodFrom: '2026-08-01', periodTo: '2026-10-31', transactions, ...options };
  return service.createImport(user, { bank: 'auto', file });
};
const row = (date, n) => ({ date, description: `Synthetic merchant ${n}`, refNo: `TEST${n}`, debit: 10, balance: 50000 - n * 10 });
const old = Array.from({ length: 229 }, (_, i) => row(new Date(Date.UTC(2026, 7, 1 + Math.floor(i * 91 / 229))).toISOString().slice(0, 10), i));
const count = () => db.prepare('SELECT count(*) FROM active_transactions WHERE user_id = ?').pluck().get(user);
async function main() {
  const first = await upload(old);
  assert.equal(first.stats.inserted, 229);
  assert.equal(first.newFrom.slice(0, 10), '2026-08-01');
  assert.equal(first.newTo.slice(0, 10), '2026-10-30');
  const repeated = await upload(old);
  assert.equal(repeated.stats.parsed, 229);
  assert.equal(repeated.stats.duplicates, 229);
  assert.equal(repeated.stats.inserted, 0);
  assert.equal(repeated.newFrom, undefined);

  // All three must be inserted: an older gap, same latest date, and newer activity.
  const fresh = [row('2026-08-15', 1000), row('2026-10-30', 1001), row('2026-11-09', 1002)];
  const overlap = await upload([...old, ...fresh], { periodTo: '2026-11-09' });
  assert.equal(overlap.stats.parsed, 232);
  assert.equal(overlap.stats.inserted, 3);
  assert.equal(overlap.stats.duplicates, 229);
  assert.equal(overlap.newFrom.slice(0, 10), '2026-08-15');
  assert.equal(overlap.newTo.slice(0, 10), '2026-11-09');
  assert.equal(count(), 232);
  assert.equal(calls, 3, 'same filename is parsed again on every upload');
  const narrower = await upload([old.at(-1), fresh[1], fresh[2]], { periodFrom: '2026-10-30', periodTo: '2026-11-09' });
  assert.equal(narrower.stats.duplicates, 3);
  assert.equal(narrower.stats.inserted, 0);

  // Repeats within one file, invalid rows, distinct same-day payments and user isolation.
  const one = row('2026-10-31', 2000);
  const distinct = { ...one, refNo: 'TEST2001', balance: one.balance - 10 };
  const mixed = await upload([one, one, distinct, { ...one, date: 'invalid' }, { ...one, debit: 0 }]);
  assert.deepEqual(mixed.stats, { parsed: 5, inserted: 2, duplicates: 1, skipped: 2, autoCategorized: 0 });
  const isolated = await service.createImport(other, { bank: 'auto', file });
  assert.equal(isolated.stats.inserted, 2);
  assert.equal(count(), 234);
  const removed = await service.deleteImport(user, first._id);
  assert.equal(removed.transactionsDeleted, 229);
  assert.equal((await upload(old)).stats.inserted, 229, 'soft-deleted rows can be reimported');
  assert.equal(db.pragma('foreign_key_check').length, 0);
  console.log('Passed: 229-row overlaps, older gaps, same-day/newer activity, exact reuploads, filename reuse, narrow ranges, invalid rows, tenant isolation and soft-delete reimport.');
}
main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => db.close());
