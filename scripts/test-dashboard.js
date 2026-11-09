// Dashboard settings and chart filters against synthetic in-memory data only.
const assert = require('node:assert/strict');
const Database = require('better-sqlite3-multiple-ciphers');
const db = new Database(':memory:');
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports }; };
stub('../src/config/db', { getDb: () => db });
stub('../src/core/logger', { info() {}, warn() {} });
stub('../src/plugins/insights/llm.client', {});
stub('../src/plugins/insights/suggestions.worker', { resetForUser() {} });
for (const m of require('../src/config/migrations')) typeof m === 'function' ? m(db) : db.exec(m);
db.pragma('foreign_keys = ON');
const { insertUser } = require('../src/plugins/users/user.model');
const { seedDefaults } = require('../src/plugins/users/defaults');
const { insertTransaction } = require('../src/plugins/transactions/transaction.model');
const service = require('../src/plugins/users/user.service');
const insights = require('../src/plugins/insights/insights.service');
const { getSummary } = require('../src/plugins/transactions/transaction.service');
const { updateProfile: schema } = require('../src/plugins/users/user.validation');
const account = (label) => {
  const id = insertUser(db, { email: `${label}@example.invalid`, name: label, passwordHash: 'unused' });
  seedDefaults(db, id); return id;
};
const a = account('dashboard-a'); const b = account('dashboard-b');
const category = (name) => db.prepare('SELECT id FROM active_categories WHERE user_id = ? AND name = ?').pluck().get(a, name);
const row = (account, categoryName, amount, type, date = '2026-10-20') => insertTransaction(db, a, { account, category: category(categoryName), amount, type, date, description: 'Synthetic chart row', balance: account === 'sbi' ? 4000 : 9000 });
row('sbi', 'Food & Drinks', 100, 'debit');
row('sbi', 'Food & Drinks', 20, 'credit');
row('sbi', 'Salary', 1000, 'credit');
row('kotak', 'Food & Drinks', 300, 'debit');
row('kotak', 'Salary', 2000, 'credit');
row('sbi', 'Mutual Funds', 50, 'debit');
row('sbi', 'Food & Drinks', 500, 'debit', '2026-09-20');
insertTransaction(db, b, { account: 'sbi', date: '2026-10-20', description: 'Other account', amount: 100000, type: 'debit' });
const config = { version: 1, widgets: [
  { id: 'cashflow', enabled: true, width: 'full', period: '6m', account: 'sbi', metric: 'expense' },
  { id: 'breakdown', enabled: false, width: 'half', period: 'latest', account: 'all', metric: 'income' },
] };

async function main() {
  assert.equal((await service.getProfile(a)).dashboardConfig, null);
  assert.equal(schema.safeParse({ body: { dashboardConfig: config } }).success, true);
  for (const bad of [
    { ...config, widgets: [config.widgets[0], config.widgets[0]] },
    { ...config, widgets: config.widgets.map((w) => ({ ...w, enabled: false })) },
    { ...config, widgets: [{ ...config.widgets[0], id: 'not-a-widget' }] },
    { ...config, widgets: [{ ...config.widgets[0], account: "sbi' OR 1=1" }] },
  ]) assert.equal(schema.safeParse({ body: { dashboardConfig: bad } }).success, false);
  await service.updateProfile(a, { dashboardConfig: config });
  assert.deepEqual((await service.getProfile(a)).dashboardConfig, config);
  assert.equal((await service.getProfile(b)).dashboardConfig, null);
  const range = { from: '2026-10-01', to: '2026-10-31', account: 'sbi' };
  const history = await insights.getHistory(a, range);
  assert.equal(history.totals.spent, 80, 'refunds reduce spending');
  assert.equal(history.totals.earned, 1000);
  assert.equal(history.totals.invested, 50);
  assert.ok(history.biggest.every((r) => r.account === 'sbi'));
  assert.equal(history.topCategories.reduce((sum, c) => sum + c.amount, 0), 80);
  assert.equal((await insights.getHistory(a, { ...range, account: 'kotak' })).totals.spent, 300);
  assert.equal((await insights.getHistory(a, { ...range, account: undefined })).totals.earned, 3000);
  const summary = await getSummary(a, { ...range, groupBy: 'topCategory' });
  assert.equal(summary.groups.find((g) => g.label === 'Food & Drinks').debit, 100);
  assert.deepEqual((await insights.getBalances(a, { account: 'sbi' })).accounts.map((a) => a.account), ['sbi']);
  assert.deepEqual((await insights.getHistory(a, { account: 'missing' })).months, []);
  await service.resetFinancialData(a);
  assert.deepEqual((await service.getProfile(a)).dashboardConfig, config, 'preferences survive financial resets');
  assert.equal(db.pragma('foreign_key_check').length, 0);
  console.log('Passed: dashboard validation, persistence, account isolation, financial reset preservation, chart period/account filters, refunds and balances.');
}
main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => db.close());
