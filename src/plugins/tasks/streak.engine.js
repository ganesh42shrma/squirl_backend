// Pure streak maths. Given a habit and its check-ins it works out the streak by walking every
// period (a day, an ISO week, a month, or an every-N-days window) from the start date:
//   success  -> the streak grows (and every 7th success in a row earns a freeze)
//   neutral  -> nothing happens (not scheduled, skipped, on vacation, or a partial first period)
//   failure  -> a freeze is spent if one is held, otherwise the streak resets
// The period still in progress only counts once it has already succeeded; it can't fail yet.
const { addDays, daysBetween, isoWeekday, weekStart, monthStart, monthEnd } = require('./day');

const FREEZE_EVERY = 7; // successful periods in a row per freeze earned
const MAX_PERIODS = 2000; // a safety bound on the walk (about five and a half years of days)

const isScheduled = (habit, date) => habit.cadence !== 'weekdays' || ((habit.days_mask >> (isoWeekday(date) - 1)) & 1) === 1;
const isDayBased = (habit) => habit.cadence === 'daily' || habit.cadence === 'weekdays';

/** The period that contains `date`: { start, end } (both inclusive). */
function periodFor(habit, date) {
  switch (habit.cadence) {
    case 'times_per_week': {
      const start = weekStart(date);
      return { start, end: addDays(start, 6) };
    }
    case 'times_per_month':
      return { start: monthStart(date), end: monthEnd(date) };
    case 'every_n_days': {
      const n = habit.every_n || 2;
      const index = Math.floor(daysBetween(habit.start_date, date) / n);
      const start = addDays(habit.start_date, index * n);
      return { start, end: addDays(start, n - 1) };
    }
    default:
      return { start: date, end: date };
  }
}

/** How many successful days a period needs. */
function targetFor(habit, period) {
  if (habit.cadence === 'every_n_days') return 1;
  if (habit.cadence === 'times_per_week' || habit.cadence === 'times_per_month') {
    return Math.min(habit.target_per_period, daysBetween(period.start, period.end) + 1);
  }
  return 1;
}

/** A day counts as done when something was recorded (and the quantity reached the target, if there is one). */
function isDayDone(habit, checkin) {
  if (!checkin || checkin.kind !== 'done') return false;
  if (habit.target_quantity == null) return true;
  return (checkin.quantity ?? 0) >= habit.target_quantity;
}

const inVacation = (vacation, date) => Boolean(vacation?.from && vacation?.until && date >= vacation.from && date <= vacation.until);
const overlapsVacation = (vacation, period) => Boolean(vacation?.from && vacation?.until && period.start <= vacation.until && period.end >= vacation.from);

function evaluateStreak(habit, checkins, { today, vacation = null }) {
  const done = new Map(); // date -> checkin
  const skipped = new Set();
  for (const c of checkins) {
    if (c.kind === 'done') done.set(c.date, c);
    else if (c.kind === 'skip') skipped.add(c.date);
  }
  const doneDays = (period) => {
    let n = 0;
    for (let d = period.start; d <= period.end; d = addDays(d, 1)) if (isDayDone(habit, done.get(d))) n += 1;
    return n;
  };
  const hasSkip = (period) => {
    for (let d = period.start; d <= period.end; d = addDays(d, 1)) if (skipped.has(d)) return true;
    return false;
  };

  let current = 0;
  let longest = 0;
  let freezes = 0;
  let run = 0; // successes in a row since the last reset, for earning freezes
  let successes = 0;
  const freezesUsedOn = [];
  const freezesEarnedOn = [];

  const startOfHabit = habit.start_date > today ? today : habit.start_date;
  let period = periodFor(habit, startOfHabit);
  let todayPeriod = periodFor(habit, today);
  let guard = 0;

  while (period.start <= today && guard < MAX_PERIODS) {
    guard += 1;
    const closed = period.end < today;
    const target = targetFor(habit, period);
    let status;
    if (isDayBased(habit)) {
      if (!isScheduled(habit, period.start) || inVacation(vacation, period.start)) status = 'neutral';
      else if (isDayDone(habit, done.get(period.start))) status = 'success';
      else if (skipped.has(period.start)) status = 'neutral';
      else status = closed ? 'fail' : 'open';
    } else if (doneDays(period) >= target) {
      status = 'success';
    } else if (!closed) {
      status = 'open';
    } else if (period.start < habit.start_date || overlapsVacation(vacation, period) || hasSkip(period)) {
      status = 'neutral'; // a partial first period, a vacation, or a rest day never breaks the chain
    } else {
      status = 'fail';
    }

    if (status === 'success') {
      current += 1;
      longest = Math.max(longest, current);
      if (closed) {
        run += 1;
        successes += 1;
        if (run % FREEZE_EVERY === 0 && freezes < habit.freeze_max) { freezes += 1; freezesEarnedOn.push(period.start); }
      }
    } else if (status === 'fail') {
      if (freezes > 0) { freezes -= 1; freezesUsedOn.push(period.start); run = 0; }
      else { current = 0; run = 0; }
    }
    period = periodFor(habit, addDays(period.end, 1));
  }

  const target = targetFor(habit, todayPeriod);
  const count = doneDays(todayPeriod);
  const todayCheckin = done.get(today);
  return {
    current, longest, freezes, successes, freezesUsedOn, freezesEarnedOn,
    period: { start: todayPeriod.start, end: todayPeriod.end, done: count, target, complete: count >= target },
    scheduledToday: isDayBased(habit) ? isScheduled(habit, today) && !inVacation(vacation, today) : true,
    doneToday: isDayDone(habit, todayCheckin),
    quantityToday: todayCheckin?.quantity ?? null,
    skippedToday: skipped.has(today),
  };
}

/** One of the habit's recent days, for the little history grid. */
function dayState(habit, checkins, date, today) {
  if (date > today) return 'future';
  if (date < habit.start_date) return 'off';
  const c = checkins.find((x) => x.date === date && x.kind === 'done');
  if (c) return isDayDone(habit, c) ? 'done' : 'partial';
  if (checkins.some((x) => x.date === date && x.kind === 'skip')) return 'skip';
  if (isDayBased(habit) && isScheduled(habit, date) && date < today) return 'miss';
  return 'off';
}

module.exports = { FREEZE_EVERY, periodFor, targetFor, isScheduled, isDayBased, isDayDone, evaluateStreak, dayState };
