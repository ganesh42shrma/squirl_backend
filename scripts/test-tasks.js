// Tasks module on synthetic in-memory data only: XP and level maths, anti-farming rules, reversal
// idempotency, streaks (cadence, freezes, skips, grace), the Daily Quest and penalty cycle, rank
// Reassessments, achievements, validation, tenant isolation and reset/delete behaviour.
const assert = require('node:assert/strict');
const Database = require('better-sqlite3-multiple-ciphers');
const db = new Database(':memory:');
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports }; };
stub('../src/config/db', { getDb: () => db });
stub('../src/core/logger', { info() {}, warn() {}, error() {} });
stub('../src/plugins/insights/llm.client', {});
stub('../src/plugins/insights/suggestions.worker', { resetForUser() {} });
for (const m of require('../src/config/migrations')) typeof m === 'function' ? m(db) : db.exec(m);
db.pragma('foreign_keys = ON');
const { insertUser } = require('../src/plugins/users/user.model');
const userService = require('../src/plugins/users/user.service');
const { run } = require('../src/plugins/tasks/context');
const tasks = require('../src/plugins/tasks/task.service');
const habits = require('../src/plugins/tasks/habit.service');
const quests = require('../src/plugins/tasks/quest.service');
const hunter = require('../src/plugins/tasks/hunter.service');
const progress = require('../src/plugins/tasks/progress');
const xp = require('../src/plugins/tasks/xp.engine');
const day = require('../src/plugins/tasks/day');
const { evaluateStreak } = require('../src/plugins/tasks/streak.engine');
const schemas = require('../src/plugins/tasks/task.validation');
const { ACHIEVEMENTS } = require('../src/plugins/tasks/achievements');

const a = insertUser(db, { email: 'tasks-a@example.invalid', name: 'Tasks A', passwordHash: 'unused' });
const b = insertUser(db, { email: 'tasks-b@example.invalid', name: 'Tasks B', passwordHash: 'unused' });
// Noon (India) on a calendar day; the default timezone is Asia/Kolkata with a 4 AM day start.
const at = (key, hour = 12, minute = 0) => new Date(`${key}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`);
const call = (user, when, work) => run(user, work, { now: when });
const D = (n) => day.addDays('2026-03-01', n); // D(0) is a Sunday
const xpTotal = (user) => progress.totalXp(db, user);
const events = (r, type) => r.events.filter((e) => e.type === type);
// A task made "long ago" so the two-minute rule doesn't apply to a task the test completes at once.
const seasoned = (id) => db.prepare("UPDATE tasks SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(id);

function engines() {
  // The level curve matches the design table exactly.
  const entry = { D: [10, 1730], C: [20, 7000], B: [35, 23710], A: [50, 52950], S: [65, 96440], N: [85, 178990], X: [100, 260830] };
  for (const [, [level, total]] of Object.entries(entry)) assert.equal(xp.CUMULATIVE[level], total);
  assert.equal(xp.xpToNext(1), 90); assert.equal(xp.xpToNext(10), 350); assert.equal(xp.xpToNext(50), 2440);
  assert.equal(xp.levelFromTotal(0), 1); assert.equal(xp.levelFromTotal(89), 1); assert.equal(xp.levelFromTotal(90), 2);
  assert.equal(xp.levelFromTotal(1729), 9); assert.equal(xp.levelFromTotal(1730), 10); assert.equal(xp.levelFromTotal(10 ** 7), 100);
  assert.equal(xp.levelFromTotal(-50), 1);
  assert.equal(xp.rankForLevel(9).id, 'E'); assert.equal(xp.rankForLevel(10).id, 'D'); assert.equal(xp.rankForLevel(84).id, 'S'); assert.equal(xp.rankForLevel(100).id, 'X');
  assert.deepEqual(xp.levelProgress(100), { level: 2, xpIntoLevel: 10, xpForLevel: xp.xpToNext(2), xpToNext: xp.xpToNext(2) - 10, fraction: 10 / xp.xpToNext(2), maxed: false });

  const base = { difficulty: 'normal', completedOn: '2026-03-02', createdAt: 0, completedAt: 10 ** 9 };
  assert.equal(xp.taskAward({ ...base }).amount, 20);
  assert.equal(xp.taskAward({ ...base, dueDate: '2026-03-02' }).amount, 24, 'on time ×1.2');
  assert.equal(xp.taskAward({ ...base, dueDate: '2026-03-01' }).amount, 20, 'a day late: no bonus, no penalty');
  assert.equal(xp.taskAward({ ...base, dueDate: '2026-02-20' }).amount, 10, 'over 3 days late ×0.5');
  assert.equal(xp.taskAward({ ...base, difficulty: 'boss', subtaskCount: 2 }).tier, 'epic', 'a Boss needs 3 subtasks');
  assert.equal(xp.taskAward({ ...base, difficulty: 'boss', subtaskCount: 3 }).amount, 150);
  assert.equal(xp.taskAward({ ...base, difficulty: 'hard', createdAt: 0, completedAt: 60_000 }).tier, 'trivial', 'two-minute rule');
  assert.equal(xp.taskAward({ ...base, difficulty: 'hard', isSubtask: true }).amount, 20, 'a subtask pays half');
  assert.equal(xp.taskAward({ ...base, echoCount: 20 }).amount, 22, 'Echo bonus caps at +10%');
  assert.equal(xp.habitAward({ difficulty: 'easy', streak: 60 }).amount, 15, 'streak multiplier caps at ×1.5');
  const award = xp.taskAward({ ...base, difficulty: 'easy' });
  assert.equal(xp.applyDailyLimits(award, { dayXp: 0, lowTierCount: 15 }).amount, 1, 'after 15 low-tier completions each pays 1');
  assert.equal(xp.applyDailyLimits(xp.taskAward(base), { dayXp: 600, lowTierCount: 0 }).amount, 5, 'over the cap pays ×0.25');
  assert.equal(xp.applyDailyLimits(xp.taskAward(base), { dayXp: 590, lowTierCount: 0 }).crossedCap, true);

  // Dates: the day starts at 4 AM local, so 1 AM still belongs to yesterday.
  const s = { timezone: 'Asia/Kolkata', dayStartHour: 4 };
  assert.equal(day.dayKey(at('2026-03-02', 1), s), '2026-03-01'); assert.equal(day.dayKey(at('2026-03-02', 4), s), '2026-03-02');
  assert.equal(day.dayEndsAt(at('2026-03-02', 12), s).toISOString(), at('2026-03-03', 4).toISOString());
  assert.equal(day.isoWeekday('2026-03-01'), 7); assert.equal(day.weekStart('2026-03-01'), '2026-02-23'); assert.equal(day.monthEnd('2026-02-10'), '2026-02-28');
  assert.equal(day.isValidTimezone('Mars/Base'), false);

  // Streaks.
  const habit = (extra = {}) => ({ cadence: 'daily', days_mask: 127, target_per_period: 1, every_n: null, target_quantity: null, start_date: D(0), freeze_max: 2, ...extra });
  const done = (offsets) => offsets.map((n) => ({ date: D(n), kind: 'done', quantity: null }));
  const seq = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  assert.equal(evaluateStreak(habit(), done(seq(0, 9)), { today: D(10) }).current, 10, 'an open day with nothing yet does not break the streak');
  assert.equal(evaluateStreak(habit(), done(seq(0, 9)), { today: D(10) }).doneToday, false);
  assert.equal(evaluateStreak(habit(), done([...seq(0, 3), ...seq(5, 9)]), { today: D(10) }).current, 5, 'a miss resets without a freeze');
  const frozen = evaluateStreak(habit(), done([...seq(0, 6), ...seq(8, 9)]), { today: D(10) });
  assert.deepEqual([frozen.current, frozen.freezes, frozen.freezesUsedOn], [9, 0, [D(7)]], 'a freeze earned at 7 absorbs the miss');
  assert.equal(evaluateStreak(habit({ freeze_max: 0 }), done([...seq(0, 6), ...seq(8, 9)]), { today: D(10) }).current, 2, 'no freezes when freeze_max is 0');
  assert.equal(evaluateStreak(habit(), [...done(seq(0, 3)), { date: D(4), kind: 'skip' }, ...done(seq(5, 6))], { today: D(7) }).current, 6, 'a rest day is neutral');
  assert.equal(evaluateStreak(habit(), done([...seq(0, 3), ...seq(6, 9)]), { today: D(10), vacation: { from: D(4), until: D(5) } }).current, 8, 'vacation days are neutral');
  // weekdays: Mon-Fri only (mask 31). D(0) is a Sunday, so D(1)=Mon ... D(5)=Fri; weekend is neutral.
  const weekdays = habit({ cadence: 'weekdays', days_mask: 31, start_date: D(1) });
  assert.equal(evaluateStreak(weekdays, done([1, 2, 3, 4, 5, 8, 9]), { today: D(10) }).current, 7, 'weekends do not break a weekday habit');
  // 3 times a week: counts consecutive successful ISO weeks; D(1) starts week 1 (Mon).
  const thrice = habit({ cadence: 'times_per_week', target_per_period: 3, start_date: D(1) });
  const weekly = evaluateStreak(thrice, done([1, 3, 5, 8, 9, 11, 15]), { today: D(16) });
  assert.equal(weekly.current, 2, 'two full weeks, and the third week is still open');
  assert.equal(evaluateStreak(thrice, done([1, 3, 5, 8]), { today: D(16) }).current, 0, 'week two fell short');
  assert.equal(evaluateStreak(thrice, done([8, 9, 10]), { today: D(16) }).current, 1, 'a week that already reached its target counts while it is open');
  // every 3 days
  const every3 = habit({ cadence: 'every_n_days', every_n: 3 });
  assert.equal(evaluateStreak(every3, done([0, 4, 6, 9]), { today: D(12) }).current, 4);
  // quantity target: 8 glasses
  const water = habit({ target_quantity: 8 });
  assert.equal(evaluateStreak(water, [{ date: D(0), kind: 'done', quantity: 5 }], { today: D(1) }).current, 0, 'a partial amount is not a success');
  assert.equal(evaluateStreak(water, [{ date: D(0), kind: 'done', quantity: 8 }], { today: D(1) }).current, 1);
}

function tasksAndXp() {
  const t1 = call(a, at(D(1)), (ctx) => tasks.createTask(ctx, { title: 'File taxes', difficulty: 'hard', stat: 'per', dueDate: D(1) }));
  seasoned(t1.data._id);
  assert.equal(xpTotal(a), 0, 'creating a task pays nothing');
  const done = call(a, at(D(1)), (ctx) => tasks.completeTask(ctx, t1.data._id));
  assert.equal(done.data.status, 'done'); assert.equal(done.data.xpAwarded, 48, 'Hard 40 × 1.2 on time');
  assert.equal(xpTotal(a), 48 + 25, 'plus First Step (25)');
  assert.deepEqual(events(done, 'achievement').map((e) => e.id), ['first_step']);
  assert.equal(events(done, 'xp')[0].amount, 48);
  const again = call(a, at(D(1)), (ctx) => tasks.completeTask(ctx, t1.data._id));
  assert.equal(xpTotal(a), 73, 'completing twice pays once'); assert.equal(events(again, 'xp').length, 0);
  // Un-complete writes a reversal; completing again the same day restores the very same award.
  const reopened = call(a, at(D(1)), (ctx) => tasks.reopenTask(ctx, t1.data._id));
  assert.equal(reopened.data.status, 'open'); assert.equal(events(reopened, 'xp')[0].amount, -48);
  assert.equal(xpTotal(a), 25, 'achievement XP stays, the task XP is reversed');
  call(a, at(D(1)), (ctx) => tasks.completeTask(ctx, t1.data._id));
  assert.equal(xpTotal(a), 73, 'toggling cannot farm XP');
  assert.equal(db.prepare("SELECT count(*) FROM xp_events WHERE user_id = ? AND dedupe_key = ?").pluck().get(a, `task:${t1.data._id}`), 1);
  assert.equal(db.prepare("SELECT count(*) FROM xp_events WHERE user_id = ? AND reason = 'reversal'").pluck().get(a), 0, 'restoring removes the reversal row');
  assert.throws(() => call(a, at(D(1)), (ctx) => tasks.updateTask(ctx, t1.data._id, { difficulty: 'easy' })), /locked/);

  // Overdue by more than 3 days halves it; a task finished within two minutes is Trivial at most.
  const late = call(a, at(D(1)), (ctx) => tasks.createTask(ctx, { title: 'Old chore', difficulty: 'normal', dueDate: D(-10) })).data;
  seasoned(late._id);
  assert.equal(call(a, at(D(1)), (ctx) => tasks.completeTask(ctx, late._id)).data.xpAwarded, 10);
  const quick = call(a, at(D(1)), (ctx) => tasks.createTask(ctx, { title: 'Fast', difficulty: 'epic' })).data;
  assert.equal(call(a, at(D(1)), (ctx) => tasks.completeTask(ctx, quick._id)).data.xpAwarded, 5);

  // Subtasks, checklists, Boss rule.
  const boss = call(a, at(D(2)), (ctx) => tasks.createTask(ctx, { title: 'Launch', difficulty: 'boss' })).data;
  const sub = (title) => call(a, at(D(2)), (ctx) => tasks.createTask(ctx, { title, parentId: boss._id, difficulty: 'easy' })).data;
  const s1 = sub('One'); sub('Two');
  assert.throws(() => call(a, at(D(2)), (ctx) => tasks.createTask(ctx, { title: 'Deep', parentId: s1._id })), /Subtasks can’t have subtasks/);
  seasoned(boss._id);
  assert.equal(call(a, at(D(2)), (ctx) => tasks.getTask(ctx, boss._id)).data.subtasks.length, 2);
  const item = call(a, at(D(2)), (ctx) => tasks.addChecklistItem(ctx, boss._id, { text: 'Draft' })).data.checklist[0];
  const ticked = call(a, at(D(2)), (ctx) => tasks.updateChecklistItem(ctx, item._id, { done: true }));
  assert.equal(events(ticked, 'xp')[0].amount, 1);
  const unticked = call(a, at(D(2)), (ctx) => tasks.updateChecklistItem(ctx, item._id, { done: false }));
  assert.equal(events(unticked, 'xp')[0].amount, -1);
  assert.equal(call(a, at(D(2)), (ctx) => tasks.completeTask(ctx, boss._id)).data.xpAwarded, 80, 'only 2 subtasks: paid as Epic, not Boss');
  seasoned(s1._id);
  assert.equal(call(a, at(D(2)), (ctx) => tasks.completeTask(ctx, s1._id)).data.xpAwarded, 5, 'a subtask pays half of Easy');

  // Recurring: completing one spawns the next, with its checklist reset.
  const rec = call(a, at(D(3)), (ctx) => tasks.createTask(ctx, { title: 'Water plants', difficulty: 'easy', dueDate: D(3), repeat: { freq: 'weekly', interval: 1 } })).data;
  call(a, at(D(3)), (ctx) => tasks.addChecklistItem(ctx, rec._id, { text: 'Balcony' }));
  seasoned(rec._id);
  const spawned = call(a, at(D(3)), (ctx) => tasks.completeTask(ctx, rec._id));
  assert.equal(events(spawned, 'recurring').length, 1);
  const next = call(a, at(D(3)), (ctx) => tasks.listTasks(ctx, { status: 'open', search: 'water', page: 1, limit: 10 })).data.items[0];
  assert.equal(next.dueDate, D(10)); assert.equal(next.checklist.length, 1); assert.equal(next.checklist[0].done, false);
  assert.equal(tasks.nextOccurrence({ freq: 'monthly', interval: 1 }, '2026-01-31'), '2026-02-28');
  assert.equal(tasks.nextOccurrence({ freq: 'weekly', interval: 1, days: [1, 3] }, '2026-03-02'), '2026-03-04');
  assert.equal(tasks.nextOccurrence({ freq: 'weekly', interval: 2, days: [1] }, '2026-03-02'), '2026-03-16');
  assert.equal(tasks.nextOccurrence({ freq: 'daily', interval: 3 }, '2026-03-02'), '2026-03-05');
}

function limits() {
  // 15 Trivial/Easy completions in a day, then each pays 1 XP. Fresh account so counts are clean.
  const c = insertUser(db, { email: 'tasks-c@example.invalid', name: 'Tasks C', passwordHash: 'unused' });
  const amounts = [];
  for (let i = 0; i < 17; i += 1) {
    const t = call(c, at(D(1)), (ctx) => tasks.createTask(ctx, { title: `Small ${i}`, difficulty: 'easy' })).data;
    seasoned(t._id);
    amounts.push(call(c, at(D(1)), (ctx) => tasks.completeTask(ctx, t._id)).data.xpAwarded);
  }
  assert.deepEqual(amounts.slice(0, 15), Array(15).fill(10)); assert.deepEqual(amounts.slice(15), [1, 1]);
  // The daily soft cap: epics until the 600 XP mark, then ×0.25, with one warning at the crossing.
  const warned = [];
  const paid = [];
  for (let i = 0; i < 9; i += 1) {
    const t = call(c, at(D(2)), (ctx) => tasks.createTask(ctx, { title: `Epic ${i}`, difficulty: 'epic' })).data;
    seasoned(t._id);
    const r = call(c, at(D(2)), (ctx) => tasks.completeTask(ctx, t._id));
    paid.push(r.data.xpAwarded); warned.push(...events(r, 'warning'));
  }
  assert.deepEqual(paid, [80, 80, 80, 80, 80, 80, 80, 80, 20], 'the ninth epic is past the 600 cap');
  assert.equal(warned.length, 1);
  assert.equal(call(c, at(D(2)), (ctx) => hunter.overview(ctx)).data.dailyCap.cap, 600);
}

function habitFlow() {
  const h = call(a, at(D(1)), (ctx) => habits.createHabit(ctx, { name: 'Read 20 pages', difficulty: 'easy', stat: 'int', startDate: D(1) })).data;
  const checkIn = (n, extra = {}) => call(a, at(D(n)), (ctx) => habits.checkIn(ctx, h._id, extra));
  const results = [];
  for (let n = 1; n <= 7; n += 1) results.push(checkIn(n));
  assert.equal(results[0].data.currentStreak, 1); assert.equal(results[0].data.doneToday, true);
  const seventh = results[6];
  assert.equal(seventh.data.currentStreak, 7);
  assert.ok(events(seventh, 'streak').some((e) => e.value === 7 && e.milestone), 'a 7-day streak is a milestone');
  assert.ok(events(seventh, 'xp').some((e) => e.reason === 'streak_milestone' && e.amount === 50));
  assert.equal(db.prepare("SELECT count(*) FROM xp_events WHERE user_id = ? AND reason = 'streak_milestone'").pluck().get(a), 1);
  assert.deepEqual(checkIn(7).events.filter((e) => e.type === 'xp'), [], 'checking in again the same day pays nothing');
  // Day 8 is missed; the freeze earned at day 7 absorbs it, and the streak carries on.
  const day9 = checkIn(9);
  assert.equal(day9.data.currentStreak, 8); assert.equal(day9.data.freezesHeld, 0);
  assert.equal(events(day9, 'streak_protected').length, 1, 'the toast for a spent freeze');
  // Yesterday can still be checked in; two days back cannot.
  assert.throws(() => call(a, at(D(11)), (ctx) => habits.checkIn(ctx, h._id, { date: D(9) })), /Only today and yesterday/);
  assert.throws(() => call(a, at(D(11)), (ctx) => habits.checkIn(ctx, h._id, { date: D(12) })), /hasn’t happened yet/);
  const late = call(a, at(D(11), 9), (ctx) => habits.checkIn(ctx, h._id, { date: D(10) }));
  assert.equal(late.data.currentStreak, 9, 'late check-in for yesterday keeps the streak');
  // Undo reverses that day's XP; the streak recomputes.
  const before = xpTotal(a);
  const undone = call(a, at(D(11), 9), (ctx) => habits.undoCheckIn(ctx, h._id, D(10)));
  assert.equal(undone.data.currentStreak, 0, 'with the day gone and no freeze left the streak is broken'); assert.ok(xpTotal(a) < before);
  // Skips: one rest day a week by default.
  const rest = call(a, at(D(11), 10), (ctx) => habits.checkIn(ctx, h._id, { date: D(10), kind: 'skip' }));
  assert.equal(rest.data.days.at(-2).state, 'skip');
  assert.throws(() => call(a, at(D(11), 10), (ctx) => habits.checkIn(ctx, h._id, { date: D(11), kind: 'skip' })), /No rest days left/);
  // A quantity habit only succeeds at its target.
  const water = call(a, at(D(12)), (ctx) => habits.createHabit(ctx, { name: 'Water', targetQuantity: 8, unit: 'glasses', startDate: D(12) })).data;
  assert.equal(call(a, at(D(12)), (ctx) => habits.checkIn(ctx, water._id, { quantity: 5 })).data.doneToday, false);
  assert.equal(call(a, at(D(12)), (ctx) => habits.checkIn(ctx, water._id, { quantity: 8 })).data.doneToday, true);
  // Echo binding needs 66.
  assert.throws(() => call(a, at(D(12)), (ctx) => habits.bindEcho(ctx, h._id)), /66/);
  const veteran = call(a, at(D(12)), (ctx) => habits.createHabit(ctx, { name: 'Meditate', startDate: D(-90) })).data;
  for (let n = -80; n <= 11; n += 1) db.prepare("INSERT INTO habit_checkins (id, habit_id, user_id, date, kind, created_at) VALUES (?, ?, ?, ?, 'done', ?)").run(`seed-${n}`, veteran._id, a, D(n), new Date().toISOString());
  assert.equal(call(a, at(D(12)), (ctx) => habits.getHabit(ctx, veteran._id)).data.canBind, true);
  assert.equal(events(call(a, at(D(12)), (ctx) => habits.bindEcho(ctx, veteran._id)), 'echo_bound').length, 1);
  assert.throws(() => call(a, at(D(12)), (ctx) => habits.bindEcho(ctx, veteran._id)), /already an Echo/);
  assert.equal(call(a, at(D(12)), (ctx) => hunter.profileView(ctx)).data.echoBonusPct, 1);
  // Validation of cadence rules.
  assert.equal(schemas.createHabit.safeParse({ body: { name: 'x', cadence: 'every_n_days' } }).success, false);
  assert.equal(schemas.createHabit.safeParse({ body: { name: 'x', cadence: 'times_per_week', targetPerPeriod: 9 } }).success, false);
  assert.equal(schemas.createHabit.safeParse({ body: { name: 'x', targetQuantity: 3 } }).success, false, 'a quantity needs a unit');
  assert.equal(schemas.createHabit.safeParse({ body: { name: 'x', cadence: 'times_per_week', targetPerPeriod: 3 } }).success, true);
}

function questFlow() {
  const u = insertUser(db, { email: 'tasks-q@example.invalid', name: 'Quest', passwordHash: 'unused' });
  const q1 = call(u, at(D(20)), (ctx) => quests.getToday(ctx)).data;
  assert.equal(q1.status, 'open'); assert.equal(q1.items.length, 4); assert.equal(q1.chain, 0);
  let last;
  for (const item of q1.items) last = call(u, at(D(20)), (ctx) => quests.toggleItem(ctx, item.key));
  assert.equal(last.data.status, 'cleared');
  assert.deepEqual(events(last, 'daily_quest_cleared').map((e) => [e.chain, e.xp]), [[1, 50]]);
  assert.throws(() => call(u, at(D(20)), (ctx) => quests.toggleItem(ctx, 'c0')), /already settled/);
  // Day 21 is left alone. Day 22 opens a Penalty Quest for it.
  call(u, at(D(21)), (ctx) => quests.getToday(ctx));
  const d22 = call(u, at(D(22)), (ctx) => quests.getToday(ctx));
  assert.equal(events(d22, 'penalty_open').length, 1); assert.equal(d22.data.penalty.title, 'Extra 20-minute walk'); assert.equal(d22.data.chain, 1, 'the chain is on hold, not broken');
  const cleared = call(u, at(D(22)), (ctx) => quests.completePenalty(ctx));
  assert.equal(events(cleared, 'penalty_cleared').length, 1); assert.equal(cleared.data.penalty, null); assert.equal(cleared.data.chain, 1);
  assert.equal(xpTotal(u) >= 50 + 20, true);
  // Day 22's own quest is missed and so is day 23's penalty: the chain resets, XP is untouched.
  call(u, at(D(23)), (ctx) => quests.getToday(ctx));
  const xpBefore = xpTotal(u);
  const d25 = call(u, at(D(25)), (ctx) => quests.getToday(ctx));
  assert.equal(events(d25, 'daily_chain_broken').length >= 1, true); assert.equal(d25.data.chain, 0); assert.equal(xpTotal(u), xpBefore);
  // Vacation pauses the quest instead of failing it.
  call(u, at(D(25)), (ctx) => tasks.updateSettings(ctx, { vacationUntil: D(28) }));
  const away = call(u, at(D(26)), (ctx) => quests.getToday(ctx)).data;
  assert.equal(away.status, 'paused'); assert.equal(away.onVacation, true);
  const back = call(u, at(D(29)), (ctx) => quests.getToday(ctx));
  assert.equal(events(back, 'penalty_open').length, 0, 'days on vacation open no penalty');
  // Settings validation and quest slots.
  call(u, at(D(29)), (ctx) => habits.createHabit(ctx, { name: 'Fifth', inDailyQuest: true })); // 4 lines + 1 habit fills the quest
  assert.throws(() => call(u, at(D(29)), (ctx) => habits.createHabit(ctx, { name: 'Sixth', inDailyQuest: true })), /five items/);
  assert.equal(schemas.updateSettings.safeParse({ body: { timezone: 'Mars/Base' } }).success, false);
  assert.equal(schemas.updateSettings.safeParse({ body: { dayStartHour: 12 } }).success, false);
  assert.equal(call(u, at(D(29)), (ctx) => quests.setTodayItems(ctx, [{ type: 'custom', title: 'Just one' }])).data.items.length, 1);
  configurator();
}

// The Daily Quest configurator: habits and lines share five slots, applied atomically.
function configurator() {
  const u = insertUser(db, { email: 'tasks-cfg@example.invalid', name: 'Config', passwordHash: 'unused' });
  const other = insertUser(db, { email: 'tasks-cfg2@example.invalid', name: 'Config 2', passwordHash: 'unused' });
  const read = call(u, at(D(50)), (ctx) => habits.createHabit(ctx, { name: 'Read', startDate: D(50) })).data;
  const walk = call(u, at(D(50)), (ctx) => habits.createHabit(ctx, { name: 'Walk', startDate: D(50) })).data;
  const foreign = call(other, at(D(50)), (ctx) => habits.createHabit(ctx, { name: 'Not yours', startDate: D(50) })).data;
  const cfg = (body, user = u) => call(user, at(D(50)), (ctx) => quests.configure(ctx, { applyToday: true, penaltyTask: 'Extra walk', ...body }));
  const today = (user = u) => call(user, at(D(50)), (ctx) => quests.getToday(ctx)).data;

  // Open today's default quest (4 lines), tick one, then reshape it: 1 habit + 2 lines, keeping the tick.
  const first = today().items.find((i) => i.title === 'Read 10 pages');
  call(u, at(D(50)), (ctx) => quests.toggleItem(ctx, first.key));
  const reshaped = cfg({ lines: ['Read 10 pages', 'Stretch'], habitIds: [read._id] });
  assert.deepEqual(reshaped.data.items.map((i) => [i.type, i.title, i.done]), [['habit', 'Read', false], ['custom', 'Read 10 pages', true], ['custom', 'Stretch', false]], 'today is rebuilt and the tick on a kept line survives');
  // Swapping within a full quest works in one call (the old two-step flow would trip the limit).
  assert.equal(cfg({ lines: ['a', 'b', 'c'], habitIds: [walk._id, read._id] }).data.items.length, 5);
  assert.equal(cfg({ lines: ['a', 'b', 'c', 'd'], habitIds: [walk._id] }).data.items.length, 5);
  assert.deepEqual(db.prepare('SELECT name FROM habits WHERE user_id = ? AND in_daily_quest = 1').pluck().all(u), ['Walk'], 'only the chosen habits are flagged');
  // Limits and ownership.
  assert.throws(() => cfg({ lines: ['a', 'b', 'c', 'd'], habitIds: [walk._id, read._id] }), /up to 5 items/);
  assert.throws(() => cfg({ lines: [], habitIds: [foreign._id] }), /not found/);
  assert.equal(db.prepare('SELECT in_daily_quest FROM habits WHERE id = ?').pluck().get(foreign._id), 0);
  assert.throws(() => cfg({ lines: [], habitIds: [walk._id, walk._id] }), /once/);
  assert.equal(schemas.configureQuest.safeParse({ body: { lines: ['1', '2', '3'], habitIds: [walk._id, read._id, read._id], penaltyTask: '' } }).success, false);
  assert.equal(schemas.configureQuest.safeParse({ body: { lines: [''], habitIds: [], penaltyTask: '' } }).success, false, 'a blank line is rejected');
  // Penalty off: a missed day then resets the chain at once, and the setting is stored.
  cfg({ lines: ['Only line'], habitIds: [], penaltyTask: '' });
  assert.equal(call(u, at(D(50)), (ctx) => tasks.getSettings(ctx)).data.penaltyTask, '');
  // applyToday=false leaves today's quest alone; an empty quest removes today's row.
  assert.equal(cfg({ lines: ['x', 'y'], habitIds: [], applyToday: false }).data.items.length, 1);
  assert.equal(cfg({ lines: [], habitIds: [] }).data.status, 'none');
  // A settled (cleared) quest is never rewritten.
  cfg({ lines: ['Solo'], habitIds: [] });
  call(u, at(D(50)), (ctx) => quests.toggleItem(ctx, today().items[0].key));
  assert.equal(today().status, 'cleared');
  assert.equal(cfg({ lines: ['Changed'], habitIds: [] }).data.items[0].title, 'Solo');
  assert.equal(call(u, at(D(51)), (ctx) => hunter.overview(ctx)).data.quest.items[0].title, 'Changed', 'tomorrow starts from the new configuration');
  // Another account's quest is unaffected throughout.
  assert.equal(today(other).items.length, 4);
}

function ranksAndAwards() {
  const u = insertUser(db, { email: 'tasks-r@example.invalid', name: 'Rank', passwordHash: 'unused' });
  call(u, at(D(30)), (ctx) => hunter.overview(ctx));
  // Push XP to level 10 directly, then settle: a Reassessment opens, the rank does not change yet.
  db.prepare("INSERT INTO xp_events (id, user_id, amount, reason, dedupe_key, occurred_on, created_at) VALUES ('seed-1', ?, 1730, 'achievement', 'seed:1', ?, ?)").run(u, D(30), new Date().toISOString());
  const opened = call(u, at(D(30)), (ctx) => { progress.settle(ctx.db, u, ctx.clock.today, ctx.events); return hunter.profileView(ctx); });
  assert.equal(opened.data.level, 10); assert.equal(opened.data.rank.id, 'E'); assert.equal(opened.data.trial.rank, 'D');
  assert.deepEqual(events(opened, 'level_up').map((e) => e.level), [10]); assert.deepEqual(events(opened, 'rank_trial_open').map((e) => e.rank), ['D']);
  assert.equal(opened.data.trial.ready, false);
  assert.throws(() => call(u, at(D(30)), (ctx) => hunter.claimTrial(ctx)), /conditions/);
  // Meet it: the Daily Quest cleared on 5 of the last 7 days.
  for (let i = 0; i < 5; i += 1) db.prepare("INSERT INTO daily_quests (user_id, date, items, status, cleared_at, created_at) VALUES (?, ?, '[]', 'cleared', ?, ?)").run(u, D(24 + i), new Date().toISOString(), new Date().toISOString());
  const claimed = call(u, at(D(30)), (ctx) => hunter.claimTrial(ctx));
  assert.equal(claimed.data.rank.id, 'D'); assert.equal(claimed.data.trial, null);
  assert.deepEqual(events(claimed, 'rank_up').map((e) => e.rank), ['D']); assert.ok(events(claimed, 'achievement').some((e) => e.id === 'rank_d'));
  assert.equal(call(u, at(D(30)), (ctx) => hunter.profileView(ctx)).data.nextRank.id, 'C');
  // Titles need the achievement; leveling never repeats a toast for a level already reached.
  assert.throws(() => call(u, at(D(30)), (ctx) => hunter.setTitle(ctx, { title: 'centurion' })), /earned/);
  assert.equal(call(u, at(D(30)), (ctx) => hunter.setTitle(ctx, { title: 'rank_d' })).data.title.name, 'D-Rank Hunter');
  const catalogue = call(u, at(D(30)), (ctx) => hunter.achievements(ctx)).data;
  assert.equal(catalogue.total, ACHIEVEMENTS.length); assert.ok(catalogue.items.find((i) => i.id === 'first_step').progress.target === 1);
  assert.equal(call(u, at(D(30)), (ctx) => hunter.xpSeries(ctx, {})).data.total > 0, true);
}

function isolationAndLifecycle() {
  // Another account can't see, change or complete the first account's data.
  const mine = call(a, at(D(40)), (ctx) => tasks.createTask(ctx, { title: 'Private errand' })).data;
  assert.throws(() => call(b, at(D(40)), (ctx) => tasks.getTask(ctx, mine._id)), /not found/);
  assert.throws(() => call(b, at(D(40)), (ctx) => tasks.completeTask(ctx, mine._id)), /not found/);
  assert.throws(() => call(b, at(D(40)), (ctx) => tasks.createTask(ctx, { title: 'x', parentId: mine._id })), /not found/);
  const list = call(a, at(D(40)), (ctx) => tasks.createList(ctx, { name: 'Home' })).data;
  assert.throws(() => call(b, at(D(40)), (ctx) => tasks.createTask(ctx, { title: 'x', listId: list._id })), /List not found/);
  assert.equal(call(b, at(D(40)), (ctx) => tasks.listTasks(ctx, { page: 1, limit: 50 })).data.items.length, 0);
  assert.equal(call(b, at(D(40)), (ctx) => habits.listHabits(ctx)).data.length, 0);
  assert.equal(call(b, at(D(40)), (ctx) => hunter.overview(ctx)).data.profile.totalXp, 0);
  // Deleting a list returns its tasks to the inbox.
  const inList = call(a, at(D(40)), (ctx) => tasks.createTask(ctx, { title: 'In a list', listId: list._id })).data;
  call(a, at(D(40)), (ctx) => tasks.deleteList(ctx, list._id));
  assert.equal(call(a, at(D(40)), (ctx) => tasks.getTask(ctx, inList._id)).data.listId, undefined);
  // Validation.
  for (const bad of [{ title: '' }, { title: 'x', difficulty: 'godlike' }, { title: 'x', dueDate: '2026-13-40' }, { title: 'x', priority: 9 }, { title: 'x', repeat: { freq: 'hourly' } }]) {
    assert.equal(schemas.createTask.safeParse({ body: bad }).success, false, JSON.stringify(bad));
  }
  assert.equal(schemas.createTask.safeParse({ body: { title: 'ok', difficulty: 'boss', dueDate: '2026-03-04', repeat: { freq: 'weekly', days: [1, 3] } } }).success, true);
  // A financial reset leaves Tasks alone (it only archives the financial tables).
  const rowsBefore = db.prepare('SELECT (SELECT count(*) FROM tasks WHERE user_id = ?) + (SELECT count(*) FROM habits WHERE user_id = ?) + (SELECT count(*) FROM xp_events WHERE user_id = ?) AS n').get(a, a, a).n;
  assert.ok(rowsBefore > 10);
  return userService.resetFinancialData(a).then(() => {
    const rowsAfter = db.prepare('SELECT (SELECT count(*) FROM tasks WHERE user_id = ?) + (SELECT count(*) FROM habits WHERE user_id = ?) + (SELECT count(*) FROM xp_events WHERE user_id = ?) AS n').get(a, a, a).n;
    assert.equal(rowsAfter, rowsBefore, 'financial reset does not touch Tasks');
    assert.equal(call(a, at(D(41)), (ctx) => hunter.profileView(ctx)).data.totalXp > 0, true);
    // Deleting the account removes everything through the cascades, without orphans.
    // The same explicit order deleteAccount() uses for the financial tables (RESTRICT links); Tasks relies on cascades alone.
    for (const sql of ['DELETE FROM goals WHERE user_id = ?', 'DELETE FROM transactions WHERE user_id = ?', 'DELETE FROM merchant_rules WHERE user_id = ?', 'DELETE FROM merchant_suggestions WHERE user_id = ?', 'DELETE FROM commitments WHERE user_id = ?', 'DELETE FROM imports WHERE user_id = ?', 'DELETE FROM tags WHERE user_id = ?', 'DELETE FROM categories WHERE user_id = ? AND parent_id IS NOT NULL', 'DELETE FROM categories WHERE user_id = ?', 'DELETE FROM users WHERE id = ?']) db.prepare(sql).run(a);
    for (const table of ['tasks', 'task_lists', 'task_checklist_items', 'habits', 'habit_checkins', 'daily_quests', 'xp_events', 'hunter_profiles', 'user_achievements']) {
      assert.equal(db.prepare(`SELECT count(*) FROM ${table} WHERE user_id = ?`).pluck().get(a), 0, `${table} cleared with the account`);
    }
    assert.equal(db.pragma('foreign_key_check').length, 0);
  });
}

async function main() {
  engines();
  tasksAndXp();
  limits();
  habitFlow();
  questFlow();
  ranksAndAwards();
  await isolationAndLifecycle();
  console.log('Passed: level curve and ranks, XP rules and anti-farming, reversal idempotency, recurrence, streak cadences/freezes/skips/grace, Daily Quest and penalty cycle, Reassessment, achievements, validation, tenant isolation and reset/delete.');
}
main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => db.close());
