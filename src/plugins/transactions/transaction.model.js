const { insertRow, newId, nowIso, toPaise, fromPaise, toDateKey, toApiDate, placeholders } = require('../../core/sql');
const { memberCandidate } = require('../users/contact.helper');

const TRANSACTION_TYPES = ['debit', 'credit'];
const SOURCES = ['manual', 'import'];

// Table: transactions (+ transaction_tags). Every read joins the category and its parent,
// so a row can show "Food & Drinks › Food Delivery". Filters use the alias `t` and must
// always include `t.user_id = ?` (buildFilter does).
// Categories are joined on user too, so a row can never show another account's category.
const SELECT_TRANSACTIONS = `
  SELECT t.*,
         c.name AS c_name, c.color AS c_color, c.icon AS c_icon, c.type AS c_type,
         p.id AS p_id, p.name AS p_name, p.color AS p_color, p.icon AS p_icon
  FROM active_transactions t
  LEFT JOIN active_categories c ON c.id = t.category_id AND c.user_id = t.user_id
  LEFT JOIN active_categories p ON p.id = c.parent_id AND p.user_id = t.user_id`;

const lower = (value) => (value === undefined || value === null ? value : String(value).trim().toLowerCase());

function toCategoryRef(row) {
  if (!row.category_id) return null;
  return {
    _id: row.category_id,
    name: row.c_name,
    color: row.c_color,
    icon: row.c_icon ?? undefined,
    type: row.c_type,
    parent: row.p_id ? { _id: row.p_id, name: row.p_name, color: row.p_color, icon: row.p_icon ?? undefined } : null,
  };
}

function toTransaction(row, tags = []) {
  return {
    _id: row.id,
    date: toApiDate(row.date),
    description: row.description,
    memberCandidate: memberCandidate(row.description),
    amount: fromPaise(row.amount_paise),
    type: row.type,
    category: toCategoryRef(row),
    tags,
    notes: row.notes ?? undefined,
    account: row.account,
    paymentMode: row.payment_mode ?? undefined,
    source: row.source,
    importId: row.import_id ?? undefined,
    refNo: row.ref_no ?? undefined,
    balance: fromPaise(row.balance_paise),
    hash: row.hash ?? undefined,
    // Sorted by rules, the model, or a contact match; not yet confirmed by the person.
    autoCategorized: row.auto_categorized === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Rows from SELECT_TRANSACTIONS → API objects, with their tags loaded in one query.
function withTags(db, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const tagsById = new Map(ids.map((id) => [id, []]));
  const tagRows = db
    .prepare(`SELECT transaction_id, tag FROM transaction_tags WHERE transaction_id IN (${placeholders(ids)}) ORDER BY rowid`)
    .all(...ids);
  for (const { transaction_id: id, tag } of tagRows) tagsById.get(id).push(tag);
  return rows.map((row) => toTransaction(row, tagsById.get(row.id)));
}

function addTags(db, userId, transactionId, tags = []) {
  const insert = db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag, user_id) VALUES (?, ?, ?)');
  let added = 0;
  for (const tag of tags) added += insert.run(transactionId, tag, userId).changes;
  return added;
}

function getTags(db, transactionId) {
  return db.prepare('SELECT tag FROM transaction_tags WHERE transaction_id = ? ORDER BY rowid').pluck().all(transactionId);
}

/** Inserts one transaction for `userId` (API field names in, as validated) and returns its id. */
function insertTransaction(db, userId, data) {
  const now = nowIso();
  const id = newId();
  insertRow(db, 'transactions', {
    id,
    user_id: userId,
    date: toDateKey(data.date),
    description: data.description,
    amount_paise: toPaise(data.amount),
    type: data.type || 'debit',
    category_id: data.category || null,
    notes: data.notes ?? null,
    account: lower(data.account) || 'cash',
    payment_mode: lower(data.paymentMode) ?? null,
    source: data.source || 'manual',
    import_id: data.importId ?? null,
    ref_no: data.refNo?.trim() || null,
    balance_paise: toPaise(data.balance),
    hash: data.hash ?? null,
    auto_categorized: data.autoCategorized ? 1 : 0,
    created_at: now,
    updated_at: now,
  });
  addTags(db, userId, id, data.tags);
  return id;
}

/** API field names → column changes for an update (only the fields present). */
function toColumnChanges(data) {
  const changes = {};
  if (data.date !== undefined) changes.date = toDateKey(data.date);
  if (data.description !== undefined) changes.description = data.description;
  if (data.amount !== undefined) changes.amount_paise = toPaise(data.amount);
  if (data.type !== undefined) changes.type = data.type;
  if (data.category !== undefined) changes.category_id = data.category || null;
  if (data.notes !== undefined) changes.notes = data.notes;
  if (data.account !== undefined) changes.account = lower(data.account) || 'cash';
  if (data.paymentMode !== undefined) changes.payment_mode = lower(data.paymentMode);
  return changes;
}

module.exports = {
  TRANSACTION_TYPES,
  SOURCES,
  SELECT_TRANSACTIONS,
  withTags,
  addTags,
  getTags,
  insertTransaction,
  toColumnChanges,
};
