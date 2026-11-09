const { toPaise, fromPaise } = require('../../core/sql');

const KINDS = ['vehicle', 'home', 'travel', 'education', 'gadget', 'wedding', 'emergency', 'retirement', 'other'];
const PLANS = ['by_date', 'by_amount'];
const STATUSES = ['active', 'paused', 'achieved'];

// Where the money sits → a sensible starting return (annual %). The person can change it;
// market-linked returns (SIP) are an assumption, not a promise.
const SAVING_IN = { cash: 0, savings: 3, rd: 6.5, fd: 7, sip: 12, other: 0 };

// API (rupees, camelCase) ↔ table (paise, snake_case).
const FIELDS = {
  name: 'name',
  kind: 'kind',
  price: ['price_paise', toPaise],
  priceAsOf: 'price_as_of',
  plan: 'plan',
  targetDate: 'target_date',
  monthly: ['monthly_paise', toPaise],
  opening: ['opening_paise', (v) => toPaise(v) ?? 0],
  inflationRate: 'inflation_rate',
  savingIn: 'saving_in',
  returnRate: 'return_rate',
  startDate: 'start_date',
  watchAccount: 'watch_account',
  autoDebit: 'commitment_id',
  status: 'status',
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

function toGoal(row) {
  return {
    _id: row.id,
    name: row.name,
    kind: row.kind,
    price: fromPaise(row.price_paise),
    priceAsOf: row.price_as_of,
    plan: row.plan,
    targetDate: row.target_date ?? undefined,
    monthly: fromPaise(row.monthly_paise),
    opening: fromPaise(row.opening_paise),
    inflationRate: row.inflation_rate,
    savingIn: row.saving_in,
    returnRate: row.return_rate,
    startDate: row.start_date,
    watchAccount: row.watch_account ?? undefined,
    autoDebit: row.commitment_id ?? undefined,
    status: row.status,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { KINDS, PLANS, STATUSES, SAVING_IN, toColumns, toGoal };
