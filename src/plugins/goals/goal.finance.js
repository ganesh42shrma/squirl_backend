// Savings-goal maths. Pure functions, money in integer paise, dates as 'YYYY-MM-DD'.
// Every number on the Goals pages comes from here; the model only explains them.
//
// Model: a price that rises with inflation (compounded yearly, applied monthly), and savings that
// grow at the expected return of wherever the money sits (compounded monthly), with the monthly
// saving added at the end of each month.

const MAX_MONTHS = 600; // 50 years: beyond that a plan is "never"

const parse = (key) => key.split('-').map(Number);
const pad = (n) => String(n).padStart(2, '0');

/** Whole months from `from` to `to` (a month counts once its day-of-month is reached). */
function monthsBetween(from, to) {
  const [y1, m1, d1] = parse(from);
  const [y2, m2, d2] = parse(to);
  return (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
}

/** The same day n months later, clamped to the month's last day. */
function addMonths(key, n) {
  const [y, m, d] = parse(key);
  const index = m - 1 + n;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${pad(month + 1)}-${pad(Math.min(d, last))}`;
}

const monthlyRate = (annualPct) => annualPct / 12 / 100;

/** Price after `months` of inflation. */
const inflate = (paise, inflationPct, months) => Math.round(paise * (1 + inflationPct / 100) ** (Math.max(months, 0) / 12));

/** Savings after `months`: today's balance grown, plus the monthly saving and its growth. */
function grow(savedPaise, monthlyPaise, returnPct, months) {
  const r = monthlyRate(returnPct);
  if (!r) return Math.round(savedPaise + monthlyPaise * months);
  const f = (1 + r) ** months;
  return Math.round(savedPaise * f + (monthlyPaise * (f - 1)) / r);
}

/** Monthly saving that reaches the inflated price in `months`. 0 if savings already get there. */
function monthlyNeeded(priceNowPaise, savedPaise, inflationPct, returnPct, months) {
  if (months <= 0) return Math.max(priceNowPaise - savedPaise, 0);
  const target = inflate(priceNowPaise, inflationPct, months);
  const r = monthlyRate(returnPct);
  const gap = target - savedPaise * (1 + r) ** months;
  if (gap <= 0) return 0;
  return Math.ceil(r ? (gap * r) / ((1 + r) ** months - 1) : gap / months);
}

/** Months until savings catch the rising price; 0 if already there; null if never (within 50 years). */
function monthsToGoal(priceNowPaise, savedPaise, monthlyPaise, inflationPct, returnPct) {
  if (savedPaise >= priceNowPaise) return 0;
  const r = monthlyRate(returnPct);
  let balance = savedPaise;
  for (let m = 1; m <= MAX_MONTHS; m += 1) {
    balance = balance * (1 + r) + monthlyPaise;
    if (balance >= inflate(priceNowPaise, inflationPct, m)) return m;
  }
  return null;
}

/** Up to ~60 monthly points from today to `months` ahead: projected savings against the price. */
function projection(priceNowPaise, savedPaise, monthlyPaise, inflationPct, returnPct, months, today) {
  const horizon = Math.min(Math.max(months, 1), MAX_MONTHS);
  const step = Math.max(1, Math.ceil(horizon / 60));
  const points = [];
  for (let m = 0; m <= horizon; m += step) {
    points.push({ date: addMonths(today, m), saved: grow(savedPaise, monthlyPaise, returnPct, m), price: inflate(priceNowPaise, inflationPct, m) });
  }
  if (points.at(-1).date !== addMonths(today, horizon)) {
    points.push({ date: addMonths(today, horizon), saved: grow(savedPaise, monthlyPaise, returnPct, horizon), price: inflate(priceNowPaise, inflationPct, horizon) });
  }
  return points;
}

/**
 * The whole plan from where things stand today.
 *  - by_date:   what it costs on the date, and the monthly saving needed from now.
 *  - by_amount: when the monthly saving catches the price (or never).
 */
function planFor({ pricePaise, priceAsOf, plan, targetDate, monthlyPaise, savedPaise, inflationRate, returnRate, today }) {
  const priceNow = inflate(pricePaise, inflationRate, monthsBetween(priceAsOf, today));
  const out = { priceNow, saved: savedPaise };

  if (plan === 'by_date') {
    const monthsLeft = Math.max(monthsBetween(today, targetDate), 0);
    const needed = monthlyNeeded(priceNow, savedPaise, inflationRate, returnRate, monthsLeft);
    Object.assign(out, {
      monthsLeft,
      targetDate,
      priceAtTarget: inflate(priceNow, inflationRate, monthsLeft),
      monthlyNeeded: needed,
      series: projection(priceNow, savedPaise, needed, inflationRate, returnRate, monthsLeft, today),
    });
  } else {
    const months = monthsToGoal(priceNow, savedPaise, monthlyPaise, inflationRate, returnRate);
    Object.assign(out, {
      monthlyNeeded: monthlyPaise,
      monthsLeft: months,
      targetDate: months == null ? null : addMonths(today, months),
      priceAtTarget: months == null ? null : inflate(priceNow, inflationRate, months),
      never: months == null,
      series: projection(priceNow, savedPaise, monthlyPaise, inflationRate, returnRate, months ?? 120, today),
    });
  }
  out.progress = out.priceAtTarget ? Math.min(Math.round((savedPaise / out.priceAtTarget) * 1000) / 10, 100) : Math.min(Math.round((savedPaise / priceNow) * 1000) / 10, 100);
  return out;
}

/**
 * Where savings should be by today if the original plan (opening amount + planned monthly
 * from the start date) had been followed, and how the real figure compares.
 */
function track({ openingPaise, plannedMonthlyPaise, returnRate, startDate, today, savedPaise, priceNowPaise }) {
  if (savedPaise >= priceNowPaise) return { expected: savedPaise, difference: 0, status: 'reached' };
  const elapsed = Math.max(monthsBetween(startDate, today), 0);
  const expected = grow(openingPaise, plannedMonthlyPaise || 0, returnRate, elapsed);
  const difference = savedPaise - expected;
  // A month's grace either way before calling it ahead or behind.
  const slack = Math.max(plannedMonthlyPaise || 0, expected * 0.03);
  const status = elapsed === 0 ? 'on_track' : difference >= slack ? 'ahead' : difference <= -slack ? 'behind' : 'on_track';
  return { expected, difference, status, monthsElapsed: elapsed };
}

module.exports = { MAX_MONTHS, monthsBetween, addMonths, inflate, grow, monthlyNeeded, monthsToGoal, projection, planFor, track };
