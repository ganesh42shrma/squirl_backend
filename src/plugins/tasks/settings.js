// Per-person Tasks settings, stored as JSON on users.tasks_settings. Anything not saved falls back
// to these defaults, so a brand-new account needs no setup.
const { dayKey, dayEndsAt } = require('./day');
const { DAILY_CAP } = require('./xp.engine');

const DEFAULT_SETTINGS = {
  timezone: 'Asia/Kolkata',
  dayStartHour: 4,
  dailyCap: DAILY_CAP,
  // Free-form lines every Daily Quest starts from. Habits marked "in the Daily Quest" join them,
  // up to five items in all.
  dailyQuestTemplate: ['Move for 20 minutes', 'Read 10 pages', 'Review today’s spending in Squirl', 'Plan tomorrow'],
  penaltyTask: 'Extra 20-minute walk', // '' turns the penalty off: a missed day resets the chain at once
  vacationFrom: null,
  vacationUntil: null,
  lastClosedOn: null, // the last day whose Daily Quest and streaks were settled
};

function readSettings(db, userId) {
  const row = db.prepare('SELECT tasks_settings FROM users WHERE id = ?').get(userId);
  let saved = {};
  try { saved = JSON.parse(row?.tasks_settings || '{}') || {}; } catch { /* a damaged value falls back to defaults */ }
  return { ...DEFAULT_SETTINGS, ...saved };
}

function writeSettings(db, userId, settings) {
  db.prepare('UPDATE users SET tasks_settings = ? WHERE id = ?').run(JSON.stringify(settings), userId);
  return settings;
}

/** Today, and when it closes, for this person. `now` is injectable for tests. */
function clockFor(settings, now = new Date()) {
  return { now, today: dayKey(now, settings), closesAt: dayEndsAt(now, settings) };
}

module.exports = { DEFAULT_SETTINGS, readSettings, writeSettings, clockFor };
