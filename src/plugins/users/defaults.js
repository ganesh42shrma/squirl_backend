// Default categories and tags for one user. Safe to re-run: existing entries, and any edits
// made to them, are left untouched.
const { insertCategory } = require('../categories/category.model');
const { insertTag } = require('../tags/tag.model');
const { slugify } = require('../categories/category.helper');
const DEFAULT_CATEGORIES = require('../../scripts/data/categories');
const DEFAULT_TAGS = require('../../scripts/data/tags');

function ensureCategory(db, userId, parentId, data) {
  const find = () =>
    db
      .prepare("SELECT * FROM active_categories WHERE user_id = ? AND ifnull(parent_id, '') = ? AND slug = ?")
      .get(userId, parentId || '', slugify(data.name));
  const existing = find();
  if (existing) return { row: existing, added: 0 };
  insertCategory(db, userId, { ...data, parent: parentId });
  return { row: find(), added: 1 };
}

/** Adds any missing default categories and tags for `userId`. Run inside a transaction. */
function seedDefaults(db, userId) {
  let categoriesAdded = 0;
  for (const { children = [], ...data } of DEFAULT_CATEGORIES) {
    const parent = ensureCategory(db, userId, null, data);
    categoriesAdded += parent.added;
    for (const name of children) {
      categoriesAdded += ensureCategory(db, userId, parent.row.id, { name, type: parent.row.type, color: parent.row.color }).added;
    }
  }

  const tagExists = db.prepare('SELECT 1 FROM active_tags WHERE user_id = ? AND name = ?');
  let tagsAdded = 0;
  for (const { group, color, tags } of DEFAULT_TAGS) {
    for (const name of tags) {
      if (tagExists.get(userId, name)) continue;
      insertTag(db, userId, { name, group, color });
      tagsAdded += 1;
    }
  }
  return { categoriesAdded, tagsAdded };
}

// Tables with a user_id, in an order that respects references.
const OWNED_TABLES = ['categories', 'tags', 'imports', 'transactions', 'transaction_tags', 'merchant_rules'];

/**
 * Gives every unowned row (data from before accounts existed) to `userId`.
 * Called only when the very first account is created.
 */
function adoptUnowned(db, userId) {
  let adopted = 0;
  for (const table of OWNED_TABLES) {
    adopted += db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(userId).changes;
  }
  return adopted;
}

module.exports = { seedDefaults, adoptUnowned, OWNED_TABLES };
