const { getDb } = require('../../config/db');
const AppError = require('../../core/AppError');
const { nowIso, updateRow, fromPaise } = require('../../core/sql');
const { counterparty, isUsableKey } = require('../rules/rules.helper');
const { toColumns, toCommitment, insertCommitment } = require('./commitment.model');
const { PERIOD_MONTHS, nthDue, duesThrough, loanPosition, amortize, emiFor, daysBetween, dueIn } = require('./finance');

const PAY_WINDOW_BEFORE = 10; // a payment up to 10 days before a due date counts for it
const PAY_WINDOW_AFTER = 7; //   …and up to 7 days after
const MISSED_LOOKBACK = 35; //   only the most recent due date (within ~a month) can be "missed"

// Local calendar date: due dates are about the person's day, not UTC's.
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const addDays = (key, n) => new Date(Date.parse(key) + n * 86_400_000).toISOString().slice(0, 10);
const rupees = fromPaise;

function rowsFor(userId) {
  return getDb().prepare('SELECT * FROM active_commitments WHERE user_id = ? ORDER BY active DESC, name').all(userId);
}

function findRow(userId, id) {
  const row = getDb().prepare('SELECT * FROM active_commitments WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) throw AppError.notFound('Not found');
  return row;
}

/** Debits from statements, grouped by counterparty key, for matching payments to due dates. */
function paymentsByKey(userId, keys) {
  if (!keys.size) return new Map();
  const since = addDays(todayKey(), -460);
  const rows = getDb()
    .prepare("SELECT id, date, description, amount_paise FROM active_transactions WHERE user_id = ? AND type = 'debit' AND date >= ? ORDER BY date")
    .all(userId, since);
  const out = new Map([...keys].map((k) => [k, []]));
  for (const row of rows) {
    const key = counterparty(row.description).key;
    if (out.has(key)) out.get(key).push({ id: row.id, date: row.date, amount: row.amount_paise });
  }
  return out;
}

// Latest statement date per account (and overall): before it, a missing payment is a real miss;
// after it, the statement that would show the payment simply hasn't been imported yet.
function statementCoverage(userId) {
  const db = getDb();
  const byAccount = new Map(
    db.prepare("SELECT account, max(date) AS last FROM active_transactions WHERE user_id = ? AND source = 'import' GROUP BY account").all(userId).map((r) => [r.account, r.last]),
  );
  const overall = [...byAccount.values()].sort().pop() || null;
  return { byAccount, overall };
}

const paymentFor = (due, payments, amount) =>
  payments.find(
    (p) =>
      p.date >= addDays(due, -PAY_WINDOW_BEFORE) &&
      p.date <= addDays(due, PAY_WINDOW_AFTER) &&
      (!amount || Math.abs(p.amount - amount) <= amount * 0.2),
  ) || null;

/** Everything the UI shows for one commitment, computed from its fields, today and the statements. */
function toView(row, { today, payments, coverage }) {
  const base = toCommitment(row);
  const c = {
    amountPaise: row.amount_paise,
    principalPaise: row.principal_paise,
    interestRate: row.interest_rate,
    tenureMonths: row.tenure_months,
    paidPrincipalPaise: row.paid_principal_paise,
    outstandingPaise: row.outstanding_paise,
    balanceAsOf: row.balance_as_of,
    startDate: row.start_date,
    dueDay: row.due_day,
  };

  const loan = row.kind === 'loan' ? loanPosition(c, today) : null;
  const amount = row.amount_paise || loan?.emi || null;

  // End: given, or for a loan when its schedule finishes, or after `tenure` payments.
  let endDate = row.end_date || null;
  if (!endDate && loan?.lastDue) endDate = loan.lastDue;
  if (!endDate && row.tenure_months) endDate = nthDue(row.start_date, row.due_day, row.frequency, Math.ceil(row.tenure_months / PERIOD_MONTHS[row.frequency]) - 1);

  const paidCount = duesThrough(row.start_date, row.due_day, row.frequency, today, 2000);
  const lastDue = paidCount ? nthDue(row.start_date, row.due_day, row.frequency, paidCount - 1) : null;
  let nextDue = nthDue(row.start_date, row.due_day, row.frequency, paidCount);
  const ended = Boolean(endDate && (lastDue ? lastDue >= endDate : false) && nextDue > endDate);
  if (ended || (endDate && nextDue > endDate)) nextDue = null;

  const linked = Boolean(row.match_key);
  const list = linked ? payments.get(row.match_key) || [] : [];
  const covered = (row.account && coverage.byAccount.get(row.account)) || coverage.overall;

  // The most recent due date: paid, missed, or not yet visible in an imported statement.
  let last = null;
  if (lastDue && daysBetween(lastDue, today) <= MISSED_LOOKBACK && (!endDate || lastDue <= endDate)) {
    const payment = linked ? paymentFor(lastDue, list, amount) : null;
    last = {
      date: lastDue,
      state: !linked ? 'unknown' : payment ? 'paid' : covered && covered >= addDays(lastDue, PAY_WINDOW_AFTER) ? 'missed' : 'awaiting',
      payment: payment ? { _id: payment.id, date: payment.date, amount: rupees(payment.amount) } : undefined,
    };
  }

  let next = null;
  if (nextDue && row.active) {
    const early = linked ? paymentFor(nextDue, list, amount) : null; // already paid ahead of the due date?
    next = { date: nextDue, daysUntil: daysBetween(today, nextDue), paid: Boolean(early) };
  }

  const status = !row.active
    ? 'paused'
    : !nextDue && !last
      ? 'ended'
      : last?.state === 'missed'
        ? 'missed'
        : next && !next.paid && next.daysUntil <= row.remind_days
          ? 'due_soon'
          : 'upcoming';

  return {
    ...base,
    amount: rupees(amount),
    endDate: endDate || undefined,
    status,
    next,
    last,
    linked,
    recentPayments: list.slice(-3).reverse().map((p) => ({ _id: p.id, date: p.date, amount: rupees(p.amount) })),
    ...(loan && {
      loan: {
        source: loan.source, // 'yours' (from the lender's figures you entered) or 'estimated' (from the start date)
        emi: rupees(loan.emi),
        expectedEmi: rupees(loan.expectedEmi),
        emiMismatch: loan.emiMismatch,
        outstanding: rupees(loan.outstanding),
        paidPrincipal: rupees(loan.paidPrincipal),
        progress: loan.progress,
        emisLeft: loan.emisLeft,
        interestLeft: rupees(loan.interestLeft),
        neverEnds: loan.neverEnds || undefined,
      },
    }),
  };
}

function context(userId, rows) {
  const keys = new Set(rows.map((r) => r.match_key).filter(Boolean));
  return { today: todayKey(), payments: paymentsByKey(userId, keys), coverage: statementCoverage(userId) };
}

// A commitment's monthly share, so quarterly and yearly charges add up sensibly.
const monthlyShare = (view) => (view.amount ? view.amount / PERIOD_MONTHS[view.frequency] : 0);

async function listCommitments(userId) {
  const rows = rowsFor(userId);
  const ctx = context(userId, rows);
  const items = rows.map((r) => toView(r, ctx));
  const active = items.filter((i) => i.active && i.status !== 'ended');
  return {
    items,
    totals: {
      monthly: Math.round(active.reduce((sum, i) => sum + monthlyShare(i), 0) * 100) / 100,
      loansOutstanding: Math.round(active.filter((i) => i.loan?.outstanding != null).reduce((sum, i) => sum + i.loan.outstanding, 0) * 100) / 100,
      count: active.length,
    },
    statementsThrough: ctx.coverage.overall,
    today: ctx.today,
  };
}

async function getCommitment(userId, id) {
  const row = findRow(userId, id);
  return toView(row, context(userId, [row]));
}

/** Due soon (within each one's reminder window, not yet paid) and recently missed. */
async function listAlerts(userId) {
  const { items } = await listCommitments(userId);
  const alerts = [];
  for (const i of items) {
    if (!i.active) continue;
    if (i.next && !i.next.paid && i.next.daysUntil <= i.remindDays) {
      alerts.push({ key: `${i._id}:${i.next.date}:due`, id: i._id, name: i.name, kind: i.kind, amount: i.amount, date: i.next.date, daysUntil: i.next.daysUntil, type: 'due_soon' });
    }
    if (i.last?.state === 'missed') {
      alerts.push({ key: `${i._id}:${i.last.date}:missed`, id: i._id, name: i.name, kind: i.kind, amount: i.amount, date: i.last.date, type: 'missed' });
    }
  }
  return { alerts: alerts.sort((a, b) => a.date.localeCompare(b.date)) };
}

// A category must belong to this account (another account's id is "not found").
function assertCategory(userId, categoryId) {
  if (categoryId && !getDb().prepare('SELECT 1 FROM active_categories WHERE id = ? AND user_id = ?').get(categoryId, userId)) {
    throw AppError.badRequest('Category not found', 'INVALID_CATEGORY');
  }
}

function validateLoan(data) {
  if (data.kind === 'loan' && !data.amount && !(data.principal && data.tenureMonths)) {
    throw AppError.badRequest('A loan needs its EMI, or the loan amount and tenure to work it out', 'LOAN_INCOMPLETE');
  }
}

async function createCommitment(userId, data) {
  validateLoan(data);
  assertCategory(userId, data.category);
  const db = getDb();
  const id = insertCommitment(db, userId, data);
  return getCommitment(userId, id);
}

async function updateCommitment(userId, id, data) {
  const row = findRow(userId, id);
  validateLoan({ kind: data.kind || row.kind, amount: data.amount ?? rupees(row.amount_paise), principal: data.principal ?? rupees(row.principal_paise), tenureMonths: data.tenureMonths ?? row.tenure_months });
  assertCategory(userId, data.category);
  updateRow(getDb(), 'commitments', id, { ...toColumns(data), updated_at: nowIso() });
  return getCommitment(userId, id);
}

async function deleteCommitment(userId, id) {
  findRow(userId, id);
  const now = nowIso();
  getDb().prepare('UPDATE commitments SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL').run(now, now, id, userId);
  return { deleted: true };
}

/** The loan's remaining EMIs, month by month, from where it stands today. */
async function getSchedule(userId, id) {
  const row = findRow(userId, id);
  if (row.kind !== 'loan') throw AppError.badRequest('Only loans have a repayment schedule', 'NOT_A_LOAN');
  const today = todayKey();
  const view = toView(row, context(userId, [row]));
  if (!view.loan || view.loan.outstanding == null) return { rows: [], loan: view.loan };
  const emi = row.amount_paise || emiFor(row.principal_paise, row.interest_rate || 0, row.tenure_months);
  const done = duesThrough(row.start_date, row.due_day, 'monthly', today);
  const rows = amortize(Math.round(view.loan.outstanding * 100), row.interest_rate || 0, emi).map((r, i) => ({
    n: done + i + 1,
    date: nthDue(row.start_date, row.due_day, 'monthly', done + i),
    payment: rupees(r.payment),
    interest: rupees(r.interest),
    principal: rupees(r.principal),
    outstanding: rupees(r.outstanding),
  }));
  return { rows, loan: view.loan };
}

/**
 * Debits that look like a monthly commitment: the same counterparty in at least 3 different
 * months, in most months between the first and last, at a steady amount (70% within ±10% of the
 * median). Merchants already linked to a commitment are left out. Pure arithmetic, no model.
 */
async function detectRecurring(userId) {
  const db = getDb();
  const since = addDays(todayKey(), -460);
  const linked = new Set(db.prepare('SELECT match_key FROM active_commitments WHERE user_id = ? AND match_key IS NOT NULL').pluck().all(userId));
  const groups = new Map();
  for (const row of db
    .prepare("SELECT date, description, amount_paise, account FROM active_transactions WHERE user_id = ? AND type = 'debit' AND source = 'import' AND date >= ? ORDER BY date")
    .all(userId, since)) {
    const party = counterparty(row.description);
    // Moving money to your own account isn't a bill.
    if (!isUsableKey(party.key) || linked.has(party.key) || /\bSELF\b/.test(party.key)) continue;
    if (!groups.has(party.key)) groups.set(party.key, { key: party.key, name: party.name, example: row.description, rows: [] });
    groups.get(party.key).rows.push(row);
  }

  const median = (values) => {
    const s = [...values].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
  };
  const found = [];
  for (const g of groups.values()) {
    const months = new Set(g.rows.map((r) => r.date.slice(0, 7)));
    if (months.size < 3) continue;
    const [fy, fm] = g.rows[0].date.split('-').map(Number);
    const [ly, lm] = g.rows.at(-1).date.split('-').map(Number);
    const span = (ly - fy) * 12 + (lm - fm) + 1;
    if (months.size / span < 0.6) continue;
    // One payment per month: the largest, so a stray small charge doesn't skew it.
    const perMonth = [...months].map((m) => g.rows.filter((r) => r.date.startsWith(m)).sort((a, b) => b.amount_paise - a.amount_paise)[0]);
    const amount = median(perMonth.map((r) => r.amount_paise));
    const steady = perMonth.filter((r) => Math.abs(r.amount_paise - amount) <= amount * 0.1).length / perMonth.length;
    if (steady < 0.7) continue;
    const dueDay = median(perMonth.map((r) => Number(r.date.slice(8, 10))));
    const kind = /\b(NACH|ACH|ACHDR|EMI|LOAN|LOANEMID|FINANCE|BAJAJ)\b|EMI/.test(g.key) ? 'loan' : amount <= 300000 ? 'subscription' : 'auto_debit';
    found.push({
      matchKey: g.key,
      name: g.name,
      example: g.example,
      amount: rupees(amount),
      dueDay,
      months: months.size,
      kind,
      lastPaid: g.rows.at(-1).date,
      account: g.rows.at(-1).account,
      startDate: dueIn(fy, fm - 1, Math.min(dueDay, 28)),
    });
  }
  return { items: found.sort((a, b) => b.amount - a.amount).slice(0, 20) };
}

/** Debit counterparties matching a search, to link a commitment to its statement payments. */
async function searchMerchants(userId, search = '') {
  const needle = search.trim().toLowerCase();
  const groups = new Map();
  for (const row of getDb()
    .prepare("SELECT date, description, amount_paise FROM active_transactions WHERE user_id = ? AND type = 'debit' AND source = 'import' ORDER BY date DESC LIMIT 5000")
    .all(userId)) {
    if (needle && !row.description.toLowerCase().includes(needle)) continue;
    const party = counterparty(row.description);
    if (!isUsableKey(party.key)) continue;
    const g = groups.get(party.key) || { matchKey: party.key, name: party.name, example: row.description, count: 0, lastDate: row.date, lastAmount: rupees(row.amount_paise) };
    g.count += 1;
    groups.set(party.key, g);
  }
  return { items: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 20) };
}

module.exports = {
  listCommitments,
  getCommitment,
  listAlerts,
  createCommitment,
  updateCommitment,
  deleteCommitment,
  getSchedule,
  detectRecurring,
  searchMerchants,
  todayKey,
};
