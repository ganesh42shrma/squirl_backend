// The XP ledger, the hunter profile (level, rank, title), rank Reassessments and achievements.
// Every function takes the open `db` and runs inside the caller's transaction. XP only ever
// changes by appending to xp_events; the profile row is a cache that can always be rebuilt.
const { newId, nowIso, insertRow } = require('../../core/sql');
const AppError = require('../../core/AppError');
const xp = require('./xp.engine');
const { ACHIEVEMENTS, BY_ID, collectStats } = require('./achievements');
const { parseJson } = require('./task.model');

const CAPPED_REASONS = ['task', 'subtask', 'checklist', 'habit'];
const LOW_TIER_REASONS = ['task', 'subtask', 'habit'];

function ensureProfile(db, userId) {
  let row = db.prepare('SELECT * FROM hunter_profiles WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare('INSERT INTO hunter_profiles (user_id, updated_at) VALUES (?, ?)').run(userId, nowIso());
    row = db.prepare('SELECT * FROM hunter_profiles WHERE user_id = ?').get(userId);
  }
  return row;
}

const totalXp = (db, userId) => Math.max(0, db.prepare('SELECT ifnull(sum(amount), 0) FROM xp_events WHERE user_id = ?').pluck().get(userId));

/** What the day has already paid under the soft cap, and how many Trivial/Easy completions it had. */
function dayLedger(db, userId, day) {
  const reasons = CAPPED_REASONS.map((r) => `'${r}'`).join(', ');
  const dayXp = db
    .prepare(
      `SELECT ifnull(sum(e.amount), 0) FROM xp_events e WHERE e.user_id = ? AND e.occurred_on = ? AND (
         e.reason IN (${reasons}) OR (e.reason = 'reversal' AND EXISTS (
           SELECT 1 FROM xp_events o WHERE o.user_id = e.user_id AND 'rev:' || o.id = e.dedupe_key AND o.reason IN (${reasons}))))`,
    )
    .pluck()
    .get(userId, day);
  const lowTierCount = db
    .prepare(
      `SELECT count(*) FROM xp_events e WHERE e.user_id = ? AND e.occurred_on = ? AND e.tier IN ('trivial', 'easy')
         AND e.reason IN (${LOW_TIER_REASONS.map((r) => `'${r}'`).join(', ')})
         AND NOT EXISTS (SELECT 1 FROM xp_events r WHERE r.user_id = e.user_id AND r.dedupe_key = 'rev:' || e.id)`,
    )
    .pluck()
    .get(userId, day);
  return { dayXp, lowTierCount };
}

/**
 * Appends one XP event, once per dedupeKey. If that award was earlier reversed (a task was
 * un-completed), re-awarding simply removes the reversal, so toggling can never farm XP.
 * Returns the amount now in effect, or 0 when this was a repeat of a request already paid.
 */
function awardXp(db, userId, { reason, amount, sourceId = null, dedupeKey, stat = null, tier = null, occurredOn, meta }, events) {
  const existing = dedupeKey ? db.prepare('SELECT * FROM xp_events WHERE user_id = ? AND dedupe_key = ?').get(userId, dedupeKey) : null;
  if (existing) {
    const reversal = db.prepare("SELECT id FROM xp_events WHERE user_id = ? AND dedupe_key = ?").get(userId, `rev:${existing.id}`);
    if (!reversal) return 0;
    db.prepare('DELETE FROM xp_events WHERE id = ?').run(reversal.id);
    events?.push({ type: 'xp', amount: existing.amount, reason: existing.reason });
    return existing.amount;
  }
  insertRow(db, 'xp_events', {
    id: newId(), user_id: userId, amount, reason, source_id: sourceId, dedupe_key: dedupeKey ?? null, stat, tier,
    occurred_on: occurredOn, meta: meta ? JSON.stringify(meta) : null, created_at: nowIso(),
  });
  events?.push({ type: 'xp', amount, reason });
  return amount;
}

/** Writes the offsetting event for an award, once. Returns the amount taken back (0 if nothing to reverse). */
function reverseXp(db, userId, dedupeKey, events) {
  const original = db.prepare('SELECT * FROM xp_events WHERE user_id = ? AND dedupe_key = ?').get(userId, dedupeKey);
  if (!original) return 0;
  const key = `rev:${original.id}`;
  if (db.prepare('SELECT 1 FROM xp_events WHERE user_id = ? AND dedupe_key = ?').get(userId, key)) return 0;
  insertRow(db, 'xp_events', {
    id: newId(), user_id: userId, amount: -original.amount, reason: 'reversal', source_id: original.source_id, dedupe_key: key,
    stat: original.stat, tier: original.tier, occurred_on: original.occurred_on, meta: null, created_at: nowIso(),
  });
  events?.push({ type: 'xp', amount: -original.amount, reason: 'reversal' });
  return original.amount;
}

// --- Reassessments ---------------------------------------------------------------------------

// What each promotion asks for. `progress(s)` -> the current figure for each condition.
const TRIALS = {
  D: [{ id: 'quest_days', label: 'Clear the Daily Quest on 5 of the last 7 days', target: 5, value: (s) => s.questDaysIn7 }],
  C: [
    { id: 'streak', label: 'Hold a habit streak of 14', target: 14, value: (s) => s.maxStreak },
    { id: 'hard_week', label: 'Finish 3 Hard (or tougher) tasks in the last 7 days', target: 3, value: (s) => s.hardPlus7 },
  ],
  B: [
    { id: 'boss', label: 'Finish a Boss task that had 5 or more subtasks', target: 1, value: (s) => s.bossWithFiveSubtasks },
    { id: 'chain', label: 'Reach a Daily Quest chain of 21', target: 21, value: (s) => s.chain },
  ],
  A: [{ id: 'echo', label: 'Bind your first Echo (a habit held for 66 periods)', target: 1, value: (s) => s.echoes }],
  S: [
    { id: 'echoes', label: 'Bind 3 Echoes', target: 3, value: (s) => s.echoes },
    { id: 'chain', label: 'Reach a Daily Quest chain of 30', target: 30, value: (s) => s.chain },
  ],
  N: [
    { id: 'chain', label: 'Reach a Daily Quest chain of 100', target: 100, value: (s) => s.chain },
    { id: 'hard', label: 'Finish 250 Hard (or tougher) tasks', target: 250, value: (s) => s.hardPlusDone },
  ],
  X: [
    { id: 'level', label: 'Reach level 100', target: 100, value: (s) => s.level },
    { id: 'echoes', label: 'Bind 7 Echoes', target: 7, value: (s) => s.echoes },
  ],
};

function trialView(db, userId, trial, today) {
  if (!trial) return null;
  const stats = collectStats(db, userId, today);
  const items = TRIALS[trial.rank].map((c) => ({ id: c.id, label: c.label, target: c.target, current: Math.min(c.value(stats), c.target), done: c.value(stats) >= c.target }));
  const rank = xp.RANKS.find((r) => r.id === trial.rank);
  return { rank: trial.rank, name: rank.name, minLevel: rank.minLevel, openedAt: trial.openedAt, items, ready: items.every((i) => i.done), rewardXp: xp.RANK_TRIAL_XP[trial.rank] };
}

/** Recomputes the cached profile from the ledger; announces level-ups and opens a Reassessment when one is due. */
function refreshProfile(db, userId, events) {
  const row = ensureProfile(db, userId);
  const total = totalXp(db, userId);
  const level = xp.levelFromTotal(total);
  const changes = { total_xp: total, level, updated_at: nowIso() };
  if (level > row.peak_level) {
    changes.peak_level = level;
    events?.push({ type: 'level_up', level, from: row.peak_level });
  }
  let trial = parseJson(row.trial, null);
  const next = xp.RANKS[xp.rankIndex(row.rank) + 1];
  if (!trial && next && level >= next.minLevel) {
    trial = { rank: next.id, openedAt: nowIso() };
    changes.trial = JSON.stringify(trial);
    events?.push({ type: 'rank_trial_open', rank: next.id, name: next.name });
  }
  db.prepare(`UPDATE hunter_profiles SET ${Object.keys(changes).map((c) => `${c} = @${c}`).join(', ')} WHERE user_id = @user_id`).run({ ...changes, user_id: userId });
  return { ...row, ...changes };
}

/** Finalises a Reassessment when every condition is met. */
function claimTrial(db, userId, today, events) {
  const row = ensureProfile(db, userId);
  const trial = parseJson(row.trial, null);
  if (!trial) throw AppError.conflict('There is no Reassessment open right now', 'NO_TRIAL');
  const view = trialView(db, userId, trial, today);
  if (!view.ready) throw AppError.conflict('The Reassessment’s conditions aren’t all met yet', 'TRIAL_NOT_READY', view.items);
  db.prepare('UPDATE hunter_profiles SET rank = ?, trial = NULL, updated_at = ? WHERE user_id = ?').run(trial.rank, nowIso(), userId);
  events.push({ type: 'rank_up', rank: trial.rank, name: view.name });
  awardXp(db, userId, { reason: 'rank_trial', amount: view.rewardXp, sourceId: trial.rank, dedupeKey: `trial:${trial.rank}`, occurredOn: today }, events);
  return view;
}

// --- Achievements ----------------------------------------------------------------------------

/** Updates progress, unlocks what has been reached and pays its XP. Repeats while XP unlocks more. */
function checkAchievements(db, userId, today, events) {
  for (let pass = 0; pass < 4; pass += 1) {
    const stats = collectStats(db, userId, today);
    const saved = new Map(db.prepare('SELECT * FROM user_achievements WHERE user_id = ?').all(userId).map((r) => [r.achievement_id, r]));
    let unlockedAny = false;
    for (const a of ACHIEVEMENTS) {
      const value = Math.max(0, a.value(stats));
      const count = Math.min(value, a.target);
      const row = saved.get(a.id);
      const progress = JSON.stringify({ count, target: a.target });
      const unlocking = value >= a.target && !row?.unlocked_at;
      if (!row) {
        db.prepare('INSERT INTO user_achievements (user_id, achievement_id, progress, unlocked_at) VALUES (?, ?, ?, ?)').run(userId, a.id, progress, unlocking ? nowIso() : null);
      } else if (row.progress !== progress || unlocking) {
        db.prepare('UPDATE user_achievements SET progress = ?, unlocked_at = coalesce(unlocked_at, ?) WHERE user_id = ? AND achievement_id = ?').run(progress, unlocking ? nowIso() : null, userId, a.id);
      }
      if (unlocking) {
        unlockedAny = true;
        const reward = xp.ACHIEVEMENT_XP[a.rarity];
        awardXp(db, userId, { reason: 'achievement', amount: reward, sourceId: a.id, dedupeKey: `ach:${a.id}`, occurredOn: today }, events);
        events.push({ type: 'achievement', id: a.id, name: a.name, rarity: a.rarity, xp: reward });
      }
    }
    if (!unlockedAny) break;
    refreshProfile(db, userId, events);
  }
}

/** The usual end of a mutation: settle the profile, then achievements. */
function settle(db, userId, today, events) {
  refreshProfile(db, userId, events);
  checkAchievements(db, userId, today, events);
  refreshProfile(db, userId, events);
}

const catalogue = (db, userId) => {
  const saved = new Map(db.prepare('SELECT * FROM user_achievements WHERE user_id = ?').all(userId).map((r) => [r.achievement_id, r]));
  return ACHIEVEMENTS.map((a) => {
    const row = saved.get(a.id);
    const progress = parseJson(row?.progress, { count: 0, target: a.target });
    return { id: a.id, name: a.name, description: a.description, rarity: a.rarity, group: a.group, xp: xp.ACHIEVEMENT_XP[a.rarity], progress, unlockedAt: row?.unlocked_at ?? undefined };
  });
};

module.exports = {
  CAPPED_REASONS, ensureProfile, totalXp, dayLedger, awardXp, reverseXp, TRIALS, trialView, refreshProfile, claimTrial,
  checkAchievements, settle, catalogue, BY_ID,
};

/** Echoes bound so far: each adds a small passive XP bonus. */
module.exports.echoCount = (db, userId) =>
  db.prepare('SELECT count(*) FROM active_habits WHERE user_id = ? AND echo_bound_at IS NOT NULL').pluck().get(userId);
