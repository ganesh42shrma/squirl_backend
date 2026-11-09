const { getDb } = require('../../config/db');
const AppError = require('../../core/AppError');
const { insertRow, newId, nowIso, updateRow, fromPaise, toPaise } = require('../../core/sql');
const { counterparty } = require('../rules/rules.helper');
const { KINDS, SAVING_IN, toColumns, toGoal } = require('./goal.model');
const { planFor, track, addMonths, monthsBetween } = require('./goal.finance');

const rupees = fromPaise;

// Local calendar date: goals are about the person's day, not UTC's.
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function findRow(userId, id) {
  const row = getDb().prepare('SELECT * FROM active_goals WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) throw AppError.notFound('Goal not found');
  return row;
}

// --- Money saved ---------------------------------------------------------------------------

/**
 * Every rupee counted toward a goal, newest first. Four sources, each transaction counted once:
 *  - manual:      entries the person added (negative = taken out)
 *  - transaction: ledger rows the person linked (only while the row isn't archived)
 *  - auto_debit:  payments to the linked auto-debit's merchant since the start date
 *  - account:     money in (+) and out (−) of the watched account since the start date
 */
function contributionsFor(userId, row) {
  const db = getDb();
  const explicit = db
    .prepare(
      `SELECT gc.*, t.description AS t_description, t.type AS t_type, t.account AS t_account, t.deleted_at AS t_deleted
       FROM goal_contributions gc LEFT JOIN transactions t ON t.id = gc.transaction_id AND t.user_id = gc.user_id
       WHERE gc.goal_id = ? AND gc.user_id = ?`,
    )
    .all(row.id, userId);

  const items = [];
  const counted = new Set();
  const excluded = new Map(); // transaction id → exclusion row id
  for (const c of explicit) {
    if (c.source === 'excluded') {
      excluded.set(c.transaction_id, c.id);
    } else if (c.source === 'manual') {
      items.push({ _id: c.id, source: 'manual', amount: c.amount_paise, date: c.date, description: c.note || 'Added by you', removable: true });
    } else if (c.source === 'transaction' && c.t_description && !c.t_deleted) {
      counted.add(c.transaction_id);
      items.push({ _id: c.id, source: 'transaction', amount: c.amount_paise, date: c.date, description: c.note || c.t_description, transactionId: c.transaction_id, account: c.t_account, removable: true });
    }
  }

  const auto = (source, t, amount) => {
    if (counted.has(t.id) || excluded.has(t.id)) return;
    counted.add(t.id);
    items.push({ _id: `${source}:${t.id}`, source, amount, date: t.date, description: t.description, transactionId: t.id, account: t.account, removable: false, excludable: true });
  };

  if (row.commitment_id) {
    const key = db.prepare('SELECT match_key FROM active_commitments WHERE id = ? AND user_id = ?').pluck().get(row.commitment_id, userId);
    if (key) {
      const debits = db
        .prepare("SELECT id, date, description, account, amount_paise FROM active_transactions WHERE user_id = ? AND type = 'debit' AND date >= ? ORDER BY date")
        .all(userId, row.start_date);
      for (const t of debits) if (counterparty(t.description).key === key) auto('auto_debit', t, t.amount_paise);
    }
  }
  if (row.watch_account) {
    const rows = db
      .prepare('SELECT id, date, description, account, type, amount_paise FROM active_transactions WHERE user_id = ? AND account = ? AND date >= ? ORDER BY date')
      .all(userId, row.watch_account, row.start_date);
    for (const t of rows) auto('account', t, t.type === 'credit' ? t.amount_paise : -t.amount_paise);
  }

  items.sort((a, b) => b.date.localeCompare(a.date));
  const exclusions = [...excluded.entries()].map(([transactionId, id]) => ({ _id: id, transactionId }));
  return { items, exclusions, total: items.reduce((sum, i) => sum + i.amount, 0) };
}

/** Saved at each month-end from the start date to today, for the chart's "so far" line. */
function historyFor(row, items, today) {
  const months = Math.max(monthsBetween(row.start_date, today), 0);
  const points = [];
  const step = Math.max(1, Math.ceil(months / 36));
  for (let m = 0; m <= months; m += step) {
    const at = m === months ? today : addMonths(row.start_date, m);
    points.push({ date: at, saved: rupees(row.opening_paise + items.filter((i) => i.date <= at).reduce((s, i) => s + i.amount, 0)) });
  }
  if (!points.length || points.at(-1).date !== today) {
    points.push({ date: today, saved: rupees(row.opening_paise + items.reduce((s, i) => s + i.amount, 0)) });
  }
  return points;
}

// --- Views -----------------------------------------------------------------------------------

function toView(userId, row, { today = todayKey(), detail = false, autoDebits } = {}) {
  const money = contributionsFor(userId, row);
  const saved = row.opening_paise + money.total;
  const plan = planFor({
    pricePaise: row.price_paise,
    priceAsOf: row.price_as_of,
    plan: row.plan,
    targetDate: row.target_date,
    monthlyPaise: row.monthly_paise || 0,
    savedPaise: saved,
    inflationRate: row.inflation_rate,
    returnRate: row.return_rate,
    today,
  });
  const tracking = track({
    openingPaise: row.opening_paise,
    plannedMonthlyPaise: row.monthly_paise,
    returnRate: row.return_rate,
    startDate: row.start_date,
    today,
    savedPaise: saved,
    priceNowPaise: plan.priceNow,
  });
  const recent = money.items.filter((i) => i.date >= addMonths(today, -3));

  const view = {
    ...toGoal(row),
    autoDebitName: autoDebits?.get(row.commitment_id)?.name,
    saved: rupees(saved),
    priceNow: rupees(plan.priceNow),
    priceAtTarget: rupees(plan.priceAtTarget),
    eta: plan.targetDate ?? null, // by_date: the chosen date; by_amount: when the saving catches the price
    monthsLeft: plan.monthsLeft,
    never: plan.never || false,
    monthlyNeeded: rupees(plan.monthlyNeeded), // from today's savings
    plannedMonthly: rupees(row.monthly_paise),
    progress: plan.progress,
    track: { status: row.status === 'achieved' ? 'reached' : tracking.status, expected: rupees(tracking.expected), difference: rupees(tracking.difference) },
    lastThreeMonths: rupees(recent.reduce((s, i) => s + i.amount, 0)),
    sources: { manual: money.items.some((i) => i.source === 'manual'), autoDebit: Boolean(row.commitment_id), account: Boolean(row.watch_account) },
  };
  if (detail) {
    view.contributions = money.items.map((i) => ({ ...i, amount: rupees(i.amount) }));
    view.exclusions = money.exclusions;
    view.projection = plan.series.map((p) => ({ date: p.date, saved: rupees(p.saved), price: rupees(p.price) }));
    view.history = historyFor(row, money.items, today);
  }
  return view;
}

function autoDebitMap(userId) {
  const rows = getDb().prepare('SELECT id, name, amount_paise, match_key FROM active_commitments WHERE user_id = ?').all(userId);
  return new Map(rows.map((r) => [r.id, r]));
}

async function listGoals(userId) {
  const rows = getDb().prepare("SELECT * FROM active_goals WHERE user_id = ? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, created_at").all(userId);
  const autoDebits = autoDebitMap(userId);
  const today = todayKey();
  const items = rows.map((r) => toView(userId, r, { today, autoDebits }));
  const active = items.filter((i) => i.status === 'active');
  return {
    items,
    totals: {
      saved: Math.round(items.reduce((s, i) => s + i.saved, 0) * 100) / 100,
      monthlyNeeded: Math.round(active.reduce((s, i) => s + (i.monthlyNeeded || 0), 0) * 100) / 100,
      active: active.length,
    },
    today,
  };
}

async function getGoal(userId, id) {
  return toView(userId, findRow(userId, id), { detail: true, autoDebits: autoDebitMap(userId) });
}

/** The calculator behind the create dialog: nothing is saved. */
async function previewPlan(userId, body) {
  const today = todayKey();
  const plan = planFor({
    pricePaise: toPaise(body.price),
    priceAsOf: body.priceAsOf || today,
    plan: body.plan,
    targetDate: body.targetDate,
    monthlyPaise: toPaise(body.monthly) || 0,
    savedPaise: toPaise(body.opening) || 0,
    inflationRate: body.inflationRate,
    returnRate: body.returnRate ?? SAVING_IN[body.savingIn] ?? 0,
    today,
  });
  return {
    priceNow: rupees(plan.priceNow),
    priceAtTarget: rupees(plan.priceAtTarget),
    eta: plan.targetDate ?? null,
    monthsLeft: plan.monthsLeft,
    never: plan.never || false,
    monthlyNeeded: rupees(plan.monthlyNeeded),
    progress: plan.progress,
    projection: plan.series.map((p) => ({ date: p.date, saved: rupees(p.saved), price: rupees(p.price) })),
  };
}

// --- Create / update ---------------------------------------------------------------------------

function assertLinks(userId, goalId, { autoDebit, watchAccount }) {
  const db = getDb();
  if (autoDebit) {
    const c = db.prepare('SELECT id, match_key FROM active_commitments WHERE id = ? AND user_id = ?').get(autoDebit, userId);
    if (!c) throw AppError.badRequest('Auto-debit not found', 'INVALID_AUTO_DEBIT');
    const taken = db.prepare('SELECT name FROM active_goals WHERE commitment_id = ? AND user_id = ? AND id <> ?').pluck().get(autoDebit, userId, goalId || '');
    if (taken) throw AppError.conflict(`That auto-debit already funds “${taken}”. One auto-debit funds one goal.`, 'AUTO_DEBIT_TAKEN');
  }
  if (watchAccount && !db.prepare('SELECT 1 FROM active_transactions WHERE user_id = ? AND account = ? LIMIT 1').get(userId, watchAccount)) {
    throw AppError.badRequest('No transactions from that account yet. Import a statement for it first.', 'INVALID_ACCOUNT');
  }
}

/**
 * For a by-date goal the planned monthly saving is worked out, not entered: from the start date
 * (which may be in the past) and the opening amount, so "on track" is measured against one plan.
 */
function plannedMonthly(columns, today) {
  if (columns.plan !== 'by_date') return columns.monthly_paise;
  const plan = planFor({
    pricePaise: columns.price_paise,
    priceAsOf: columns.price_as_of,
    plan: 'by_date',
    targetDate: columns.target_date,
    savedPaise: columns.opening_paise || 0,
    inflationRate: columns.inflation_rate,
    returnRate: columns.return_rate,
    today: columns.start_date || today,
  });
  return plan.monthlyNeeded || null;
}

async function createGoal(userId, body) {
  const today = todayKey();
  assertLinks(userId, null, body);
  const columns = {
    price_as_of: today,
    start_date: today,
    inflation_rate: 6,
    saving_in: 'savings',
    opening_paise: 0,
    ...toColumns(body),
  };
  if (body.returnRate === undefined) columns.return_rate = SAVING_IN[columns.saving_in] ?? 0;
  columns.monthly_paise = plannedMonthly(columns, today);
  const now = nowIso();
  const id = newId();
  insertRow(getDb(), 'goals', { id, user_id: userId, status: 'active', ...columns, created_at: now, updated_at: now });
  require('./goal.worker').nudge(userId);
  return getGoal(userId, id);
}

// Changing any of these re-plans a by-date goal (and resets what "on track" is measured against).
const PLAN_FIELDS = ['price_paise', 'price_as_of', 'plan', 'target_date', 'opening_paise', 'inflation_rate', 'return_rate', 'start_date'];

async function updateGoal(userId, id, body) {
  const row = findRow(userId, id);
  const today = todayKey();
  assertLinks(userId, id, body);
  const changes = toColumns(body);
  if (body.savingIn !== undefined && body.returnRate === undefined) changes.return_rate = SAVING_IN[body.savingIn] ?? row.return_rate;
  const merged = { ...row, ...changes };
  if (merged.plan === 'by_date' && !merged.target_date) throw AppError.badRequest('Pick a date for this goal', 'VALIDATION_ERROR');
  if (merged.plan === 'by_amount' && !merged.monthly_paise) throw AppError.badRequest('Enter how much you can save each month', 'VALIDATION_ERROR');
  if (merged.plan === 'by_date' && PLAN_FIELDS.some((f) => changes[f] !== undefined && changes[f] !== row[f])) {
    changes.monthly_paise = plannedMonthly(merged, today);
  }
  updateRow(getDb(), 'goals', id, { ...changes, updated_at: nowIso() });
  require('./goal.worker').nudge(userId);
  return getGoal(userId, id);
}

async function deleteGoal(userId, id) {
  findRow(userId, id);
  const now = nowIso();
  updateRow(getDb(), 'goals', id, { deleted_at: now, updated_at: now });
  return { _id: id };
}

// --- Contributions ------------------------------------------------------------------------------

async function addContribution(userId, goalId, { amount, date, note, transactionId }) {
  findRow(userId, goalId);
  const db = getDb();
  const row = { id: newId(), goal_id: goalId, user_id: userId, note: note || null, created_at: nowIso() };
  if (transactionId) {
    const t = db.prepare('SELECT id, date, amount_paise FROM active_transactions WHERE id = ? AND user_id = ?').get(transactionId, userId);
    if (!t) throw AppError.badRequest('Transaction not found', 'INVALID_TRANSACTION');
    db.transaction(() => {
      // Linking a row the goal had excluded brings it back as a linked row.
      db.prepare("DELETE FROM goal_contributions WHERE goal_id = ? AND transaction_id = ? AND source = 'excluded'").run(goalId, t.id);
      try {
        insertRow(db, 'goal_contributions', { ...row, source: 'transaction', transaction_id: t.id, date: t.date, amount_paise: amount != null ? toPaise(amount) : t.amount_paise });
      } catch (err) {
        if (String(err.code).startsWith('SQLITE_CONSTRAINT')) throw AppError.conflict('That transaction already counts toward this goal', 'ALREADY_LINKED');
        throw err;
      }
    })();
  } else {
    if (!amount) throw AppError.badRequest('Enter an amount', 'VALIDATION_ERROR');
    insertRow(db, 'goal_contributions', { ...row, source: 'manual', amount_paise: toPaise(amount), date: date || todayKey() });
  }
  require('./goal.worker').nudge(userId);
  return getGoal(userId, goalId);
}

/** Removes a manual entry or a link, or un-excludes a transaction. */
async function removeContribution(userId, goalId, contributionId) {
  findRow(userId, goalId);
  const changes = getDb().prepare('DELETE FROM goal_contributions WHERE id = ? AND goal_id = ? AND user_id = ?').run(contributionId, goalId, userId).changes;
  if (!changes) throw AppError.notFound('Not found');
  require('./goal.worker').nudge(userId);
  return getGoal(userId, goalId);
}

/** Keeps one auto-detected transaction (auto-debit or watched account) out of the goal. */
async function excludeTransaction(userId, goalId, transactionId) {
  findRow(userId, goalId);
  const db = getDb();
  const t = db.prepare('SELECT id, date FROM active_transactions WHERE id = ? AND user_id = ?').get(transactionId, userId);
  if (!t) throw AppError.badRequest('Transaction not found', 'INVALID_TRANSACTION');
  db.prepare(
    `INSERT INTO goal_contributions (id, goal_id, user_id, source, amount_paise, date, transaction_id, created_at)
     VALUES (?, ?, ?, 'excluded', 0, ?, ?, ?) ON CONFLICT DO NOTHING`,
  ).run(newId(), goalId, userId, t.date, t.id, nowIso());
  require('./goal.worker').nudge(userId);
  return getGoal(userId, goalId);
}

/** Recent ledger rows that could be linked, minus ones already counted. */
async function linkCandidates(userId, goalId, search) {
  const row = findRow(userId, goalId);
  const counted = new Set(contributionsFor(userId, row).items.map((i) => i.transactionId).filter(Boolean));
  const like = search ? `%${search.replace(/[%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = getDb()
    .prepare(
      `SELECT id, date, description, type, amount_paise, account FROM active_transactions
       WHERE user_id = ? AND date >= ? AND (? IS NULL OR description LIKE ? ESCAPE '\\')
       ORDER BY date DESC, rowid DESC LIMIT 60`,
    )
    .all(userId, addMonths(todayKey(), -12), like, like);
  return {
    items: rows
      .filter((r) => !counted.has(r.id))
      .slice(0, 40)
      .map((r) => ({ _id: r.id, date: r.date, description: r.description, type: r.type, amount: rupees(r.amount_paise), account: r.account })),
  };
}

/** What the create/edit dialog can offer: accounts to watch, auto-debits to link, defaults. */
async function getOptions(userId) {
  const db = getDb();
  const accounts = db
    .prepare('SELECT account, count(*) AS count, max(date) AS last FROM active_transactions WHERE user_id = ? GROUP BY account ORDER BY last DESC')
    .all(userId)
    .map((a) => ({ account: a.account, count: a.count, last: a.last }));
  const linked = new Map(db.prepare('SELECT commitment_id, id, name FROM active_goals WHERE user_id = ? AND commitment_id IS NOT NULL').all(userId).map((g) => [g.commitment_id, g]));
  const autoDebits = db
    .prepare("SELECT id, name, kind, amount_paise, match_key, frequency FROM active_commitments WHERE user_id = ? AND active = 1 AND kind <> 'loan' ORDER BY name")
    .all(userId)
    .map((c) => ({
      _id: c.id,
      name: c.name,
      kind: c.kind,
      amount: rupees(c.amount_paise),
      frequency: c.frequency,
      matched: Boolean(c.match_key), // without a statement merchant, its payments can't be found
      goal: linked.has(c.id) ? { _id: linked.get(c.id).id, name: linked.get(c.id).name } : null,
    }));
  return { kinds: KINDS, savingIn: SAVING_IN, accounts, autoDebits };
}

module.exports = {
  todayKey,
  findRow,
  contributionsFor,
  toView,
  listGoals,
  getGoal,
  previewPlan,
  createGoal,
  updateGoal,
  deleteGoal,
  addContribution,
  removeContribution,
  excludeTransaction,
  linkCandidates,
  getOptions,
};
