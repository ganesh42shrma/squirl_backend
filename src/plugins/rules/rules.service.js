const { getDb } = require('../../config/db');
const AppError = require('../../core/AppError');
const { newId, nowIso, placeholders } = require('../../core/sql');
const { merchantKey, isUsableKey } = require('./rules.helper');
const { familyPolicy } = require('../users/family');

/**
 * Learns from rows the person just categorised (single edit, bulk edit, or applied suggestions).
 * Only imported rows teach: their descriptions come from the bank, so they repeat; hand-typed ones don't.
 * The person's latest choice wins, and those rows count as confirmed (no longer "automatic").
 * Runs inside the caller's transaction. Each account has its own memory.
 */
function learn(db, userId, ids, categoryId) {
  if (!ids.length) return;
  db.prepare(`UPDATE transactions SET auto_categorized = 0 WHERE deleted_at IS NULL AND user_id = ? AND id IN (${placeholders(ids)})`).run(userId, ...ids);
  if (!categoryId) return; // clearing a category teaches nothing

  const rows = db
    .prepare(`SELECT description, type FROM active_transactions WHERE user_id = ? AND source = 'import' AND id IN (${placeholders(ids)})`)
    .all(userId, ...ids);
  const now = nowIso();
  const upsert = db.prepare(`
    INSERT INTO merchant_rules (id, user_id, direction, merchant_key, example, category_id, created_at, updated_at)
    VALUES (@id, @userId, @direction, @key, @example, @category, @now, @now)
    ON CONFLICT (user_id, direction, merchant_key) WHERE deleted_at IS NULL DO UPDATE SET category_id = @category, example = @example, updated_at = @now`);
  const seen = new Set();
  for (const row of rows) {
    const key = merchantKey(row.description);
    if (!isUsableKey(key) || seen.has(`${row.type}:${key}`)) continue;
    seen.add(`${row.type}:${key}`);
    upsert.run({ id: newId(), userId, direction: row.type, key, example: row.description.slice(0, 200), category: categoryId, now });
  }
}

/**
 * The category memory knows for a new row, or null. Used inside the import transaction:
 * the doc gets the category and is flagged automatic. Counts a hit on the rule.
 */
function categoryFor(db, userId, { description, type }) {
  const policy = familyPolicy(db, userId);
  if (policy.matches(description)) return policy.familyId || null;
  const key = merchantKey(description);
  if (!isUsableKey(key)) return null;
  const rule = db.prepare('SELECT id, category_id FROM active_merchant_rules WHERE user_id = ? AND direction = ? AND merchant_key = ?').get(userId, type, key);
  if (!rule) {
    const suggestion = db.prepare('SELECT is_person FROM active_merchant_suggestions WHERE user_id = ? AND direction = ? AND merchant_key = ?').get(userId, type, key);
    return suggestion?.is_person ? policy.otherId || null : null;
  }
  db.prepare('UPDATE merchant_rules SET hits = hits + 1 WHERE id = ?').run(rule.id);
  return policy.categoryFor(description, rule.category_id);
}

// This account's unsorted imported rows that a rule already covers: [{ id, categoryId }].
function matchUnsorted(db, userId) {
  const policy = familyPolicy(db, userId);
  const rules = new Map(
    db
      .prepare('SELECT direction, merchant_key, category_id FROM active_merchant_rules WHERE user_id = ?')
      .all(userId)
      .map((r) => [`${r.direction}:${r.merchant_key}`, r.category_id]),
  );
  return db
    .prepare("SELECT id, description, type FROM active_transactions WHERE user_id = ? AND category_id IS NULL AND source = 'import'")
    .all(userId)
    .map((row) => ({ id: row.id, categoryId: policy.categoryFor(row.description, rules.get(`${row.type}:${merchantKey(row.description)}`)) }))
    .filter((m) => m.categoryId);
}

async function listRules(userId) {
  const db = getDb();
  const rules = db
    .prepare(
      `SELECT r.*, c.name AS c_name, c.type AS c_type, p.name AS p_name
       FROM active_merchant_rules r
       JOIN active_categories c ON c.id = r.category_id AND c.user_id = r.user_id
       LEFT JOIN active_categories p ON p.id = c.parent_id AND p.user_id = r.user_id
       WHERE r.user_id = ?
       ORDER BY r.hits DESC, r.updated_at DESC`,
    )
    .all(userId)
    .map((r) => ({
      _id: r.id,
      direction: r.direction,
      merchant: r.merchant_key,
      example: r.example,
      category: { _id: r.category_id, label: r.p_name ? `${r.p_name} › ${r.c_name}` : r.c_name, type: r.c_type },
      hits: r.hits,
      updatedAt: r.updated_at,
    }));
  return { rules, applicable: matchUnsorted(db, userId).length };
}

// Sorts every unsorted imported row a rule covers (an explicit button, so nothing changes behind your back).
async function applyRules(userId) {
  const db = getDb();
  return db.transaction(() => {
    const matches = matchUnsorted(db, userId);
    const now = nowIso();
    const update = db.prepare(
      'UPDATE transactions SET category_id = ?, auto_categorized = 1, updated_at = ? WHERE deleted_at IS NULL AND id = ? AND user_id = ? AND category_id IS NULL',
    );
    for (const m of matches) update.run(m.categoryId, now, m.id, userId);
    return { applied: matches.length };
  })();
}

async function deleteRule(userId, id) {
  const now = nowIso();
  const { changes } = getDb().prepare('UPDATE merchant_rules SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL').run(now, now, id, userId);
  if (!changes) throw AppError.notFound('Rule not found');
  return { deleted: true };
}

module.exports = { learn, categoryFor, listRules, applyRules, deleteRule };
