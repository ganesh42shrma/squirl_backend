const { insertRow, newId, nowIso } = require('../../core/sql');
const { slugify } = require('./category.helper');

/**
 * expense    – money spent (food, rent, shopping…)
 * income     – money earned (salary, freelancing, cashback…)
 * investment – money put to work (SIPs, stocks, FDs…)
 * transfer   – moving your own money (credit card bill, account to account, ATM) – not spending
 * lending    – money lent to or borrowed from people, split settlements
 */
const CATEGORY_TYPES = ['expense', 'income', 'investment', 'transfer', 'lending'];
const DEFAULT_COLOR = '#9ca3af';

// Table: categories (see config/migrations.js). parent is null for a top-level category.
function toCategory(row) {
  if (!row) return null;
  return {
    _id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type,
    parent: row.parent_id,
    color: row.color,
    icon: row.icon ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertCategory(db, userId, { name, type, parent, color, icon }) {
  const now = nowIso();
  const id = newId();
  insertRow(db, 'categories', {
    id,
    user_id: userId,
    name,
    slug: slugify(name),
    type: type || 'expense',
    parent_id: parent || null,
    color: color || DEFAULT_COLOR,
    icon: icon ?? null,
    created_at: now,
    updated_at: now,
  });
  return id;
}

module.exports = { CATEGORY_TYPES, DEFAULT_COLOR, toCategory, insertCategory };
