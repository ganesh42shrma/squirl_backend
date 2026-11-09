const { insertRow, newId, nowIso } = require('../../core/sql');

// Table: users. The password hash never leaves this module's callers.
function toUser(row) {
  if (!row) return null;
  return { _id: row.id, email: row.email, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at };
}

function insertUser(db, { email, name, passwordHash }) {
  const now = nowIso();
  const id = newId();
  insertRow(db, 'users', { id, email, name, password_hash: passwordHash, password_changed_at: now, created_at: now, updated_at: now });
  return id;
}

module.exports = { toUser, insertUser };
