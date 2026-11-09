// Reasoning payloads and grounded analyst summaries with no private data or live services.
const assert = require('node:assert/strict');
const Database = require('better-sqlite3-multiple-ciphers');
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports }; };
stub('../src/config', { llm: { url: 'http://127.0.0.1:1', model: 'synthetic', timeoutMs: 1000 } });
stub('../src/core/logger', { info() {}, warn() {}, error() {} });
const { SYSTEM_PROMPT, SUMMARY_OPTIONS, toFacts } = require('../src/plugins/insights/summary.helper');
const fixture = {
  from: '2026-09-01', to: '2026-11-09', totals: { earned: 2000, spent: 980, invested: 100, net: 920, unsortedCount: 3 },
  months: [
    { month: '2026-09', label: 'September 2026', earned: 1000, spent: 400, invested: 0, net: 600, balance: null },
    { month: '2026-10', label: 'October 2026', earned: 1000, spent: 500, invested: 100, net: 400, balance: null },
    { month: '2026-11', label: 'November 2026', earned: 0, spent: 80, invested: 0, net: -80, balance: null },
  ],
  balance: null, highlights: [{ id: 'biggest', title: 'PRIVATE DESCRIPTION', value: '₹500', detail: 'PRIVATE NOTES' }],
  topCategories: [{ label: 'Food', amount: 980, share: 100 }], biggest: [{ description: 'PRIVATE DESCRIPTION' }],
};
const facts = toFacts(fixture);
assert.equal(facts.totals.leftOverBeforeInvesting, '₹1,020');
assert.equal(facts.totals.leftOverShareOfRecordedIncome, '46%');
assert.equal(facts.dataQuality.endsMidMonth, true);
assert.equal(facts.dataQuality.uncategorizedTransactions, 3);
assert.deepEqual(facts.latestFullMonthComparison, { from: 'September 2026', to: 'October 2026', spendingChange: '₹100', spendingChangePercent: '25%', recordedIncomeChange: '₹0', afterInvestingChange: '-₹200' });
assert.equal(facts.months[2].fullCalendarMonthInRange, false);
assert.equal(JSON.stringify(facts).includes('PRIVATE'), false);
const noIncome = toFacts({ ...fixture, totals: { ...fixture.totals, earned: 0 } });
assert.equal(noIncome.totals.leftOverShareOfRecordedIncome, null);
assert.equal(noIncome.dataQuality.hasRecordedIncome, false);
assert.equal(toFacts({ ...fixture, from: '2024-02-01', to: '2024-02-29', months: [] }).dataQuality.endsMidMonth, false);
const zero = toFacts({ ...fixture, from: '2026-09-01', to: '2026-10-31', months: fixture.months.slice(0, 2).map((m) => ({ ...m, spent: 0 })) });
assert.equal(zero.latestFullMonthComparison.spendingChangePercent, null);
assert.match(SYSTEM_PROMPT, /senior financial analyst/);

const fetchOriginal = global.fetch;
const realClient = require('../src/plugins/insights/llm.client');
const db = new Database(':memory:');
async function main() {
  let requestBody;
  let responseBody = { choices: [{ message: { content: '<think>Hidden work</think>Final answer', reasoning_content: 'Separate private work' }, finish_reason: 'stop' }], model: 'synthetic' };
  global.fetch = async (url, options) => { requestBody = JSON.parse(options.body); assert.equal(url, 'http://127.0.0.1:1/v1/chat/completions'); return { ok: true, json: async () => responseBody }; };
  const result = await realClient.chat([{ role: 'user', content: 'Synthetic test' }], SUMMARY_OPTIONS);
  assert.equal(requestBody.reasoning_effort, 'medium');
  assert.equal(requestBody.max_tokens, 3148);
  assert.deepEqual(result, { text: 'Final answer', model: 'synthetic', provider: 'local' }); // no userId → always the local model
  await realClient.chat([], { json: true, maxTokens: 100 });
  assert.equal(requestBody.reasoning_effort, 'medium');
  assert.deepEqual(requestBody.response_format, { type: 'json_object' });
  await realClient.chat([], { maxTokens: 100, reasoning: 'none' });
  assert.equal(requestBody.max_tokens, 100);
  assert.equal(requestBody.reasoning_effort, 'none');
  responseBody = { choices: [{ finish_reason: 'length', message: { content: 'Unfinished answer' } }] };
  await assert.rejects(() => realClient.chat([]), (err) => err.code === 'LLM_TRUNCATED');
  responseBody = { choices: [{ message: { content: '<think>Unclosed hidden work' } }] };
  await assert.rejects(() => realClient.chat([]), (err) => err.code === 'LLM_BAD_RESPONSE');
  global.fetch = fetchOriginal;

  stub('../src/config/db', { getDb: () => db });
  for (const m of require('../src/config/migrations')) typeof m === 'function' ? m(db) : db.exec(m);
  db.pragma('foreign_keys = ON');
  const { insertUser } = require('../src/plugins/users/user.model');
  const { insertTransaction } = require('../src/plugins/transactions/transaction.model');
  const { seedDefaults } = require('../src/plugins/users/defaults');
  const user = insertUser(db, { name: 'Summary synthetic', email: 'summary@example.invalid', passwordHash: 'unused' });
  const other = insertUser(db, { name: 'Summary other', email: 'summary-other@example.invalid', passwordHash: 'unused' });
  seedDefaults(db, user);
  const category = db.prepare('SELECT id FROM active_categories WHERE user_id = ? AND type = ? LIMIT 1').pluck().get(user, 'expense');
  insertTransaction(db, user, { date: '2026-10-01', description: 'PRIVATE DESCRIPTION', notes: 'PRIVATE NOTES', category, amount: 50 });
  let calls = 0;
  stub('../src/plugins/insights/llm.client', {
    engineKey: () => 'local:synthetic',
    chat: async (messages, { userId, ...options }) => {
      calls++;
      assert.equal(userId, user); // the person's AI setting picks the engine
      assert.deepEqual(options, SUMMARY_OPTIONS);
      assert.equal(messages[0].content, SYSTEM_PROMPT);
      assert.equal(messages[1].content.includes('PRIVATE'), false);
      return { text: calls === 1 ? 'You spent ₹987654321.' : 'Your recorded spending needs a review. Confirm income coverage before deciding whether to reduce discretionary spending.', model: 'synthetic' };
    },
  });
  const service = require('../src/plugins/insights/insights.service');
  const written = await service.writeSummary(user, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(written.attempts, 2); assert.equal(written.check.ok, true);
  assert.deepEqual(await service.writeSummary(user, { from: '2026-10-01', to: '2026-10-31' }), written);
  assert.equal(calls, 2, 'checked summaries are cached by policy, user and facts');
  assert.equal((await service.writeSummary(other, {})).reason, 'NO_DATA');
  assert.equal(calls, 2, 'empty histories never ask the model');
  console.log('Passed: analyst facts, partial/leap months, zero-income/zero-baseline handling, aggregate privacy, enabled reasoning with token allowance, hidden/truncated reasoning, numeric rewrite and checked caching.');
}
main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => { global.fetch = fetchOriginal; db.close(); });
