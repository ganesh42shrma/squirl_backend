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

const dayOf = (doc) => (doc.date instanceof Date ? doc.date.toISOString().slice(0, 10) : doc.date);

/**
 * Rows Quick Capture created ("chai 40" typed before the bank's SMS arrived) that this SMS payment is
 * probably the same as: same person, direction and amount, a day either side, not archived, not yet tied
 * to any SMS. Only rows with a capture_id qualify, so hand-typed ledger rows are never touched, and a
 * payment typed as cash never qualifies (cash has no bank message). When several qualify, the one on the
 * SMS's own day wins, then the one in the same account, so two ₹40 chais on two days pair up correctly.
 */
function capturedMatches(db, userId, doc) {
  const rows = db.prepare(`SELECT * FROM active_transactions t WHERE t.user_id = ? AND t.source = 'manual' AND t.capture_id IS NOT NULL
    AND t.transfer_id IS NULL AND t.type = ? AND t.amount_paise = ? AND t.date BETWEEN date(?, '-1 day') AND date(?, '+1 day')
    AND COALESCE(t.payment_mode, '') != 'cash'
    AND NOT EXISTS (SELECT 1 FROM sms_events e WHERE e.transaction_id = t.id AND e.user_id = t.user_id AND e.deleted_at IS NULL)`)
    .all(userId, doc.type, toPaise(doc.amount), dayOf(doc), dayOf(doc));
  return narrow(rows, [(r) => r.date === dayOf(doc), (r) => r.account === doc.account]);
}

/** Applies each preference in turn, but only while it leaves at least one row: never narrows to nothing. */
function narrow(rows, preferences) {
  let left = rows;
  for (const prefer of preferences) {
    if (left.length < 2) break;
    const kept = left.filter(prefer);
    if (kept.length) left = kept;
  }
  return left;
}

/**
 * The bank's facts win (it becomes an SMS row with the real account, date, UPI reference and mode); the
 * person's own description, category, tags and notes stay exactly as they wrote them.
 */
function mergeIntoCaptured(db, userId, row, doc) {
  updateRow(db, 'transactions', row.id, {
    source: 'sms', account: doc.account, date: dayOf(doc), ref_no: doc.refNo || upiRef(doc) || row.ref_no,
    payment_mode: doc.paymentMode || row.payment_mode, description_kept: 1, updated_at: nowIso(),
  });
}

// A row's description is the person's own words when an SMS was merged into their Quick Capture row.
// (A bank row they merely annotated keeps the bank's wording, so statements may reword that one.)
const keepsPersonalDescription = (db, userId, row) => row.description_kept === 1;

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
    description: keepsPersonalDescription(db, userId, row) ? row.description : doc.description, amount_paise: toPaise(doc.amount), type: doc.type,
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
  const rows = db.prepare(`SELECT t.id, t.description, t.description_kept, e.parsed FROM active_transactions t JOIN sms_events e ON e.transaction_id = t.id
    WHERE t.user_id = ? AND t.import_id = ? AND e.user_id = ? AND e.deleted_at IS NULL AND e.parsed IS NOT NULL GROUP BY t.id`)
    .all(userId, importId, userId);
  for (const row of rows) {
    const parsed = JSON.parse(row.parsed);
    // Words the person wrote on a captured row survive the statement coming and going.
    const personal = row.description_kept === 1;
    updateRow(db, 'transactions', row.id, { source: 'sms', import_id: null, hash: null, balance_paise: null,
      description: personal ? row.description : parsed.description, ref_no: parsed.refNo, updated_at: nowIso() });
    db.prepare("UPDATE sms_events SET status = 'captured', updated_at = ? WHERE user_id = ? AND transaction_id = ? AND deleted_at IS NULL AND status != 'dismissed'")
      .run(nowIso(), userId, row.id);
  }
  return rows.length;
}

const identity = (doc) => [doc.account, doc.date instanceof Date ? doc.date.toISOString().slice(0, 10) : doc.date, toPaise(doc.amount), doc.type, upiRef(doc)].join('|');
module.exports = { upiRef, matches, narrow, capturedMatches, mergeIntoCaptured, relatedPayments, identity, linkTransfer, reconcileStatement, restoreSmsForImport };
