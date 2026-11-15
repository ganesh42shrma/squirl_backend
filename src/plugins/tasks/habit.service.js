// Habits and their streaks. A streak is never stored as truth: it is recomputed from the check-ins
// by streak.engine and cached on the habit row, so editing history can't leave it wrong.
const AppError = require('../../core/AppError');
const { newId, nowIso, insertRow, updateRow } = require('../../core/sql');
const xp = require('./xp.engine');
const progress = require('./progress');
const { evaluateStreak, dayState, isDayDone, isDayBased, isScheduled } = require('./streak.engine');
const { addDays, weekStart } = require('./day');
const { toHabit, toHabitColumns, echoGrade } = require('./task.model');

const GRID_DAYS = 35; // the little history grid on each habit card
const GRACE_DAYS = 1; // yesterday can still be checked in today
const QUEST_SLOTS = 5;

function findHabitRow(db, userId, id) {
  const row = db.prepare('SELECT * FROM active_habits WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) throw AppError.notFound('Habit not found');
  return row;
}

const checkinsFor = (db, habitId, from) =>
  db.prepare('SELECT date, kind, quantity FROM habit_checkins WHERE habit_id = ? AND date >= ? ORDER BY date').all(habitId, from ?? '0000-00-00');

const vacationOf = (settings) => (settings.vacationFrom && settings.vacationUntil ? { from: settings.vacationFrom, until: settings.vacationUntil } : null);

/**
 * Re-evaluates a habit, saves the cached streak figures and reports what changed
 * (a freeze spent or earned, a chain broken). Safe to call any time: it only reports a change once.
 */
function syncHabit(ctx, row) {
  const { db, settings, clock, events } = ctx;
  const checkins = checkinsFor(db, row.id);
  const ev = evaluateStreak(row, checkins, { today: clock.today, vacation: vacationOf(settings) });
  const used = ev.freezesUsedOn.length;
  const changes = { current_streak: ev.current, longest_streak: ev.longest, freezes_held: ev.freezes, freezes_used_total: used };
  const changed = Object.entries(changes).some(([k, v]) => row[k] !== v);
  if (changed) db.prepare(`UPDATE habits SET ${Object.keys(changes).map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...changes, id: row.id });
  if (used > row.freezes_used_total) events.push({ type: 'streak_protected', habitId: row.id, name: row.name, freezesLeft: ev.freezes, streak: ev.current });
  else if (ev.freezes > row.freezes_held) events.push({ type: 'freeze_earned', habitId: row.id, name: row.name, freezesHeld: ev.freezes });
  if (row.current_streak > 0 && ev.current === 0 && used === row.freezes_used_total) events.push({ type: 'chain_broken', habitId: row.id, name: row.name, was: row.current_streak });
  return { row: { ...row, ...changes }, ev, checkins };
}

function viewOf(ctx, synced) {
  const { clock } = ctx;
  const days = Array.from({ length: GRID_DAYS }, (_, i) => {
    const date = addDays(clock.today, i - (GRID_DAYS - 1));
    return { date, state: dayState(synced.row, synced.checkins, date, clock.today) };
  });
  return toHabit(synced.row, synced.ev, days);
}

function listHabits(ctx, { archived = false } = {}) {
  const { db, userId } = ctx;
  const rows = db.prepare(`SELECT * FROM active_habits WHERE user_id = ? AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'} ORDER BY position, rowid`).all(userId);
  return rows.map((row) => viewOf(ctx, syncHabit(ctx, row)));
}

function getHabit(ctx, id) {
  return viewOf(ctx, syncHabit(ctx, findHabitRow(ctx.db, ctx.userId, id)));
}

/** Habits and free-form lines share five Daily Quest slots. */
function assertQuestRoom(ctx, habitId) {
  const { db, userId, settings } = ctx;
  const flagged = db.prepare('SELECT count(*) FROM active_habits WHERE user_id = ? AND archived_at IS NULL AND in_daily_quest = 1 AND id IS NOT ?').pluck().get(userId, habitId ?? null);
  if (flagged + settings.dailyQuestTemplate.length + 1 > QUEST_SLOTS) {
    throw AppError.badRequest('The Daily Quest holds up to five items. Remove one in Today’s Quest settings first.', 'QUEST_FULL');
  }
}

function createHabit(ctx, data) {
  const { db, userId, clock, events } = ctx;
  if (data.inDailyQuest) assertQuestRoom(ctx, null);
  const now = nowIso();
  const id = newId();
  const position = db.prepare('SELECT ifnull(max(position), 0) + 1 FROM active_habits WHERE user_id = ?').pluck().get(userId);
  insertRow(db, 'habits', { ...toHabitColumns({ ...data, startDate: data.startDate ?? clock.today }), id, user_id: userId, position, created_at: now, updated_at: now });
  progress.settle(db, userId, clock.today, events);
  return getHabit(ctx, id);
}

function updateHabit(ctx, id, data) {
  const { db, userId, clock, events } = ctx;
  const row = findHabitRow(db, userId, id);
  if (data.inDailyQuest && !row.in_daily_quest) assertQuestRoom(ctx, id);
  if (data.cadence && data.cadence !== 'every_n_days' && data.everyN === undefined) data.everyN = null;
  updateRow(db, 'habits', id, { ...toHabitColumns(data), updated_at: nowIso() });
  progress.settle(db, userId, clock.today, events);
  return getHabit(ctx, id);
}

function archiveHabit(ctx, id, archived = true) {
  const { db, userId } = ctx;
  findHabitRow(db, userId, id);
  const now = nowIso();
  db.prepare('UPDATE habits SET archived_at = ?, in_daily_quest = CASE WHEN ? THEN 0 ELSE in_daily_quest END, updated_at = ? WHERE id = ?').run(archived ? now : null, archived ? 1 : 0, now, id);
  return { _id: id, archived };
}

function deleteHabit({ db, userId }, id) {
  findHabitRow(db, userId, id);
  const now = nowIso();
  db.prepare('UPDATE habits SET deleted_at = ?, in_daily_quest = 0, updated_at = ? WHERE id = ?').run(now, now, id);
  return { _id: id };
}

function assertCheckinDate(ctx, row, date) {
  const earliest = addDays(ctx.clock.today, -GRACE_DAYS);
  if (date > ctx.clock.today) throw AppError.badRequest('You can’t check in for a day that hasn’t happened yet', 'FUTURE_DATE');
  if (date < earliest) throw AppError.badRequest('Only today and yesterday can be checked in', 'OUTSIDE_GRACE');
  if (date < row.start_date) throw AppError.badRequest('That’s before this habit started', 'BEFORE_START');
}

function checkIn(ctx, id, { date, kind = 'done', quantity }) {
  const { db, userId, settings, clock, events } = ctx;
  const row = findHabitRow(db, userId, id);
  if (row.archived_at) throw AppError.conflict('This habit is archived', 'HABIT_ARCHIVED');
  const day = date || clock.today;
  assertCheckinDate(ctx, row, day);
  const before = evaluateStreak(row, checkinsFor(db, id), { today: clock.today, vacation: vacationOf(settings) });
  const now = nowIso();

  if (kind === 'skip') {
    if (db.prepare("SELECT 1 FROM habit_checkins WHERE habit_id = ? AND date = ? AND kind = 'done'").get(id, day)) throw AppError.conflict('Already done that day', 'ALREADY_DONE');
    const start = weekStart(day);
    const used = db.prepare("SELECT count(*) FROM habit_checkins WHERE habit_id = ? AND kind = 'skip' AND date >= ? AND date <= ? AND date <> ?").pluck().get(id, start, addDays(start, 6), day);
    if (used >= row.skips_per_week) throw AppError.conflict(row.skips_per_week ? 'No rest days left this week' : 'This habit doesn’t allow rest days', 'NO_SKIPS_LEFT');
    db.prepare("INSERT OR IGNORE INTO habit_checkins (id, habit_id, user_id, date, kind, quantity, created_at) VALUES (?, ?, ?, ?, 'skip', NULL, ?)").run(newId(), id, userId, day, now);
  } else {
    if (isDayBased(row) && !isScheduled(row, day)) throw AppError.badRequest('This habit isn’t scheduled that day', 'NOT_SCHEDULED');
    const amount = row.target_quantity == null ? null : quantity ?? row.target_quantity;
    db.prepare("DELETE FROM habit_checkins WHERE habit_id = ? AND date = ? AND kind = 'skip'").run(id, day);
    db.prepare(`INSERT INTO habit_checkins (id, habit_id, user_id, date, kind, quantity, created_at) VALUES (?, ?, ?, ?, 'done', ?, ?)
                ON CONFLICT (habit_id, date, kind) DO UPDATE SET quantity = excluded.quantity`).run(newId(), id, userId, day, amount, now);
  }

  const synced = syncHabit(ctx, findHabitRow(db, userId, id));
  const success = isDayDone(synced.row, synced.checkins.find((c) => c.date === day && c.kind === 'done'));
  if (success) payForDay(ctx, synced, day, before);
  require('./quest.service').evaluateQuest(ctx, day);
  progress.settle(db, userId, clock.today, events);
  return viewOf(ctx, synced);
}

/** XP for a habit's day (once per day, for life) and any streak milestone it reached. */
function payForDay(ctx, synced, day, before) {
  const { db, userId, settings, clock, events } = ctx;
  const { row, ev } = synced;
  const raw = xp.habitAward({ difficulty: row.difficulty, streak: ev.current, echoCount: progress.echoCount(db, userId) });
  const award = xp.applyDailyLimits(raw, { ...progress.dayLedger(db, userId, day), cap: settings.dailyCap });
  const paid = progress.awardXp(db, userId, {
    reason: 'habit', amount: award.amount, sourceId: row.id, dedupeKey: `habit:${row.id}:${day}`, stat: row.stat, tier: award.tier,
    occurredOn: day, meta: { base: award.base, factor: award.factor, echo: award.echo, notes: award.notes },
  }, events);
  if (paid) {
    const last = events[events.length - 1];
    if (last?.type === 'xp') { last.label = row.name; last.tier = award.tier; }
    if (award.crossedCap) events.push({ type: 'warning', code: 'daily_cap' });
  }
  if (ev.current > before.current) {
    events.push({ type: 'streak', habitId: row.id, name: row.name, value: ev.current, milestone: xp.STREAK_TOASTS.includes(ev.current) });
    for (const [at, reward] of Object.entries(xp.STREAK_MILESTONES)) {
      if (ev.current >= Number(at)) {
        progress.awardXp(db, userId, { reason: 'streak_milestone', amount: reward, sourceId: row.id, dedupeKey: `milestone:${row.id}:${at}`, stat: row.stat, occurredOn: clock.today }, events);
      }
    }
  }
}

function undoCheckIn(ctx, id, date) {
  const { db, userId, clock, events } = ctx;
  const row = findHabitRow(db, userId, id);
  assertCheckinDate(ctx, row, date);
  db.prepare('DELETE FROM habit_checkins WHERE habit_id = ? AND date = ?').run(id, date);
  progress.reverseXp(db, userId, `habit:${id}:${date}`, events);
  const synced = syncHabit(ctx, findHabitRow(db, userId, id));
  progress.settle(db, userId, clock.today, events);
  return viewOf(ctx, synced);
}

/**
 * Puts a day's logged quantity back to an earlier value (Quick Capture undoing a repeat check-in). Falling
 * back under the target takes that day's XP back, and the streak is re-evaluated, exactly like undoCheckIn.
 */
function restoreQuantity(ctx, id, date, quantity) {
  const { db, userId, clock, events } = ctx;
  const row = findHabitRow(db, userId, id);
  db.prepare("UPDATE habit_checkins SET quantity = ? WHERE habit_id = ? AND date = ? AND kind = 'done'").run(quantity ?? null, id, date);
  const checkin = db.prepare("SELECT kind, quantity FROM habit_checkins WHERE habit_id = ? AND date = ? AND kind = 'done'").get(id, date);
  if (!isDayDone(row, checkin)) progress.reverseXp(db, userId, `habit:${id}:${date}`, events);
  const synced = syncHabit(ctx, findHabitRow(db, userId, id));
  progress.settle(db, userId, clock.today, events);
  return viewOf(ctx, synced);
}

function bindEcho(ctx, id) {
  const { db, userId, clock, events } = ctx;
  const synced = syncHabit(ctx, findHabitRow(db, userId, id));
  const { row } = synced;
  if (row.echo_bound_at) throw AppError.conflict('This habit is already an Echo', 'ALREADY_BOUND');
  if (row.longest_streak < 66) throw AppError.conflict(`A habit needs a streak of 66 to become an Echo (best so far: ${row.longest_streak})`, 'NOT_READY');
  db.prepare('UPDATE habits SET echo_bound_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id);
  events.push({ type: 'echo_bound', habitId: id, name: row.name, grade: echoGrade(row.longest_streak) });
  progress.settle(db, userId, clock.today, events);
  return getHabit(ctx, id);
}

function history(ctx, id, { from, to }) {
  const { db, userId, clock } = ctx;
  findHabitRow(db, userId, id);
  const start = from || addDays(clock.today, -180);
  const end = to || clock.today;
  return db.prepare('SELECT date, kind, quantity FROM habit_checkins WHERE habit_id = ? AND date >= ? AND date <= ? ORDER BY date').all(id, start, end);
}

/** Re-evaluates every live habit, so freezes spent and chains broken overnight are noticed. */
function syncAllHabits(ctx) {
  for (const row of ctx.db.prepare('SELECT * FROM active_habits WHERE user_id = ? AND archived_at IS NULL').all(ctx.userId)) syncHabit(ctx, row);
}

module.exports = { GRACE_DAYS, listHabits, getHabit, createHabit, updateHabit, archiveHabit, deleteHabit, checkIn, undoCheckIn, restoreQuantity, bindEcho, history, syncHabit, syncAllHabits, findHabitRow, checkinsFor, QUEST_SLOTS };
