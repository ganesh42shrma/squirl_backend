const { getDb } = require('../../config/db');
const AppError = require('../../core/AppError');
const { nowIso, updateRow } = require('../../core/sql');
const { toCategory, insertCategory } = require('./category.model');
const { buildTree, slugify } = require('./category.helper');

// Every query is scoped to the account: another account's category id simply isn't found.
const findById = (userId, id) => toCategory(getDb().prepare('SELECT * FROM active_categories WHERE id = ? AND user_id = ?').get(id, userId));
const hasChildren = (userId, id) => Boolean(getDb().prepare('SELECT 1 FROM active_categories WHERE parent_id = ? AND user_id = ? LIMIT 1').get(id, userId));

// Names are unique among siblings: "Other" can exist under Food and under Shopping, but not twice under Food.
function assertNameAvailable(userId, name, parent, excludeId) {
  const taken = getDb()
    .prepare("SELECT 1 FROM active_categories WHERE user_id = ? AND ifnull(parent_id, '') = ? AND slug = ? AND id IS NOT ?")
    .get(userId, parent || '', slugify(name), excludeId ?? null);
  if (taken) throw AppError.conflict(`A category named "${name}" already exists here`, 'CATEGORY_EXISTS');
}

// Subcategories are one level deep, so a parent must itself be top-level.
function getParent(userId, parentId) {
  const parent = findById(userId, parentId);
  if (!parent) throw AppError.badRequest('Parent category not found', 'INVALID_PARENT');
  if (parent.parent) throw AppError.badRequest('A subcategory cannot have its own subcategories', 'INVALID_PARENT');
  return parent;
}

async function listCategories(userId, { type, view }) {
  const rows = type
    ? getDb().prepare('SELECT * FROM active_categories WHERE user_id = ? AND type = ? ORDER BY name').all(userId, type)
    : getDb().prepare('SELECT * FROM active_categories WHERE user_id = ? ORDER BY name').all(userId);
  const categories = rows.map(toCategory);
  return view === 'flat' ? categories : buildTree(categories);
}

// A category plus its subcategories, so filtering by "Food & Drinks" also matches "Food Delivery".
async function getCategoryFamilyIds(userId, id) {
  const children = getDb().prepare('SELECT id FROM active_categories WHERE parent_id = ? AND user_id = ?').pluck().all(id, userId);
  return [id, ...children];
}

async function createCategory(userId, data) {
  if (data.parent) {
    const parent = getParent(userId, data.parent);
    data = { ...data, type: parent.type, color: data.color || parent.color };
  }
  assertNameAvailable(userId, data.name, data.parent);
  return findById(userId, insertCategory(getDb(), userId, data));
}

async function updateCategory(userId, id, data) {
  const category = findById(userId, id);
  if (!category) throw AppError.notFound('Category not found');

  const parentId = data.parent !== undefined ? data.parent : category.parent;
  if (parentId) {
    if (parentId === id) throw AppError.badRequest('A category cannot be its own parent', 'INVALID_PARENT');
    if (data.parent && hasChildren(userId, id)) {
      throw AppError.badRequest('A category with subcategories cannot become a subcategory', 'INVALID_PARENT');
    }
    const parent = getParent(userId, parentId);
    data = { ...data, type: parent.type };
  }
  if (data.name || data.parent !== undefined) {
    assertNameAvailable(userId, data.name || category.name, parentId, id);
  }

  const now = nowIso();
  const changes = { updated_at: now };
  if (data.name !== undefined) Object.assign(changes, { name: data.name, slug: slugify(data.name) });
  if (data.type !== undefined) changes.type = data.type;
  if (data.parent !== undefined) changes.parent_id = data.parent || null;
  if (data.color !== undefined) changes.color = data.color;
  if (data.icon !== undefined) changes.icon = data.icon;

  const db = getDb();
  db.transaction(() => {
    updateRow(db, 'categories', id, changes);
    // Subcategories always follow their parent's type.
    if (!parentId && data.type) {
      db.prepare('UPDATE categories SET type = ?, updated_at = ? WHERE parent_id = ? AND user_id = ?').run(data.type, now, id, userId);
    }
  })();
  return findById(userId, id);
}

async function deleteCategory(userId, id) {
  const db = getDb();
  const deleted = findById(userId, id);
  if (!deleted) throw AppError.notFound('Category not found');

  const children = db.prepare('SELECT count(*) FROM active_categories WHERE parent_id = ? AND user_id = ?').pluck().get(id, userId);
  const inUse = db.prepare('SELECT count(*) FROM transactions WHERE category_id = ? AND user_id = ?').pluck().get(id, userId);
  if (children > 0) {
    throw AppError.conflict(`Category has ${children} subcategory(s); delete or move them first`, 'CATEGORY_HAS_CHILDREN');
  }
  if (inUse > 0) {
    throw AppError.conflict(`Category is used by ${inUse} transaction(s); reassign them first`, 'CATEGORY_IN_USE');
  }
  db.prepare('DELETE FROM categories WHERE id = ? AND user_id = ?').run(id, userId);
  return deleted;
}

module.exports = { listCategories, getCategoryFamilyIds, createCategory, updateCategory, deleteCategory };
