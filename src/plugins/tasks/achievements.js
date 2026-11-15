// Achievement catalogue (definitions live in code, unlocks in the database) and the one query
// bundle that feeds both the achievements and the rank Reassessments.
const { addDays } = require('./day');
const { rankIndex, STATS } = require('./xp.engine');

// rarity -> XP is in xp.engine (ACHIEVEMENT_XP). `value(stats)` is the current count; the
// achievement unlocks once it reaches `target`.
const def = (id, name, description, rarity, target, value, group = 'tasks') => ({ id, name, description, rarity, target, value, group });

const ACHIEVEMENTS = [
  def('first_step', 'First Step', 'Complete your first task.', 'common', 1, (s) => s.tasksDone),
  def('quest_log', 'Quest Log', 'Complete 10 tasks.', 'common', 10, (s) => s.tasksDone),
  def('centurion', 'Centurion', 'Complete 100 tasks.', 'rare', 100, (s) => s.tasksDone),
  def('thousand_cuts', 'A Thousand Cuts', 'Complete 1,000 tasks.', 'epic', 1000, (s) => s.tasksDone),
  def('early_riser', 'Before the Gate Opens', 'Complete a task before 7 AM on 5 different days.', 'common', 5, (s) => s.earlyDays),
  def('night_raid', 'Night Raid', 'Complete a Hard or tougher task after 10 PM.', 'common', 1, (s) => (s.nightRaid ? 1 : 0)),
  def('inbox_zero', 'Empty Dungeon', 'Finish every task in a list that had at least three.', 'common', 1, (s) => (s.listCleared ? 1 : 0)),
  def('giant_slayer', 'Giant Slayer', 'Complete your first Boss task.', 'rare', 1, (s) => s.bossDone),
  def('boss_rush', 'Boss Rush', 'Complete 3 Boss tasks in one week.', 'epic', 3, (s) => s.boss7),
  def('awakened', 'Awakened', 'Add a habit to your Daily Quest.', 'common', 1, (s) => (s.questHabits > 0 ? 1 : 0), 'quests'),
  def('daily_1', 'Daily Grind', 'Clear the Daily Quest once.', 'common', 1, (s) => s.dailyClears, 'quests'),
  def('daily_7', 'Seven Suns', 'Reach a Daily Quest chain of 7.', 'common', 7, (s) => s.longestChain, 'quests'),
  def('daily_30', 'Moon Cycle', 'Reach a Daily Quest chain of 30.', 'rare', 30, (s) => s.longestChain, 'quests'),
  def('daily_100', 'Hundredfold', 'Reach a Daily Quest chain of 100.', 'epic', 100, (s) => s.longestChain, 'quests'),
  def('daily_365', 'Year of Iron', 'Reach a Daily Quest chain of 365.', 'legendary', 365, (s) => s.longestChain, 'quests'),
  def('penalty_survivor', 'Survived the Penalty', 'Clear a Penalty Quest.', 'common', 1, (s) => s.penaltyCleared, 'quests'),
  def('streak_14', 'Kindling', 'Hold a habit streak of 14.', 'common', 14, (s) => s.maxLongest, 'streaks'),
  def('streak_30', 'Steady Flame', 'Hold a habit streak of 30.', 'rare', 30, (s) => s.maxLongest, 'streaks'),
  def('streak_100', 'Wildfire', 'Hold a habit streak of 100.', 'epic', 100, (s) => s.maxLongest, 'streaks'),
  def('streak_365', 'Eternal Flame', 'Hold a habit streak of 365.', 'legendary', 365, (s) => s.maxLongest, 'streaks'),
  def('frozen_solid', 'Frozen Solid', 'Have a freeze save a streak 5 times.', 'common', 5, (s) => s.freezesUsed, 'streaks'),
  def('first_echo', 'Bound Echo', 'Bind your first Echo (a habit held for 66 periods).', 'rare', 1, (s) => s.echoes, 'streaks'),
  def('echo_legion', 'Echo Legion', 'Bind 5 Echoes.', 'epic', 5, (s) => s.echoes, 'streaks'),
  def('echo_marshal', 'Marshal of Echoes', 'Own a Marshal-grade Echo (1,000 periods).', 'mythic', 1, (s) => (s.marshal ? 1 : 0), 'streaks'),
  def('rank_d', 'D-Rank Hunter', 'Clear the D-Rank Reassessment.', 'common', 1, (s) => (rankIndex(s.rank) >= 1 ? 1 : 0), 'rank'),
  def('rank_c', 'C-Rank Hunter', 'Clear the C-Rank Reassessment.', 'rare', 1, (s) => (rankIndex(s.rank) >= 2 ? 1 : 0), 'rank'),
  def('rank_b', 'B-Rank Hunter', 'Clear the B-Rank Reassessment.', 'rare', 1, (s) => (rankIndex(s.rank) >= 3 ? 1 : 0), 'rank'),
  def('rank_a', 'A-Rank Hunter', 'Clear the A-Rank Reassessment.', 'epic', 1, (s) => (rankIndex(s.rank) >= 4 ? 1 : 0), 'rank'),
  def('rank_s', 'S-Rank Hunter', 'Clear the S-Rank Reassessment.', 'legendary', 1, (s) => (rankIndex(s.rank) >= 5 ? 1 : 0), 'rank'),
  def('rank_national', 'National Treasure', 'Reach National rank.', 'legendary', 1, (s) => (rankIndex(s.rank) >= 6 ? 1 : 0), 'rank'),
  def('apex', 'Apex', 'Reach level 100.', 'mythic', 100, (s) => s.level, 'rank'),
  def('balanced', 'Balanced Build', 'Raise every stat to 10.', 'epic', 10, (s) => Math.min(...STATS.map((k) => s.statValues[k])), 'rank'),
  def('specialist', 'Specialist', 'Raise one stat to 50.', 'rare', 50, (s) => Math.max(...STATS.map((k) => s.statValues[k])), 'rank'),
  def('money_sense', 'Money Sense', 'Earn 1,000 PER XP from money tasks and habits.', 'rare', 1000, (s) => s.statXp.per, 'rank'),
  def('xp_10k', 'Ten Thousand Steps', 'Earn 10,000 XP.', 'rare', 10000, (s) => s.totalXp, 'rank'),
  def('xp_100k', 'Hundred Thousand', 'Earn 100,000 XP.', 'legendary', 100000, (s) => s.totalXp, 'rank'),
];

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

/**
 * Everything the achievements and Reassessments need to know, in a handful of queries.
 * `today` is the person's current day key.
 */
function collectStats(db, userId, today) {
  const one = (sql, ...args) => db.prepare(sql).pluck().get(userId, ...args) ?? 0;
  const week = addDays(today, -6);
  const profile = db.prepare('SELECT * FROM hunter_profiles WHERE user_id = ?').get(userId) || {};

  const statXp = Object.fromEntries(STATS.map((k) => [k, 0]));
  for (const row of db.prepare('SELECT stat, sum(amount) AS xp FROM xp_events WHERE user_id = ? AND stat IS NOT NULL GROUP BY stat').all(userId)) {
    if (row.stat in statXp) statXp[row.stat] = Math.max(0, row.xp);
  }
  const statValues = Object.fromEntries(STATS.map((k) => [k, Math.floor(statXp[k] / 100)]));

  const habits = db.prepare('SELECT current_streak, longest_streak, echo_bound_at, freezes_used_total FROM active_habits WHERE user_id = ? AND archived_at IS NULL').all(userId);
  const allHabits = db.prepare('SELECT longest_streak, echo_bound_at, freezes_used_total FROM active_habits WHERE user_id = ?').all(userId);
  const bound = allHabits.filter((h) => h.echo_bound_at);

  return {
    totalXp: Math.max(0, one('SELECT sum(amount) FROM xp_events WHERE user_id = ?')),
    level: profile.level ?? 1,
    rank: profile.rank ?? 'E',
    chain: profile.daily_chain ?? 0,
    longestChain: profile.longest_daily_chain ?? 0,
    statXp,
    statValues,
    tasksDone: one("SELECT count(*) FROM active_tasks WHERE user_id = ? AND status = 'done' AND parent_id IS NULL"),
    bossDone: one("SELECT count(*) FROM active_tasks WHERE user_id = ? AND status = 'done' AND parent_id IS NULL AND difficulty = 'boss'"),
    boss7: one("SELECT count(*) FROM active_tasks WHERE user_id = ? AND status = 'done' AND parent_id IS NULL AND difficulty = 'boss' AND completed_on >= ?", week),
    hardPlusDone: one("SELECT count(*) FROM active_tasks WHERE user_id = ? AND status = 'done' AND parent_id IS NULL AND difficulty IN ('hard', 'epic', 'boss')"),
    hardPlus7: one("SELECT count(*) FROM active_tasks WHERE user_id = ? AND status = 'done' AND parent_id IS NULL AND difficulty IN ('hard', 'epic', 'boss') AND completed_on >= ?", week),
    bossWithFiveSubtasks: one(`SELECT count(*) FROM active_tasks t WHERE t.user_id = ? AND t.status = 'done' AND t.parent_id IS NULL AND t.difficulty = 'boss'
      AND (SELECT count(*) FROM active_tasks s WHERE s.parent_id = t.id) >= 5`),
    nightRaid: one("SELECT count(*) FROM active_tasks WHERE user_id = ? AND status = 'done' AND difficulty IN ('hard', 'epic', 'boss') AND completed_hour >= 22") > 0,
    earlyDays: one("SELECT count(DISTINCT completed_on) FROM active_tasks WHERE user_id = ? AND status = 'done' AND completed_hour < 7"),
    listCleared: one(`SELECT count(*) FROM active_task_lists l WHERE l.user_id = ?
      AND (SELECT count(*) FROM active_tasks t WHERE t.list_id = l.id AND t.parent_id IS NULL AND t.status = 'open') = 0
      AND (SELECT count(*) FROM active_tasks t WHERE t.list_id = l.id AND t.parent_id IS NULL AND t.status = 'done') >= 3`) > 0,
    dailyClears: one("SELECT count(*) FROM daily_quests WHERE user_id = ? AND status = 'cleared'"),
    questDaysIn7: one("SELECT count(*) FROM daily_quests WHERE user_id = ? AND status = 'cleared' AND date >= ? AND date <= ?", week, today),
    penaltyCleared: one("SELECT count(*) FROM daily_quests WHERE user_id = ? AND status = 'penalty_cleared'"),
    habits: habits.length,
    maxStreak: Math.max(0, ...habits.map((h) => h.current_streak)),
    maxLongest: Math.max(0, ...allHabits.map((h) => h.longest_streak)),
    freezesUsed: allHabits.reduce((n, h) => n + h.freezes_used_total, 0),
    echoes: bound.length,
    marshal: bound.some((h) => h.longest_streak >= 1000),
    questHabits: one('SELECT count(*) FROM active_habits WHERE user_id = ? AND archived_at IS NULL AND in_daily_quest = 1'),
  };
}

module.exports = { ACHIEVEMENTS, BY_ID, collectStats };
