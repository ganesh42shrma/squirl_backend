// Builds the per-request context for the Tasks services and runs the work in one transaction.
// Before anything else it settles any finished days (Daily Quest, penalties, streak freezes), so
// every response reflects the person's current day. `events` is what the UI turns into toasts.
const { getDb } = require('../../config/db');
const { readSettings, clockFor } = require('./settings');
const { closePastDays } = require('./quest.service');

function run(userId, work, { now } = {}) {
  const db = getDb();
  const events = [];
  const data = db.transaction(() => {
    const settings = readSettings(db, userId);
    const ctx = { db, userId, settings, clock: clockFor(settings, now), events };
    closePastDays(ctx);
    return work(ctx);
  })();
  return { data, events };
}

module.exports = { run };
