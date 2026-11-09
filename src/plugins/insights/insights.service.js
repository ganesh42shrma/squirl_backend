const { createHash } = require('crypto');
const { getDb } = require('../../config/db');
const { fromPaise } = require('../../core/sql');
const { buildFilter, buildSummaryQuery } = require('../transactions/transaction.helper');
const llm = require('./llm.client');
const { checkNumbers } = require('./numbers');
const { SYSTEM_PROMPT, SUMMARY_OPTIONS, toFacts } = require('./summary.helper');
const {
  rupees,
  monthLabel,
  daysBetween,
  monthKeysBetween,
  walkAccount,
  combineAccounts,
  balanceOn,
  toFigures,
  buildHighlights,
} = require('./insights.helper');

const lastDayOfMonth = (key) => {
  const [y, m] = key.split('-').map(Number);
  return `${key}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const inRange = (date, from, to) => (!from || date >= from) && (!to || date <= to);
const toPoint = (p) => ({ date: p.date, balance: fromPaise(p.paise) });

// toFigures() on paise groups, then converted: exact sums, no 0.1 + 0.2 drift.
function figuresInRupees(groups) {
  const f = toFigures(groups);
  return { earned: rupees(f.earned), spent: rupees(f.spent), invested: rupees(f.invested), net: rupees(f.net), unsortedCount: f.unsortedCount };
}

/**
 * Every account's balance history, read from the running balance printed on imported rows.
 * The whole history is always walked (gaps need the full chain); from/to only trim the points.
 */
function loadAccounts(userId, account = null) {
  const rows = getDb()
    .prepare(
      `SELECT account, date, type, amount_paise, balance_paise FROM active_transactions
       WHERE user_id = ? AND balance_paise IS NOT NULL AND (? IS NULL OR account = ?) ORDER BY account, date, rowid`,
    )
    .all(userId, account, account);
  const byAccount = new Map();
  for (const row of rows) {
    if (!byAccount.has(row.account)) byAccount.set(row.account, []);
    byAccount.get(row.account).push(row);
  }
  return [...byAccount].map(([account, accountRows]) => ({ account, ...walkAccount(accountRows) }));
}

async function getBalances(userId, { from, to, account }) {
  const accounts = loadAccounts(userId, account);
  const combined = combineAccounts(accounts);
  const latest = combined.points[combined.points.length - 1];

  // Change over the 30 days before the latest known balance.
  let change30 = null;
  if (latest) {
    const before = balanceOn(combined.points, new Date(Date.parse(latest.date) - 30 * 86400000).toISOString().slice(0, 10));
    if (before) change30 = fromPaise(latest.paise - before.paise);
  }

  return {
    total: latest
      ? { balance: fromPaise(latest.paise), asOf: latest.date, since: combined.since, change30 }
      : null,
    accounts: accounts.map((a) => {
      const last = a.points[a.points.length - 1];
      return {
        account: a.account,
        balance: fromPaise(last.paise),
        asOf: last.date,
        firstDate: a.points[0].date,
        gaps: a.gaps.map((g) => ({ ...g, days: daysBetween(g.from, g.to) })),
        points: a.points.filter((p) => inRange(p.date, from, to)).map(toPoint),
      };
    }),
    combined: combined.points.filter((p) => inRange(p.date, from, to)).map(toPoint),
  };
}

function dataRange(userId, account = null) {
  return getDb().prepare('SELECT min(date) AS first, max(date) AS last FROM active_transactions WHERE user_id = ? AND (? IS NULL OR account = ?)').get(userId, account, account);
}

async function getHistory(userId, query) {
  const db = getDb();
  const range = dataRange(userId, query.account);
  if (!range.first) return { from: null, to: null, months: [], totals: null, topCategories: [], biggest: [], highlights: [] };
  const from = query.from || range.first;
  const to = query.to || range.last;
  const filter = buildFilter(userId, { ...query, from, to });

  // Debit/credit per month and category type → the figures people think in.
  const rows = db
    .prepare(
      `SELECT substr(t.date, 1, 7) AS month, ifnull(c.type, 'uncategorized') AS key,
              ifnull(sum(CASE WHEN t.type = 'debit' THEN t.amount_paise END), 0) AS debit,
              ifnull(sum(CASE WHEN t.type = 'credit' THEN t.amount_paise END), 0) AS credit,
              count(*) AS count
       FROM active_transactions t LEFT JOIN active_categories c ON c.id = t.category_id AND c.user_id = t.user_id
       ${filter.where} GROUP BY 1, 2`,
    )
    .all(...filter.params); // amounts stay in paise until the end, so sums are exact

  const combined = combineAccounts(loadAccounts(userId, query.account));
  const months = monthKeysBetween(from.slice(0, 7), to.slice(0, 7)).map((month) => {
    const figures = figuresInRupees(rows.filter((r) => r.month === month));
    const end = balanceOn(combined.points, lastDayOfMonth(month));
    return {
      month,
      label: monthLabel(month),
      ...figures,
      // Month-end combined balance, once every account has data.
      balance: end && combined.since && month >= combined.since.slice(0, 7) ? fromPaise(end.paise) : null,
    };
  });

  const byType = new Map();
  for (const r of rows) {
    const g = byType.get(r.key) || { key: r.key, debit: 0, credit: 0, count: 0 };
    byType.set(r.key, { ...g, debit: g.debit + r.debit, credit: g.credit + r.credit, count: g.count + r.count });
  }
  const totals = figuresInRupees([...byType.values()]);

  // Spending per top-level category (same rules as the month view's "Where it went").
  const { sql, params } = buildSummaryQuery('topCategory', filter);
  const spend = db
    .prepare(sql)
    .all(...params)
    .filter((g) => g.category_type === 'expense' || g.key === null)
    .map((g) => ({
      key: g.key,
      label: g.key === null ? 'Not sorted yet' : g.label,
      amount: rupees(g.key === null ? g.debit_paise : g.debit_paise - g.credit_paise),
      count: g.count,
    }))
    .filter((g) => g.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const spendTotal = spend.reduce((sum, g) => sum + g.amount, 0);
  const topCategories = spend.slice(0, 8).map((g) => ({ ...g, share: Math.round((g.amount / spendTotal) * 100) }));

  // Largest single rows, ignoring moves between your own accounts.
  const biggestOf = (type, limit) =>
    db
      .prepare(
        `SELECT t.id, t.date, t.description, t.amount_paise, t.type, t.account, c.name AS category
         FROM active_transactions t LEFT JOIN active_categories c ON c.id = t.category_id AND c.user_id = t.user_id
         ${filter.where} AND t.type = ? AND (c.type IS NULL OR c.type <> 'transfer')
         ORDER BY t.amount_paise DESC LIMIT ?`,
      )
      .all(...filter.params, type, limit)
      .map((r) => ({ _id: r.id, date: r.date, description: r.description, amount: rupees(r.amount_paise), type: r.type, account: r.account, category: r.category ?? null }));
  const biggest = [...biggestOf('debit', 5), ...biggestOf('credit', 3)];

  // Combined balance at the start and end of the range (only where every account has data).
  const inside = combined.points.filter((p) => p.date >= from && p.date <= to);
  const balance =
    inside.length > 1
      ? { start: rupees(inside[0].paise), startDate: inside[0].date, end: rupees(inside[inside.length - 1].paise), endDate: inside[inside.length - 1].date }
      : null;

  return {
    from,
    to,
    months,
    totals,
    topCategories,
    biggest,
    balance,
    highlights: buildHighlights({ months, totals, topCategories, biggest, balance }),
  };
}

// --- Written summary by the local model -----------------------------------------------------

const summaryCache = new Map(); // Policy and facts hash → checked summary.

async function writeSummary(userId, query) {
  const history = await getHistory(userId, query);
  if (!history.totals) return { text: null, reason: 'NO_DATA' };

  const facts = toFacts(history);
  const key = createHash('sha256').update(userId).update(SYSTEM_PROMPT).update(JSON.stringify(SUMMARY_OPTIONS)).update(JSON.stringify(facts)).digest('hex');
  if (summaryCache.has(key)) return summaryCache.get(key);

  // Write, then check every amount and % against the facts. One retry that names the bad numbers;
  // if the model still invents one, the summary is returned flagged so the UI can say so.
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Facts:\n${JSON.stringify(facts, null, 1)}` },
  ];
  let reply = await llm.chat(messages, SUMMARY_OPTIONS);
  let check = checkNumbers(reply.text, facts);
  let attempts = 1;
  if (!check.ok) {
    messages.push(
      { role: 'assistant', content: reply.text },
      {
        role: 'user',
        content: `These numbers are not in the facts: ${check.unverified.join(', ')}. Rewrite the summary using only amounts and percentages that appear in the facts, copied exactly. Preserve the useful interpretation and prioritized actions; do not replace them with a recital of totals.`,
      },
    );
    reply = await llm.chat(messages, SUMMARY_OPTIONS);
    check = checkNumbers(reply.text, facts);
    attempts = 2;
  }

  const result = {
    text: reply.text,
    model: reply.model,
    check, // { ok, unverified: [...] }
    attempts,
    from: history.from,
    to: history.to,
    generatedAt: new Date().toISOString(),
  };
  if (check.ok) {
    // Only verified summaries are cached; a flagged one gets a fresh try next time.
    if (summaryCache.size >= 20) summaryCache.delete(summaryCache.keys().next().value);
    summaryCache.set(key, result);
  }
  return result;
}

const getLlmStatus = () => llm.status();

module.exports = { getBalances, getHistory, writeSummary, getLlmStatus };
