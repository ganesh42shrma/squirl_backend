// The Daily Quest: a short list for today (habits you flagged plus free-form lines). Clear every
// item before the day closes for XP and to extend the chain. Miss it and the next day opens a
// Penalty Quest; clear that and the chain survives, fail it and the chain resets (XP is never lost).
// Days are settled lazily, the first time a person's data is touched on a new day.
const AppError = require('../../core/AppError');
const { newId, nowIso, insertRow } = require('../../core/sql');
const xp = require('./xp.engine');
const progress = require('./progress');
const habits = require('./habit.service');
const { isDayDone } = require('./streak.engine');
const { addDays } = require('./day');
const { writeSettings } = require('./settings');
const { parseJson } = require('./task.model');

const MAX_CATCH_UP_DAYS = 60;

const rowFor = (db, userId, date) => db.prepare('SELECT * FROM daily_quests WHERE user_id = ? AND date = ?').get(userId, date);
const onVacation = (settings, date) => Boolean(settings.vacationFrom && settings.vacationUntil && date >= settings.vacationFrom && date <= settings.vacationUntil);

/** Today's lines: flagged habits first, then the free-form template, five at most. */
function buildItems(ctx) {
  const { db, userId, settings } = ctx;
  const flagged = db.prepare('SELECT id, name FROM active_habits WHERE user_id = ? AND archived_at IS NULL AND in_daily_quest = 1 ORDER BY position, rowid').all(userId);
  const items = [
    ...flagged.map((h) => ({ key: `h:${h.id}`, type: 'habit', refId: h.id, title: h.name, done: false })),
    ...settings.dailyQuestTemplate.map((title, i) => ({ key: `c${i}`, type: 'custom', title, done: false })),
  ];
  return items.slice(0, habits.QUEST_SLOTS);
}

function ensureQuest(ctx, date) {
  const { db, userId, settings } = ctx;
  const existing = rowFor(db, userId, date);
  if (existing) return existing;
  const items = buildItems(ctx);
  if (!items.length) return null;
  insertRow(db, 'daily_quests', { user_id: userId, date, items: JSON.stringify(items), status: onVacation(settings, date) ? 'paused' : 'open', created_at: nowIso() });
  return rowFor(db, userId, date);
}

/** The stored items with live "done" flags: a habit line is done when the habit's day is done. */
function itemsWithState(ctx, row) {
  const { db, userId } = ctx;
  return parseJson(row.items, []).map((item) => {
    if (item.type !== 'habit') return item;
    const habit = db.prepare('SELECT * FROM active_habits WHERE id = ? AND user_id = ?').get(item.refId, userId);
    if (!habit) return { ...item, missing: true, done: false };
    const checkin = db.prepare("SELECT date, kind, quantity FROM habit_checkins WHERE habit_id = ? AND date = ? AND kind = 'done'").get(habit.id, row.date);
    return { ...item, title: habit.name, done: isDayDone(habit, checkin) };
  }).filter((i) => !i.missing);
}

function questView(ctx, row) {
  if (!row) return null;
  const items = itemsWithState(ctx, row);
  return {
    date: row.date, status: row.status, items, total: items.length, done: items.filter((i) => i.done).length,
    clearedAt: row.cleared_at ?? undefined,
  };
}

const setChain = (db, userId, chain) => {
  progress.ensureProfile(db, userId);
  db.prepare('UPDATE hunter_profiles SET daily_chain = ?, longest_daily_chain = max(longest_daily_chain, ?), updated_at = ? WHERE user_id = ?').run(chain, chain, nowIso(), userId);
};

function currentPenalty(ctx) {
  const row = ctx.db
    .prepare("SELECT * FROM daily_quests WHERE user_id = ? AND status = 'penalty_open' AND penalty_due >= ? ORDER BY date DESC LIMIT 1")
    .get(ctx.userId, ctx.clock.today);
  return row ? { title: row.penalty_task, due: row.penalty_due, missedOn: row.date } : null;
}

function getToday(ctx) {
  const { db, userId, clock, settings } = ctx;
  const row = ensureQuest(ctx, clock.today);
  const profile = progress.ensureProfile(db, userId);
  return {
    ...(questView(ctx, row) || { date: clock.today, status: 'none', items: [], total: 0, done: 0 }),
    closesAt: clock.closesAt.toISOString(),
    chain: profile.daily_chain,
    longestChain: profile.longest_daily_chain,
    penalty: currentPenalty(ctx),
    onVacation: onVacation(settings, clock.today),
    rewardXp: xp.DAILY_QUEST_XP,
  };
}

/** Clears the day's quest when every line is done. Called after anything that could finish a line. */
function evaluateQuest(ctx, date) {
  const { db, userId, clock, events } = ctx;
  const row = rowFor(db, userId, date);
  // A late check-in (yesterday, within the grace window) still clears a day whose Penalty Quest is open.
  if (!row || !['open', 'penalty_open'].includes(row.status)) return;
  const items = itemsWithState(ctx, row);
  if (!items.length || !items.every((i) => i.done)) return;
  db.prepare("UPDATE daily_quests SET status = 'cleared', cleared_at = ? WHERE user_id = ? AND date = ?").run(nowIso(), userId, date);
  const profile = progress.ensureProfile(db, userId);
  const chain = profile.daily_chain + 1;
  setChain(db, userId, chain);
  progress.awardXp(db, userId, { reason: 'daily_quest', amount: xp.DAILY_QUEST_XP, sourceId: date, dedupeKey: `daily:${date}`, occurredOn: clock.today }, events);
  events.push({ type: 'daily_quest_cleared', chain, xp: xp.DAILY_QUEST_XP });
}

function toggleItem(ctx, key) {
  const { db, userId, clock, events } = ctx;
  const row = ensureQuest(ctx, clock.today);
  if (!row) throw AppError.notFound('There is no Daily Quest today');
  if (row.status !== 'open') throw AppError.conflict('Today’s quest is already settled', 'QUEST_SETTLED');
  const items = parseJson(row.items, []);
  const item = items.find((i) => i.key === key);
  if (!item) throw AppError.notFound('Quest item not found');
  if (item.type !== 'custom') throw AppError.badRequest('Check this line off by doing the habit', 'NOT_CUSTOM');
  item.done = !item.done;
  db.prepare('UPDATE daily_quests SET items = ? WHERE user_id = ? AND date = ?').run(JSON.stringify(items), userId, row.date);
  evaluateQuest(ctx, row.date);
  progress.settle(db, userId, clock.today, events);
  return getToday(ctx);
}

/** Replaces today's lines (the template is untouched). Lines keep their ticks when their key is unchanged. */
function setTodayItems(ctx, lines) {
  const { db, userId, clock } = ctx;
  const row = rowFor(db, userId, clock.today);
  if (row && row.status !== 'open' && row.status !== 'paused') throw AppError.conflict('Today’s quest is already settled', 'QUEST_SETTLED');
  const previous = new Map(parseJson(row?.items, []).map((i) => [i.key, i]));
  const items = lines.map((line, index) => {
    if (line.type === 'habit') {
      const habit = habits.findHabitRow(db, userId, line.refId);
      return { key: `h:${habit.id}`, type: 'habit', refId: habit.id, title: habit.name, done: false };
    }
    const key = line.key && /^c\d+$/.test(line.key) ? line.key : `c${index}x${newId().slice(0, 4)}`;
    return { key, type: 'custom', title: line.title, done: previous.get(key)?.done ?? false };
  });
  if (new Set(items.map((i) => i.key)).size !== items.length) throw AppError.badRequest('Each habit can appear once', 'DUPLICATE_ITEM');
  if (row) db.prepare('UPDATE daily_quests SET items = ? WHERE user_id = ? AND date = ?').run(JSON.stringify(items), userId, clock.today);
  else insertRow(db, 'daily_quests', { user_id: userId, date: clock.today, items: JSON.stringify(items), status: onVacation(ctx.settings, clock.today) ? 'paused' : 'open', created_at: nowIso() });
  evaluateQuest(ctx, clock.today);
  return getToday(ctx);
}

function completePenalty(ctx) {
  const { db, userId, clock, events } = ctx;
  const penalty = currentPenalty(ctx);
  if (!penalty) throw AppError.notFound('There is no Penalty Quest open', 'NO_PENALTY');
  db.prepare("UPDATE daily_quests SET status = 'penalty_cleared', cleared_at = ? WHERE user_id = ? AND date = ?").run(nowIso(), userId, penalty.missedOn);
  progress.awardXp(db, userId, { reason: 'penalty_quest', amount: xp.PENALTY_QUEST_XP, sourceId: penalty.missedOn, dedupeKey: `penalty:${penalty.missedOn}`, occurredOn: clock.today }, events);
  events.push({ type: 'penalty_cleared', title: penalty.title, xp: xp.PENALTY_QUEST_XP });
  progress.settle(db, userId, clock.today, events);
  return getToday(ctx);
}

// --- Settling past days -----------------------------------------------------------------------

function breakChain(ctx) {
  const profile = progress.ensureProfile(ctx.db, ctx.userId);
  if (profile.daily_chain > 0) ctx.events.push({ type: 'daily_chain_broken', was: profile.daily_chain });
  setChain(ctx.db, ctx.userId, 0);
}

function closeDay(ctx, date) {
  const { db, userId, settings, clock, events } = ctx;
  let row = rowFor(db, userId, date);
  if (onVacation(settings, date)) {
    if (row?.status === 'open') db.prepare("UPDATE daily_quests SET status = 'paused' WHERE user_id = ? AND date = ?").run(userId, date);
    return;
  }
  if (!row) {
    // No quest was ever opened for that day, but one was configured: the day counts as missed.
    const items = buildItems(ctx);
    if (!items.length) return;
    insertRow(db, 'daily_quests', { user_id: userId, date, items: JSON.stringify(items), status: 'open', created_at: nowIso() });
    row = rowFor(db, userId, date);
  }
  if (row.status !== 'open') return;
  const title = settings.penaltyTask;
  if (title) {
    db.prepare("UPDATE daily_quests SET status = 'penalty_open', penalty_task = ?, penalty_due = ? WHERE user_id = ? AND date = ?").run(title, addDays(date, 1), userId, date);
    if (addDays(date, 1) >= clock.today) events.push({ type: 'penalty_open', title, due: addDays(date, 1), missedOn: date });
  } else {
    db.prepare("UPDATE daily_quests SET status = 'penalty_failed' WHERE user_id = ? AND date = ?").run(userId, date);
    breakChain(ctx);
  }
}

/** Settles every finished day since the last time, then lets freezes and broken chains surface. */
function closePastDays(ctx) {
  const { db, userId, clock } = ctx;
  const yesterday = addDays(clock.today, -1);
  const last = ctx.settings.lastClosedOn;
  if (last && last >= yesterday) return;
  if (last) {
    const start = addDays(last, 1) > addDays(yesterday, -MAX_CATCH_UP_DAYS) ? addDays(last, 1) : addDays(yesterday, -MAX_CATCH_UP_DAYS);
    for (let d = start; d <= yesterday; d = addDays(d, 1)) closeDay(ctx, d);
    // A Penalty Quest not cleared by the end of its day is failed, and the chain resets.
    const expired = db.prepare("SELECT date FROM daily_quests WHERE user_id = ? AND status = 'penalty_open' AND penalty_due < ?").all(userId, clock.today);
    for (const { date } of expired) {
      db.prepare("UPDATE daily_quests SET status = 'penalty_failed' WHERE user_id = ? AND date = ?").run(userId, date);
      breakChain(ctx);
    }
    habits.syncAllHabits(ctx);
  }
  ctx.settings = writeSettings(db, userId, { ...ctx.settings, lastClosedOn: yesterday });
}

/**
 * The Daily Quest configurator: which habits and which free-form lines make up every day's quest,
 * and whether a missed day opens a Penalty Quest. One atomic change, so the five slots can be
 * reshuffled (drop a habit, add a line) without a half-applied state. With `applyToday` the open
 * quest for today is rebuilt too, keeping the ticks of lines that are still there.
 */
function configure(ctx, { lines, habitIds, penaltyTask, applyToday }) {
  const { db, userId, clock } = ctx;
  if (lines.length + habitIds.length > habits.QUEST_SLOTS) throw AppError.badRequest(`The Daily Quest holds up to ${habits.QUEST_SLOTS} items`, 'QUEST_FULL');
  if (new Set(habitIds).size !== habitIds.length) throw AppError.badRequest('Each habit can appear once', 'DUPLICATE_ITEM');
  for (const id of habitIds) {
    if (habits.findHabitRow(db, userId, id).archived_at) throw AppError.conflict('An archived habit can’t join the Daily Quest', 'HABIT_ARCHIVED');
  }
  db.prepare('UPDATE habits SET in_daily_quest = 0 WHERE user_id = ? AND in_daily_quest = 1').run(userId);
  for (const id of habitIds) db.prepare('UPDATE habits SET in_daily_quest = 1 WHERE id = ? AND user_id = ?').run(id, userId);
  ctx.settings = writeSettings(db, userId, { ...ctx.settings, dailyQuestTemplate: lines, penaltyTask });

  const row = rowFor(db, userId, clock.today);
  if (applyToday && (!row || ['open', 'paused'].includes(row.status))) {
    const done = new Set(parseJson(row?.items, []).filter((i) => i.done).map((i) => (i.type === 'habit' ? `h:${i.refId}` : `t:${i.title}`)));
    const items = buildItems(ctx).map((i) => ({ ...i, done: done.has(i.type === 'habit' ? `h:${i.refId}` : `t:${i.title}`) }));
    if (row && !items.length) db.prepare('DELETE FROM daily_quests WHERE user_id = ? AND date = ?').run(userId, clock.today);
    else if (row) db.prepare('UPDATE daily_quests SET items = ? WHERE user_id = ? AND date = ?').run(JSON.stringify(items), userId, clock.today);
    else if (items.length) insertRow(db, 'daily_quests', { user_id: userId, date: clock.today, items: JSON.stringify(items), status: onVacation(ctx.settings, clock.today) ? 'paused' : 'open', created_at: nowIso() });
    evaluateQuest(ctx, clock.today);
    progress.settle(db, userId, clock.today, ctx.events);
  }
  return getToday(ctx);
}

module.exports = { configure, getToday, evaluateQuest, toggleItem, setTodayItems, completePenalty, closePastDays, ensureQuest, questView };
