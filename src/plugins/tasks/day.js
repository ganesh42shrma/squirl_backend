// Date maths for Tasks. A "day" is the person's own day in their timezone, and it starts at
// `dayStartHour` (default 4 AM) so work done at 1 AM still counts for the day before.
// Days are 'YYYY-MM-DD' keys everywhere; all key arithmetic is done in UTC so DST can't shift it.

const formatters = new Map();

function formatterFor(timezone) {
  if (!formatters.has(timezone)) {
    formatters.set(
      timezone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }),
    );
  }
  return formatters.get(timezone);
}

function isValidTimezone(timezone) {
  try {
    formatterFor(timezone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock reading in `timezone` at `date`. */
function zonedParts(date, timezone) {
  const parts = {};
  for (const p of formatterFor(timezone).formatToParts(date)) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return parts;
}

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** The person's day (the key) that `date` falls in. */
function dayKey(date, { timezone, dayStartHour }) {
  const shifted = new Date(date.getTime() - dayStartHour * 3600_000);
  const p = zonedParts(shifted, timezone);
  return keyOf(p.year, p.month, p.day);
}

/** The local clock hour (0-23) at `date`, not shifted by the day start. */
const localHour = (date, timezone) => zonedParts(date, timezone).hour % 24;

/** When the day that contains `date` closes, as a Date. */
function dayEndsAt(date, settings) {
  const key = dayKey(date, settings);
  const [y, m, d] = addDays(key, 1).split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, settings.dayStartHour);
  const offsetAt = (instant) => {
    const p = zonedParts(new Date(instant), settings.timezone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
  };
  let guess = wall - offsetAt(date.getTime());
  guess = wall - offsetAt(guess); // once more, in case the offset changes before the boundary
  return new Date(guess);
}

function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** ISO weekday: Monday = 1 ... Sunday = 7. */
function isoWeekday(key) {
  const day = new Date(`${key}T00:00:00Z`).getUTCDay();
  return ((day + 6) % 7) + 1;
}

const weekStart = (key) => addDays(key, -(isoWeekday(key) - 1));
const monthStart = (key) => `${key.slice(0, 7)}-01`;
function monthEnd(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

module.exports = { isValidTimezone, dayKey, localHour, dayEndsAt, addDays, daysBetween, isoWeekday, weekStart, monthStart, monthEnd };
