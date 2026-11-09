const { insertRow, newId, nowIso } = require('../../core/sql');

const CUSTOM_GROUP = 'custom';
const DEFAULT_COLOR = '#9ca3af';

// Table: tags, the tag catalog. Transactions store tag names in transaction_tags;
// this adds a group and colour to each name.
function toTag(row) {
  if (!row) return null;
  return {
    _id: row.id,
    name: row.name,
    group: row.group_name,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertTag(db, userId, { name, group, color }) {
  const now = nowIso();
  const id = newId();
  insertRow(db, 'tags', {
    id,
    user_id: userId,
    name,
    group_name: group || CUSTOM_GROUP,
    color: color || DEFAULT_COLOR,
    created_at: now,
    updated_at: now,
  });
  return id;
}

module.exports = { CUSTOM_GROUP, toTag, insertTag };
