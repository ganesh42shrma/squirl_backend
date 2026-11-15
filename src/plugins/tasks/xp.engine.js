// Pure XP rules: the difficulty table, the level curve, ranks, and how much a completion pays.
// Nothing here touches the database, so every rule is easy to test.
const { daysBetween } = require('./day');

const DIFFICULTIES = {
  trivial: { label: 'Trivial', badge: 'E', xp: 5 },
  easy: { label: 'Easy', badge: 'D', xp: 10 },
  normal: { label: 'Normal', badge: 'C', xp: 20 },
  hard: { label: 'Hard', badge: 'B', xp: 40 },
  epic: { label: 'Epic', badge: 'A', xp: 80 },
  boss: { label: 'Boss', badge: 'S', xp: 150 },
};
const TASK_DIFFICULTIES = Object.keys(DIFFICULTIES);
const HABIT_DIFFICULTIES = TASK_DIFFICULTIES.filter((d) => d !== 'boss');
const STATS = ['str', 'vit', 'agi', 'int', 'per', 'cha'];
const HARD_PLUS = new Set(['hard', 'epic', 'boss']);

const MAX_LEVEL = 100;
const DAILY_CAP = 600; // default soft cap; the person can change it
const OVER_CAP_FACTOR = 0.25;
const TRIVIAL_EASY_PER_DAY = 15; // after this many Trivial/Easy completions in a day each pays 1 XP
const FAST_COMPLETE_MS = 120_000; // created and finished within 2 minutes pays at most Trivial
const ON_TIME_BONUS = 1.2;
const VERY_LATE_DAYS = 3;
const VERY_LATE_FACTOR = 0.5;
const CHECKLIST_XP = 1;
const CHECKLIST_MAX_PER_TASK = 10;
const DAILY_QUEST_XP = 50;
const PENALTY_QUEST_XP = 20;
const ECHO_BONUS_PER = 0.01;
const ECHO_BONUS_MAX = 0.1;

// Streak milestones that pay XP (once per habit per milestone, for life).
const STREAK_MILESTONES = { 7: 50, 14: 100, 30: 200, 66: 500, 100: 750, 365: 2000 };
// Every milestone worth a toast, whether or not it pays.
const STREAK_TOASTS = [3, 7, 14, 21, 30, 50, 66, 100, 150, 200, 365, 500, 1000];

// xpToNext(L) = round to 10 of 80 + 12 * L^1.35 : quick early levels, slower later, never a wall.
const xpToNext = (level) => Math.round((80 + 12 * level ** 1.35) / 10) * 10;

// CUMULATIVE[L] = total XP needed to be level L (index 0 unused).
const CUMULATIVE = [0, 0];
for (let level = 1; level < MAX_LEVEL; level += 1) CUMULATIVE.push(CUMULATIVE[level] + xpToNext(level));

function levelFromTotal(totalXp) {
  const xp = Math.max(0, totalXp);
  let lo = 1;
  let hi = MAX_LEVEL;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (CUMULATIVE[mid] <= xp) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Where a total XP figure sits inside its level. */
function levelProgress(totalXp) {
  const level = levelFromTotal(totalXp);
  if (level >= MAX_LEVEL) return { level, xpIntoLevel: 0, xpForLevel: 0, xpToNext: 0, fraction: 1, maxed: true };
  const into = Math.max(0, totalXp) - CUMULATIVE[level];
  const span = CUMULATIVE[level + 1] - CUMULATIVE[level];
  return { level, xpIntoLevel: into, xpForLevel: span, xpToNext: span - into, fraction: into / span, maxed: false };
}

// Rank ladder. The first level of each rank opens a Reassessment; the rank badge changes only when
// it is cleared. E is where everyone starts; N is National; X is Apex.
const RANKS = [
  { id: 'E', name: 'E-Rank', minLevel: 1 },
  { id: 'D', name: 'D-Rank', minLevel: 10 },
  { id: 'C', name: 'C-Rank', minLevel: 20 },
  { id: 'B', name: 'B-Rank', minLevel: 35 },
  { id: 'A', name: 'A-Rank', minLevel: 50 },
  { id: 'S', name: 'S-Rank', minLevel: 65 },
  { id: 'N', name: 'National', minLevel: 85 },
  { id: 'X', name: 'Apex', minLevel: 100 },
];
const rankIndex = (id) => RANKS.findIndex((r) => r.id === id);
/** The highest rank this level has earned the right to attempt. */
function rankForLevel(level) {
  let result = RANKS[0];
  for (const r of RANKS) if (level >= r.minLevel) result = r;
  return result;
}

const ACHIEVEMENT_XP = { common: 25, rare: 75, epic: 200, legendary: 500, mythic: 1500 };
const RANK_TRIAL_XP = { D: 100, C: 200, B: 400, A: 800, S: 1500, N: 3000, X: 5000 };

const echoBonus = (echoCount) => Math.min(ECHO_BONUS_MAX, echoCount * ECHO_BONUS_PER);
const streakMultiplier = (streak) => 1 + Math.min(Math.max(streak, 0), 30) / 60;

/**
 * What finishing a task (or subtask) pays, before the daily limits.
 * Returns the tier actually used and every multiplier, so the ledger can explain itself.
 */
function taskAward({ difficulty, isSubtask = false, dueDate, completedOn, createdAt, completedAt, subtaskCount = 0, echoCount = 0 }) {
  let tier = difficulty;
  const notes = [];
  // A Boss task is a project: it needs real structure (3+ subtasks) to pay Boss XP.
  if (tier === 'boss' && !isSubtask && subtaskCount < 3) {
    tier = 'epic';
    notes.push('boss_needs_subtasks');
  }
  // Created and finished within two minutes: it can't have been much of a quest.
  if (createdAt != null && completedAt != null && completedAt - createdAt < FAST_COMPLETE_MS && DIFFICULTIES[tier].xp > DIFFICULTIES.trivial.xp) {
    tier = 'trivial';
    notes.push('too_quick');
  }
  let base = DIFFICULTIES[tier].xp;
  if (isSubtask) base = Math.max(1, Math.round(base / 2));
  let factor = 1;
  if (dueDate) {
    const late = daysBetween(dueDate, completedOn);
    if (late <= 0) { factor = ON_TIME_BONUS; notes.push('on_time'); }
    else if (late > VERY_LATE_DAYS) { factor = VERY_LATE_FACTOR; notes.push('very_late'); }
  }
  const echo = 1 + echoBonus(echoCount);
  return { tier, base, factor, echo, amount: Math.max(1, Math.round(base * factor * echo)), notes };
}

function habitAward({ difficulty, streak = 0, echoCount = 0 }) {
  const base = DIFFICULTIES[difficulty].xp;
  const factor = streakMultiplier(streak);
  const echo = 1 + echoBonus(echoCount);
  return { tier: difficulty, base, factor, echo, amount: Math.max(1, Math.round(base * factor * echo)), notes: [] };
}

/**
 * The day's limits. `dayXp` is what the day has already paid (excluding bonuses),
 * `lowTierCount` how many Trivial/Easy completions it has had.
 */
function applyDailyLimits(award, { dayXp, lowTierCount, cap = DAILY_CAP }) {
  let { amount } = award;
  const notes = [...award.notes];
  const lowTier = award.tier === 'trivial' || award.tier === 'easy';
  if (lowTier && lowTierCount >= TRIVIAL_EASY_PER_DAY) { amount = 1; notes.push('low_tier_limit'); }
  const capped = dayXp >= cap;
  if (capped) { amount = Math.max(1, Math.round(amount * OVER_CAP_FACTOR)); notes.push('daily_cap'); }
  return { ...award, amount, notes, capped, crossedCap: !capped && dayXp + amount >= cap };
}

module.exports = {
  DIFFICULTIES, TASK_DIFFICULTIES, HABIT_DIFFICULTIES, STATS, HARD_PLUS, MAX_LEVEL, DAILY_CAP, CHECKLIST_XP, CHECKLIST_MAX_PER_TASK,
  DAILY_QUEST_XP, PENALTY_QUEST_XP, STREAK_MILESTONES, STREAK_TOASTS, CUMULATIVE, RANKS, ACHIEVEMENT_XP, RANK_TRIAL_XP,
  TRIVIAL_EASY_PER_DAY, xpToNext, levelFromTotal, levelProgress, rankIndex, rankForLevel, echoBonus, streakMultiplier,
  taskAward, habitAward, applyDailyLimits,
};
