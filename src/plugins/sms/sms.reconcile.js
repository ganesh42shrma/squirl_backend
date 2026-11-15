const { nowIso, newId, toPaise, updateRow } = require('../../core/sql');
const { insertCategory } = require('../categories/category.model');

function upiRef(row) {
  const explicit = row.refNo ?? row.ref_no;
  if (/^\d{12}$/.test(explicit || '')) return explicit;
  const description = row.description || '';
  if (!/^UPI\//i.test(description.replace(/^(WDL|DEP)\s+TFR\s+/i, ''))) return null;
  const refs = description.split('/').filter((p) => /^\d{12}$/.test(p.trim()));
  return refs.length === 1 ? refs[0].trim() : null;
}

function matches(db, userId, doc, { includeDeleted = false } = {}) {
  if (!upiRef(doc)) return [];
  const rows = db.prepare(`SELECT * FROM transactions WHERE user_id = ? AND account = ? AND date = ?
    AND amount_paise = ? AND type = ? AND source IN ('sms', 'import') ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`)
    .all(userId, doc.account, doc.date instanceof Date ? doc.date.toISOString().slice(0, 10) : doc.date, toPaise(doc.amount), doc.type);
  return rows.filter((r) => upiRef(r) === upiRef(doc));
}

function relatedPayments(db, userId, doc) {
  const ref = upiRef(doc);
  if (!ref) return [];
  const day = doc.date instanceof Date ? doc.date.toISOString().slice(0, 10) : doc.date;
  return db.prepare(`SELECT * FROM active_transactions WHERE user_id = ? AND account = ? AND type = ?
    AND date BETWEEN date(?, '-7 days') AND date(?, '+7 days') AND source IN ('sms', 'import')`)
    .all(userId, doc.account, doc.type, day, day).filter((r) => upiRef(r) === ref);
}

// Both accounts must be explicitly registered as the person's own. Names never prove a transfer.
function linkTransfer(db, userId, transactionId) {
  const row = db.prepare('SELECT * FROM active_transactions WHERE id = ? AND user_id = ?').get(transactionId, userId);
  const ref = row && upiRef(row);
  if (!ref) return;
  const accounts = new Set(db.prepare('SELECT bank FROM sms_accounts WHERE user_id = ? AND deleted_at IS NULL').pluck().all(userId));
  if (!accounts.has(row.account)) return;
  const opposite = db.prepare(`SELECT * FROM active_transactions WHERE user_id = ? AND date = ? AND amount_paise = ?
    AND type != ? AND account != ? AND source IN ('sms', 'import')`).all(userId, row.date, row.amount_paise, row.type, row.account)
    .filter((r) => accounts.has(r.account) && upiRef(r) === ref);
  // A second possible same-direction leg also makes pairing ambiguous.
  const same = matches(db, userId, { ...row, amount: row.amount_paise / 100 });
  if (opposite.length !== 1 || same.length !== 1) return;
  const other = opposite[0];
  if (row.transfer_id && other.transfer_id && row.transfer_id !== other.transfer_id) return;
  const transferId = row.transfer_id || other.transfer_id || newId();
  let category = db.prepare("SELECT id FROM active_categories WHERE user_id = ? AND type = 'transfer' AND parent_id IS NULL ORDER BY name = 'Self Transfers' DESC LIMIT 1").pluck().get(userId);
  if (!category) category = insertCategory(db, userId, { name: 'Self Transfers', type: 'transfer' });
  const update = db.prepare(`UPDATE transactions SET transfer_id = ?, category_id = CASE WHEN category_id IS NULL OR auto_categorized = 1 THEN ? ELSE category_id END,
    auto_categorized = CASE WHEN category_id IS NULL OR auto_categorized = 1 THEN 1 ELSE 0 END, updated_at = ? WHERE id = ? AND user_id = ?`);
  for (const leg of [row, other]) update.run(transferId, category, nowIso(), leg.id, userId);
}

// Upgrade the SMS row in place: preserve its id, notes, tags, and the person's category choices.
function reconcileStatement(db, userId, doc, ambiguous = false) {
  const candidates = matches(db, userId, doc);
  if (ambiguous || candidates.length !== 1 || candidates[0].source !== 'sms') {
    // The statement remains authoritative. Remove conflicting provisional SMS rows from totals,
    // retaining their evidence and annotations for review instead of silently merging them.
    for (const pending of relatedPayments(db, userId, doc).filter((r) => r.source === 'sms')) {
      const now = nowIso();
      updateRow(db, 'transactions', pending.id, { deleted_at: now, updated_at: now });
      db.prepare("UPDATE sms_events SET status = 'review', reason = ?, updated_at = ? WHERE user_id = ? AND transaction_id = ? AND deleted_at IS NULL AND status != 'dismissed'")
        .run(ambiguous || candidates.length > 1 ? 'ambiguous_statement' : 'statement_conflict', now, userId, pending.id);
    }
    return false;
  }
  const row = candidates[0];
  updateRow(db, 'transactions', row.id, {
    date: doc.date instanceof Date ? doc.date.toISOString().slice(0, 10) : doc.date,
    description: doc.description, amount_paise: toPaise(doc.amount), type: doc.type,
    source: 'import', import_id: doc.importId, ref_no: doc.refNo || upiRef(doc), hash: doc.hash,
    balance_paise: toPaise(doc.balance), updated_at: nowIso(),
  });
  db.prepare("UPDATE sms_events SET status = 'reconciled', reason = NULL, updated_at = ? WHERE user_id = ? AND transaction_id = ? AND deleted_at IS NULL AND status != 'dismissed'")
    .run(nowIso(), userId, row.id);
  linkTransfer(db, userId, row.id);
  return true;
}

// Undoing a statement must retain payments that were already captured independently by SMS.
function restoreSmsForImport(db, userId, importId) {
  const rows = db.prepare(`SELECT t.id, e.parsed FROM active_transactions t JOIN sms_events e ON e.transaction_id = t.id
    WHERE t.user_id = ? AND t.import_id = ? AND e.user_id = ? AND e.deleted_at IS NULL AND e.parsed IS NOT NULL GROUP BY t.id`)
    .all(userId, importId, userId);
  for (const row of rows) {
    const parsed = JSON.parse(row.parsed);
    updateRow(db, 'transactions', row.id, { source: 'sms', import_id: null, hash: null, balance_paise: null,
      description: parsed.description, ref_no: parsed.refNo, updated_at: nowIso() });
    db.prepare("UPDATE sms_events SET status = 'captured', updated_at = ? WHERE user_id = ? AND transaction_id = ? AND deleted_at IS NULL AND status != 'dismissed'")
      .run(nowIso(), userId, row.id);
  }
  return rows.length;
}

const identity = (doc) => [doc.account, doc.date instanceof Date ? doc.date.toISOString().slice(0, 10) : doc.date, toPaise(doc.amount), doc.type, upiRef(doc)].join('|');
module.exports = { upiRef, matches, relatedPayments, identity, linkTransfer, reconcileStatement, restoreSmsForImport };
