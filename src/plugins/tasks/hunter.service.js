// The "hunter" side: profile, level and rank, stats, the overview that feeds the dashboard widgets,
// achievements, the XP calendar and Reassessment claims.
const AppError = require('../../core/AppError');
const xp = require('./xp.engine');
const progress = require('./progress');
const habits = require('./habit.service');
const quests = require('./quest.service');
const { BY_ID } = require('./achievements');
const { addDays } = require('./day');
const { parseJson } = require('./task.model');

const STAT_NAMES = { str: 'Strength', vit: 'Vitality', agi: 'Agility', int: 'Intellect', per: 'Perception', cha: 'Charisma' };

function profileView(ctx) {
  const { db, userId, clock } = ctx;
  const row = progress.ensureProfile(db, userId);
  const level = xp.levelProgress(row.total_xp);
  const rank = xp.RANKS[xp.rankIndex(row.rank)];
  const nextRank = xp.RANKS[xp.rankIndex(row.rank) + 1];
  const statXp = Object.fromEntries(xp.STATS.map((k) => [k, 0]));
  for (const r of db.prepare('SELECT stat, sum(amount) AS xp FROM xp_events WHERE user_id = ? AND stat IS NOT NULL GROUP BY stat').all(userId)) if (r.stat in statXp) statXp[r.stat] = Math.max(0, r.xp);
  const echoes = progress.echoCount(db, userId);
  const title = row.title && BY_ID.get(row.title);
  return {
    totalXp: row.total_xp,
    ...level,
    peakLevel: row.peak_level,
    rank: { id: rank.id, name: rank.name },
    nextRank: nextRank ? { id: nextRank.id, name: nextRank.name, minLevel: nextRank.minLevel } : undefined,
    eligibleRank: xp.rankForLevel(level.level).id,
    title: title ? { id: title.id, name: title.name } : undefined,
    stats: xp.STATS.map((k) => ({ id: k, name: STAT_NAMES[k], xp: statXp[k], value: Math.floor(statXp[k] / 100) })),
    chain: row.daily_chain,
    longestChain: row.longest_daily_chain,
    echoes,
    echoBonusPct: Math.round(xp.echoBonus(echoes) * 100),
    trial: progress.trialView(db, userId, parseJson(row.trial, null), clock.today),
  };
}

/** One call for the Hunter card, today's quest, task counts and habit status. Feeds the dashboard widgets. */
function overview(ctx) {
  const { db, userId, clock, settings } = ctx;
  const { today } = clock;
  const count = (sql, ...args) => db.prepare(sql).pluck().get(userId, ...args);
  const habitViews = habits.listHabits(ctx);
  const ledger = progress.dayLedger(db, userId, today);
  const recent = db.prepare('SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = ? AND unlocked_at IS NOT NULL ORDER BY unlocked_at DESC LIMIT 3').all(userId)
    .map((r) => ({ id: r.achievement_id, name: BY_ID.get(r.achievement_id)?.name, rarity: BY_ID.get(r.achievement_id)?.rarity, unlockedAt: r.unlocked_at }))
    .filter((a) => a.name);
  return {
    profile: profileView(ctx),
    quest: quests.getToday(ctx),
    tasks: {
      dueToday: count("SELECT count(*) FROM active_tasks WHERE user_id = ? AND parent_id IS NULL AND status = 'open' AND due_date = ?", today),
      overdue: count("SELECT count(*) FROM active_tasks WHERE user_id = ? AND parent_id IS NULL AND status = 'open' AND due_date < ?", today),
      doneToday: count("SELECT count(*) FROM active_tasks WHERE user_id = ? AND parent_id IS NULL AND completed_on = ?", today),
      open: count("SELECT count(*) FROM active_tasks WHERE user_id = ? AND parent_id IS NULL AND status = 'open'"),
    },
    habits: {
      total: habitViews.length,
      dueToday: habitViews.filter((h) => h.scheduledToday && !h.doneToday && !h.skippedToday && !h.period?.complete).length,
      doneToday: habitViews.filter((h) => h.doneToday).length,
      best: habitViews.reduce((b, h) => (h.currentStreak > (b?.currentStreak ?? 0) ? h : b), null)?._id,
    },
    xpToday: count('SELECT ifnull(sum(amount), 0) FROM xp_events WHERE user_id = ? AND occurred_on = ?', today),
    dailyCap: { cap: settings.dailyCap, used: Math.max(0, ledger.dayXp) },
    recentAwards: recent,
    date: today,
  };
}

function xpSeries(ctx, { from, to }) {
  const { db, userId, clock } = ctx;
  const end = to || clock.today;
  const start = from || addDays(end, -83);
  const days = db
    .prepare('SELECT occurred_on AS date, sum(amount) AS xp FROM xp_events WHERE user_id = ? AND occurred_on >= ? AND occurred_on <= ? GROUP BY occurred_on ORDER BY occurred_on')
    .all(userId, start, end)
    .map((d) => ({ date: d.date, xp: Math.max(0, d.xp) }));
  return { from: start, to: end, days, total: days.reduce((n, d) => n + d.xp, 0) };
}

function achievements(ctx) {
  const items = progress.catalogue(ctx.db, ctx.userId);
  return { items, unlocked: items.filter((a) => a.unlockedAt).length, total: items.length };
}

function setTitle(ctx, { title }) {
  const { db, userId } = ctx;
  if (title) {
    const unlocked = db.prepare('SELECT 1 FROM user_achievements WHERE user_id = ? AND achievement_id = ? AND unlocked_at IS NOT NULL').get(userId, title);
    if (!unlocked || !BY_ID.has(title)) throw AppError.badRequest('You can only wear a title you’ve earned', 'TITLE_LOCKED');
  }
  progress.ensureProfile(db, userId);
  db.prepare('UPDATE hunter_profiles SET title = ? WHERE user_id = ?').run(title ?? null, userId);
  return profileView(ctx);
}

function claimTrial(ctx) {
  const { db, userId, clock, events } = ctx;
  progress.claimTrial(db, userId, clock.today, events);
  progress.settle(db, userId, clock.today, events);
  return profileView(ctx);
}

module.exports = { profileView, overview, xpSeries, achievements, setTitle, claimTrial };
