// Pure helpers for balances and history: no DB access here.

const DAY_MS = 24 * 60 * 60 * 1000;

const rupees = (paise) => Math.round(paise) / 100;

// '₹1,23,457': whole rupees, Indian grouping. Used for text the UI and the LLM show as-is.
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const formatInr = (amount) => inr.format(Math.round(amount));

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (key) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const formatDate = (key) => `${Number(key.slice(8, 10))} ${MONTH_NAMES[Number(key.slice(5, 7)) - 1].slice(0, 3)} ${key.slice(0, 4)}`;

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
}

// '2026-01' … '2026-04' inclusive.
function monthKeysBetween(fromKey, toKey) {
  const keys = [];
  let [y, m] = fromKey.split('-').map(Number);
  const [ty, tm] = toKey.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return keys;
}

/**
 * Walks one account's statement rows (date, rowid order) and returns its day-end balances
 * plus the places where the running balance doesn't chain. A break means rows are missing
 * between two dates: a statement period that was never imported.
 */
function walkAccount(rows) {
  const points = [];
  const gaps = [];
  let prev = null;
  for (const row of rows) {
    if (prev) {
      const delta = row.type === 'credit' ? row.amount_paise : -row.amount_paise;
      if (prev.balance_paise + delta !== row.balance_paise) {
        gaps.push({ from: prev.date, to: row.date });
      }
    }
    const last = points[points.length - 1];
    if (last && last.date === row.date) last.paise = row.balance_paise;
    else points.push({ date: row.date, paise: row.balance_paise });
    prev = row;
  }
  return { points, gaps };
}

/**
 * Combined balance over time: each account's last known balance, summed. Starts only once every
 * account has data, so an account appearing later doesn't look like money arriving.
 */
function combineAccounts(accounts) {
  if (!accounts.length) return { since: null, points: [] };
  const since = accounts.map((a) => a.points[0].date).sort().pop();
  const dates = [...new Set(accounts.flatMap((a) => a.points.map((p) => p.date)))].filter((d) => d >= since).sort();

  const cursors = accounts.map(() => 0);
  const current = accounts.map(() => 0);
  const points = [];
  for (const date of dates) {
    accounts.forEach((account, i) => {
      while (cursors[i] < account.points.length && account.points[cursors[i]].date <= date) {
        current[i] = account.points[cursors[i]].paise;
        cursors[i] += 1;
      }
    });
    points.push({ date, paise: current.reduce((sum, v) => sum + v, 0) });
  }
  return { since, points };
}

// Last point on or before `date` (points sorted by date).
function balanceOn(points, date) {
  let found = null;
  for (const p of points) {
    if (p.date > date) break;
    found = p;
  }
  return found;
}

/**
 * Money figures from `categoryType` groups, the way people think about them. Matches the
 * frontend's monthFigures(): unsorted debits count as spending and unsorted credits as earnings;
 * transfers between your own accounts are neither.
 */
function toFigures(groups) {
  const get = (key) => groups.find((g) => g.key === key) || { debit: 0, credit: 0, count: 0 };
  const expense = get('expense');
  const income = get('income');
  const investment = get('investment');
  const unsorted = get('uncategorized');
  const spent = Math.max(0, expense.debit - expense.credit + unsorted.debit);
  const earned = Math.max(0, income.credit - income.debit + unsorted.credit);
  const invested = investment.debit - investment.credit;
  return { earned, spent, invested, net: earned - spent - invested, unsortedCount: unsorted.count };
}

/** Plain-language highlights for a history range. Text is final: the UI and the LLM show it as-is. */
function buildHighlights({ months, totals, topCategories, biggest, balance }) {
  const active = months.filter((m) => m.earned || m.spent || m.invested);
  const out = [];

  if (totals.earned > 0) {
    const rate = Math.round((totals.net / totals.earned) * 100);
    out.push({
      id: 'kept',
      title: totals.net >= 0 ? 'Kept' : 'Overspent',
      value: formatInr(Math.abs(totals.net)),
      detail: totals.net >= 0 ? `${rate}% of the ${formatInr(totals.earned)} that came in` : `more than the ${formatInr(totals.earned)} that came in`,
    });
  }
  if (active.length) {
    out.push({
      id: 'average',
      title: 'Average month',
      value: `${formatInr(totals.spent / active.length)} spent`,
      detail: `${formatInr(totals.earned / active.length)} earned, over ${active.length} month${active.length === 1 ? '' : 's'}`,
    });
  }
  if (active.length > 1) {
    const best = active.reduce((a, b) => (b.net > a.net ? b : a));
    const heaviest = active.reduce((a, b) => (b.spent > a.spent ? b : a));
    out.push({ id: 'best', title: 'Best month', value: monthLabel(best.month), detail: `${formatInr(best.net)} left over` });
    out.push({ id: 'heaviest', title: 'Heaviest spending', value: monthLabel(heaviest.month), detail: `${formatInr(heaviest.spent)} spent` });
  }
  if (topCategories[0]) {
    const top = topCategories[0];
    out.push({ id: 'category', title: 'Biggest category', value: top.label, detail: `${formatInr(top.amount)}, ${top.share}% of spending` });
  }
  if (balance) {
    const change = balance.end - balance.start;
    out.push({
      id: 'balance',
      title: change >= 0 ? 'Balance grew' : 'Balance fell',
      value: formatInr(Math.abs(change)),
      detail: `from ${formatInr(balance.start)} on ${formatDate(balance.startDate)} to ${formatInr(balance.end)} on ${formatDate(balance.endDate)}`,
    });
  }
  const bigSpend = biggest.find((b) => b.type === 'debit');
  if (bigSpend) {
    out.push({ id: 'biggest', title: 'Largest single spend', value: formatInr(bigSpend.amount), detail: `${bigSpend.description.slice(0, 60)} on ${formatDate(bigSpend.date)}` });
  }
  return out;
}

module.exports = {
  rupees,
  formatInr,
  monthLabel,
  formatDate,
  daysBetween,
  monthKeysBetween,
  walkAccount,
  combineAccounts,
  balanceOn,
  toFigures,
  buildHighlights,
};
