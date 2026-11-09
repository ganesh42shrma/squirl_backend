// Loan and schedule maths. Pure functions, all money in integer paise, dates as 'YYYY-MM-DD'.
// This is where every number on the EMIs page comes from; nothing here is estimated by a model.

const PERIOD_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };
const DAY_MS = 86_400_000;

const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // m: 0-11
const parse = (key) => key.split('-').map(Number);

/** The due date in a month: the due day, or the month's last day if shorter ("31st" in February → 28/29). */
function dueIn(year, monthIndex, dueDay) {
  const y = year + Math.floor(monthIndex / 12);
  const m = ((monthIndex % 12) + 12) % 12;
  const d = Math.min(dueDay, daysInMonth(y, m));
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

/** First due date on or after the start date. */
function firstDue(startDate, dueDay) {
  const [y, m, d] = parse(startDate);
  return d <= Math.min(dueDay, daysInMonth(y, m - 1)) ? dueIn(y, m - 1, dueDay) : dueIn(y, m, dueDay);
}

/** The n-th due date (0 = first). */
function nthDue(startDate, dueDay, frequency, n) {
  const first = firstDue(startDate, dueDay);
  const [y, m] = parse(first);
  return dueIn(y, m - 1 + n * PERIOD_MONTHS[frequency], dueDay);
}

/** How many due dates fall on or before `date` (0 if the first is still ahead). */
function duesThrough(startDate, dueDay, frequency, date, max = Infinity) {
  let n = 0;
  while (n < max && nthDue(startDate, dueDay, frequency, n) <= date) n += 1;
  return n;
}

/** Standard reducing-balance EMI: P·i·(1+i)^n / ((1+i)^n − 1), i = annual rate / 12. Paise, rounded. */
function emiFor(principalPaise, annualRatePct, months) {
  if (!principalPaise || !months) return null;
  const i = annualRatePct / 12 / 100;
  if (!i) return Math.round(principalPaise / months);
  const f = (1 + i) ** months;
  return Math.round((principalPaise * i * f) / (f - 1));
}

/**
 * Month-by-month schedule from an opening outstanding balance: interest on what's outstanding,
 * the rest of the EMI repays principal; the final payment is trimmed to clear the balance exactly.
 */
function amortize(openingPaise, annualRatePct, emiPaise, { maxRows = 600 } = {}) {
  const i = annualRatePct / 12 / 100;
  const rows = [];
  let outstanding = openingPaise;
  while (outstanding > 0 && rows.length < maxRows) {
    const interest = Math.round(outstanding * i);
    let principal = emiPaise - interest;
    if (principal <= 0) break; // EMI doesn't cover the interest: the loan would never end
    if (principal > outstanding) principal = outstanding;
    outstanding -= principal;
    rows.push({ n: rows.length + 1, payment: principal + interest, interest, principal, outstanding });
  }
  return rows;
}

/**
 * Where a loan stands today. Uses the person's own "paid / outstanding as of" figures when given
 * (they come from the lender) and projects forward by the EMIs due since; otherwise works from
 * the start date. `source` says which.
 */
function loanPosition(c, today) {
  const rate = c.interestRate || 0;
  const emi = c.amountPaise || emiFor(c.principalPaise, rate, c.tenureMonths);
  const expectedEmi = c.principalPaise && c.tenureMonths ? emiFor(c.principalPaise, rate, c.tenureMonths) : null;
  const result = { emi, expectedEmi, emiMismatch: Boolean(c.amountPaise && expectedEmi && Math.abs(c.amountPaise - expectedEmi) / expectedEmi > 0.02) };
  if (!emi) return { ...result, source: 'incomplete' };

  let opening;
  let duesSince;
  let source;
  if (c.outstandingPaise != null && c.balanceAsOf) {
    opening = c.outstandingPaise;
    duesSince = duesThrough(c.startDate, c.dueDay, 'monthly', today) - duesThrough(c.startDate, c.dueDay, 'monthly', c.balanceAsOf);
    source = 'yours';
  } else if (c.principalPaise) {
    opening = c.principalPaise;
    duesSince = duesThrough(c.startDate, c.dueDay, 'monthly', today);
    source = 'estimated';
  } else {
    return { ...result, source: 'incomplete' };
  }

  const ahead = amortize(opening, rate, emi);
  if (!ahead.length) return { ...result, source, neverEnds: true };
  const done = Math.min(Math.max(duesSince, 0), ahead.length);
  const outstanding = done ? ahead[done - 1].outstanding : opening;
  const remaining = ahead.slice(done);
  const total = c.principalPaise || null;
  const paidPrincipal = total != null ? total - outstanding : c.paidPrincipalPaise ?? null;

  return {
    ...result,
    source,
    outstanding,
    paidPrincipal,
    progress: total ? Math.round(((total - outstanding) / total) * 1000) / 10 : null, // % of principal repaid
    emisLeft: remaining.length,
    interestLeft: remaining.reduce((sum, r) => sum + r.interest, 0),
    // The date of the last EMI: dues so far plus the ones left.
    lastDue: remaining.length ? nthDue(c.startDate, c.dueDay, 'monthly', duesThrough(c.startDate, c.dueDay, 'monthly', today) + remaining.length - 1) : null,
  };
}

module.exports = { PERIOD_MONTHS, firstDue, nthDue, duesThrough, emiFor, amortize, loanPosition, daysBetween, dueIn };
