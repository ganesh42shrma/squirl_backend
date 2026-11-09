const { getDb } = require('../../config/db');
const { getCategoryFamilyIds } = require('../categories/category.service');
const AppError = require('../../core/AppError');
const { nowIso, placeholders, updateRow } = require('../../core/sql');
const { SELECT_TRANSACTIONS, withTags, addTags, getTags, insertTransaction, toColumnChanges } = require('./transaction.model');
const { buildFilter, buildSort, buildSummaryQuery, toSummaryRow } = require('./transaction.helper');
const { learn } = require('../rules/rules.service');

// Filtering by a category also matches its subcategories.
async function buildQueryFilter(userId, query) {
  const hasCategory = query.category && query.category !== 'none';
  const categoryIds = hasCategory ? await getCategoryFamilyIds(userId, query.category) : undefined;
  return buildFilter(userId, query, categoryIds);
}

// A category id must belong to this account: another account's id is "not found", never attachable.
function assertCategoriesExist(userId, ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return;

  const found = getDb()
    .prepare(`SELECT count(*) FROM active_categories WHERE user_id = ? AND id IN (${placeholders(unique)})`)
    .pluck()
    .get(userId, ...unique);
  if (found !== unique.length) throw AppError.badRequest('Category not found', 'INVALID_CATEGORY');
}

function findById(userId, id) {
  const db = getDb();
  const row = db.prepare(`${SELECT_TRANSACTIONS} WHERE t.id = ? AND t.user_id = ?`).get(id, userId);
  return row ? withTags(db, [row])[0] : null;
}


async function listTransactions(userId, query) {
  const db = getDb();
  const filter = await buildQueryFilter(userId, query);
  const { page = 1, limit = 30 } = query;

  const rows = db
    .prepare(`${SELECT_TRANSACTIONS} ${filter.where} ORDER BY ${buildSort(query.sort)} LIMIT ? OFFSET ?`)
    .all(...filter.params, limit, (page - 1) * limit);
  const total = db.prepare(`SELECT count(*) FROM active_transactions t ${filter.where}`).pluck().get(...filter.params);

  return { items: withTags(db, rows), meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

async function getSummary(userId, query) {
  const db = getDb();
  const filter = await buildQueryFilter(userId, query);
  const run = (groupBy) => {
    const { sql, params } = buildSummaryQuery(groupBy, filter);
    return db.prepare(sql).all(...params).map((row) => toSummaryRow(row, groupBy));
  };

  // Totals are computed separately: with groupBy=tag one row can count towards several groups.
  return { groupBy: query.groupBy, totals: run('total')[0], groups: run(query.groupBy) };
}

async function getTransaction(userId, id) {
  const transaction = findById(userId, id);
  if (!transaction) throw AppError.notFound('Transaction not found');
  return transaction;
}

async function createTransaction(userId, data) {
  assertCategoriesExist(userId, [data.category]);
  const db = getDb();
  const id = db.transaction(() => insertTransaction(db, userId, { ...data, source: 'manual' }))();
  return findById(userId, id);
}

// All rows or none: one transaction around the whole batch.
async function bulkCreateTransactions(userId, rows) {
  assertCategoriesExist(userId, rows.map((r) => r.category));
  const db = getDb();
  db.transaction(() => {
    for (const row of rows) insertTransaction(db, userId, { ...row, source: 'manual' });
  })();
  return { inserted: rows.length };
}

async function updateTransaction(userId, id, data) {
  if (data.category) assertCategoriesExist(userId, [data.category]);
  const db = getDb();
  const current = db.prepare('SELECT source FROM active_transactions WHERE id = ? AND user_id = ?').get(id, userId);
  if (!current) throw AppError.notFound('Transaction not found');
  // Statement facts must stay intact for reconciliation and duplicate detection.
  if (current.source === 'import') {
    const locked = Object.keys(data).filter((key) => !['notes', 'category', 'tags'].includes(key));
    if (locked.length) throw AppError.badRequest('Statement details are read-only. You can change notes, categories and tags.', 'STATEMENT_READ_ONLY', { fields: locked });
  }

  db.transaction(() => {
    updateRow(db, 'transactions', id, { ...toColumnChanges(data), updated_at: nowIso() });
    // Setting a category teaches merchant memory (and confirms an automatic one).
    if (data.category !== undefined) learn(db, userId, [id], data.category);
    if (data.tags) {
      db.prepare('DELETE FROM transaction_tags WHERE transaction_id = ? AND user_id = ?').run(id, userId);
      addTags(db, userId, id, data.tags);
    }
  })();
  return findById(userId, id);
}

// `modified` counts rows where something actually changed. Ids from another account are ignored.
async function bulkUpdateTransactions(userId, ids, { category, tags, addTags: toAdd, removeTags }) {
  if (category) assertCategoriesExist(userId, [category]);
  const db = getDb();

  return db.transaction(() => {
    const existing = db
      .prepare(`SELECT id, category_id FROM active_transactions WHERE user_id = ? AND id IN (${placeholders(ids)})`)
      .all(userId, ...ids);
    const removeOne = db.prepare('DELETE FROM transaction_tags WHERE transaction_id = ? AND user_id = ? AND tag = ?');
    const modified = new Set();

    for (const { id, category_id: currentCategory } of existing) {
      if (category !== undefined && (category || null) !== currentCategory) {
        db.prepare('UPDATE transactions SET category_id = ? WHERE deleted_at IS NULL AND id = ? AND user_id = ?').run(category || null, id, userId);
        modified.add(id);
      }
      if (tags) {
        const current = getTags(db, id);
        if (current.length !== tags.length || current.some((t, i) => t !== tags[i])) {
          db.prepare('DELETE FROM transaction_tags WHERE transaction_id = ? AND user_id = ?').run(id, userId);
          addTags(db, userId, id, tags);
          modified.add(id);
        }
      }
      if (toAdd?.length && addTags(db, userId, id, toAdd) > 0) modified.add(id);
      if (removeTags?.length) {
        let removed = 0;
        for (const tag of removeTags) removed += removeOne.run(id, userId, tag).changes;
        if (removed) modified.add(id);
      }
    }

    // Categorising several rows at once teaches merchant memory too (this is also how
    // accepted model suggestions are applied). Every matched row counts as confirmed.
    if (category !== undefined) learn(db, userId, existing.map((e) => e.id), category);

    if (modified.size) {
      const changed = [...modified];
      db.prepare(`UPDATE transactions SET updated_at = ? WHERE deleted_at IS NULL AND user_id = ? AND id IN (${placeholders(changed)})`).run(nowIso(), userId, ...changed);
    }
    return { matched: existing.length, modified: modified.size };
  })();
}

async function deleteTransaction(userId, id) {
  const deleted = findById(userId, id);
  if (!deleted) throw AppError.notFound('Transaction not found');
  const now = nowIso();
  getDb().prepare('UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL').run(now, now, id, userId);
  return deleted;
}

module.exports = {
  listTransactions,
  getSummary,
  getTransaction,
  createTransaction,
  bulkCreateTransactions,
  updateTransaction,
  bulkUpdateTransactions,
  deleteTransaction,
};
