const { insertRow, newId, nowIso, toPaise, fromPaise } = require('../../core/sql');

const KINDS = ['loan', 'subscription', 'auto_debit'];
const FREQUENCIES = ['monthly', 'quarterly', 'yearly'];

// API (rupees, camelCase) ↔ table (paise, snake_case).
const FIELDS = {
  kind: 'kind',
  name: 'name',
  lender: 'lender',
  amount: ['amount_paise', toPaise],
  frequency: 'frequency',
  dueDay: 'due_day',
  startDate: 'start_date',
  endDate: 'end_date',
  principal: ['principal_paise', toPaise],
  interestRate: 'interest_rate',
  tenureMonths: 'tenure_months',
  paidPrincipal: ['paid_principal_paise', toPaise],
  outstanding: ['outstanding_paise', toPaise],
  balanceAsOf: 'balance_as_of',
  account: 'account',
  category: 'category_id',
  matchKey: 'match_key',
  remindDays: 'remind_days',
  active: ['active', (v) => (v ? 1 : 0)],
  notes: 'notes',
};

function toColumns(data) {
  const out = {};
  for (const [key, spec] of Object.entries(FIELDS)) {
    if (data[key] === undefined) continue;
    const [column, convert] = Array.isArray(spec) ? spec : [spec, (v) => v];
    out[column] = data[key] === null ? null : convert(data[key]);
  }
  return out;
}

function toCommitment(row) {
  return {
    _id: row.id,
    kind: row.kind,
    name: row.name,
    lender: row.lender ?? undefined,
    amount: fromPaise(row.amount_paise),
    frequency: row.frequency,
    dueDay: row.due_day,
    startDate: row.start_date,
    endDate: row.end_date ?? undefined,
    principal: fromPaise(row.principal_paise),
    interestRate: row.interest_rate ?? undefined,
    tenureMonths: row.tenure_months ?? undefined,
    paidPrincipal: fromPaise(row.paid_principal_paise),
    outstanding: fromPaise(row.outstanding_paise),
    balanceAsOf: row.balance_as_of ?? undefined,
    account: row.account ?? undefined,
    category: row.category_id ?? undefined,
    matchKey: row.match_key ?? undefined,
    remindDays: row.remind_days,
    active: row.active === 1,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertCommitment(db, userId, data) {
  const now = nowIso();
  const id = newId();
  insertRow(db, 'commitments', { id, user_id: userId, frequency: 'monthly', remind_days: 3, active: 1, ...toColumns(data), created_at: now, updated_at: now });
  return id;
}

module.exports = { KINDS, FREQUENCIES, toColumns, toCommitment, insertCommitment };
