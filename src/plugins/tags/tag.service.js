const { getDb } = require('../../config/db');
const AppError = require('../../core/AppError');
const { nowIso, updateRow } = require('../../core/sql');
const { CUSTOM_GROUP, toTag, insertTag } = require('./tag.model');

const findById = (userId, id) => toTag(getDb().prepare('SELECT * FROM active_tags WHERE id = ? AND user_id = ?').get(id, userId));

/**
 * Catalog tags with their usage counts, plus any tag used on a transaction
 * that isn't in the catalog yet (listed under the "custom" group with no id).
 */
async function listTags(userId, { group }) {
  const db = getDb();
  const catalog = db.prepare('SELECT * FROM active_tags WHERE user_id = ?').all(userId).map(toTag);
  const usage = db.prepare('SELECT tt.tag AS name, count(*) AS count FROM transaction_tags tt JOIN active_transactions t ON t.id = tt.transaction_id AND t.user_id = tt.user_id WHERE tt.user_id = ? GROUP BY tt.tag').all(userId);

  const counts = new Map(usage.map((u) => [u.name, u.count]));
  const known = new Set(catalog.map((t) => t.name));

  const tags = [
    ...catalog.map((t) => ({ ...t, count: counts.get(t.name) || 0 })),
    ...usage
      .filter((u) => !known.has(u.name))
      .map((u) => ({ _id: null, name: u.name, group: CUSTOM_GROUP, color: null, count: u.count })),
  ];

  return tags
    .filter((t) => !group || t.group === group)
    .sort((a, b) => a.group.localeCompare(b.group) || b.count - a.count || a.name.localeCompare(b.name));
}

async function createTag(userId, data) {
  return findById(userId, insertTag(getDb(), userId, data));
}

// Renaming a tag renames it on every one of this account's transactions too.
async function updateTag(userId, id, data) {
  const tag = findById(userId, id);
  if (!tag) throw AppError.notFound('Tag not found');

  const now = nowIso();
  const changes = { updated_at: now };
  if (data.name !== undefined) changes.name = data.name;
  if (data.group !== undefined) changes.group_name = data.group;
  if (data.color !== undefined) changes.color = data.color;

  const db = getDb();
  db.transaction(() => {
    updateRow(db, 'tags', id, changes);
    if (data.name !== undefined && data.name !== tag.name) {
      db.prepare(
        'UPDATE transactions SET updated_at = ? WHERE deleted_at IS NULL AND user_id = ? AND id IN (SELECT transaction_id FROM transaction_tags WHERE user_id = ? AND tag = ? AND transaction_id IN (SELECT id FROM active_transactions))',
      ).run(now, userId, userId, tag.name);
      // Rows that already carry the new name keep one copy; the old name is then removed everywhere.
      db.prepare('UPDATE OR IGNORE transaction_tags SET tag = ? WHERE user_id = ? AND tag = ? AND transaction_id IN (SELECT id FROM active_transactions)').run(data.name, userId, tag.name);
      db.prepare('DELETE FROM transaction_tags WHERE user_id = ? AND tag = ? AND transaction_id IN (SELECT id FROM active_transactions)').run(userId, tag.name);
    }
  })();
  return findById(userId, id);
}

// Deleting a tag removes it from the catalog and from every one of this account's transactions.
async function deleteTag(userId, id) {
  const tag = findById(userId, id);
  if (!tag) throw AppError.notFound('Tag not found');

  const db = getDb();
  const removed = db.transaction(() => {
    db.prepare('DELETE FROM tags WHERE id = ? AND user_id = ?').run(id, userId);
    db.prepare(
      'UPDATE transactions SET updated_at = ? WHERE deleted_at IS NULL AND user_id = ? AND id IN (SELECT transaction_id FROM transaction_tags WHERE user_id = ? AND tag = ? AND transaction_id IN (SELECT id FROM active_transactions))',
    ).run(nowIso(), userId, userId, tag.name);
    return db.prepare('DELETE FROM transaction_tags WHERE user_id = ? AND tag = ? AND transaction_id IN (SELECT id FROM active_transactions)').run(userId, tag.name).changes;
  })();
  return { removedFromTransactions: removed };
}

module.exports = { listTags, createTag, updateTag, deleteTag };
