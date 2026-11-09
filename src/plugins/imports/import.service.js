const { getDb } = require('../../config/db');
const AppError = require('../../core/AppError');
const logger = require('../../core/logger');
const { insertRow, newId, nowIso, toDateKey, updateRow } = require('../../core/sql');
const { AUTO_BANK, toImport } = require('./import.model');
const { insertTransaction } = require('../transactions/transaction.model');
const { parseStatement } = require('./import.client');
const { categoryFor } = require('../rules/rules.service');
const suggestionWorker = require('../insights/suggestions.worker');
const { toDate, toTransaction, getPeriod } = require('./import.helper');

const findById = (userId, id) => toImport(getDb().prepare('SELECT * FROM active_imports WHERE id = ? AND user_id = ?').get(id, userId));

/**
 * Inserts the rows not already in the DB (from an earlier import) and skips repeats within
 * this same file. This is what makes overlapping statements safe: import Jul–Sep today and
 * Aug–Oct tomorrow and every unseen row is added, including gaps in older dates.
 * There is no date cutoff or filename cache. Runs in one SQLite transaction:
 * either every new row is saved or none is. Returns the rows it added.
 */
function insertNewRows(db, userId, docs) {
  return db.transaction(() => {
    // Duplicates are per account: two people importing the same statement each get the rows.
    const exists = db.prepare('SELECT 1 FROM active_transactions WHERE user_id = ? AND hash = ?');
    const seen = new Set();
    const added = [];
    for (const doc of docs) {
      if (seen.has(doc.hash) || exists.get(userId, doc.hash)) continue;
      seen.add(doc.hash);
      // Merchant memory: a merchant categorised before arrives sorted, flagged as automatic.
      const category = categoryFor(db, userId, doc);
      const row = category ? { ...doc, category, autoCategorized: true } : doc;
      insertTransaction(db, userId, row);
      added.push(row);
    }
    return added;
  })();
}

async function createImport(userId, { file, bank, password }) {
  const db = getDb();
  const generation = db.prepare('SELECT financial_generation FROM users WHERE id = ?').get(userId)?.financial_generation;
  const id = newId();
  const now = nowIso();
  const requested = bank === AUTO_BANK ? null : bank;
  insertRow(db, 'imports', { id, user_id: userId, bank: requested, file_name: file.originalname, status: 'processing', created_at: now, updated_at: now });
  logger.info('Statement import started', { importId: id, bank, fileName: file.originalname });

  try {
    const parsed = await parseStatement({ buffer: file.buffer, fileName: file.originalname, bank, password });
    if (db.prepare('SELECT financial_generation FROM users WHERE id = ?').get(userId)?.financial_generation !== generation) throw AppError.conflict('Financial data was reset while this import was running. Import the statement again.', 'IMPORT_RESET');

    // The parser reports the bank it read the statement as (the detected one for bank=auto).
    const statementBank = parsed.bank;
    const docs = parsed.transactions.map((row) => toTransaction(row, { bank: statementBank, importId: id })).filter(Boolean);
    const added = insertNewRows(db, userId, docs);

    const period = getPeriod(docs);
    const fresh = getPeriod(added);
    const stats = {
      parsed: parsed.transactions.length,
      inserted: added.length,
      auto_categorized: added.filter((d) => d.autoCategorized).length,
      duplicates: docs.length - added.length,
      skipped: parsed.transactions.length - docs.length,
    };
    updateRow(db, 'imports', id, {
      status: 'completed',
      bank: statementBank,
      new_from: toDateKey(fresh.periodFrom),
      new_to: toDateKey(fresh.periodTo),
      period_from: toDateKey(toDate(parsed.periodFrom) || period.periodFrom),
      period_to: toDateKey(toDate(parsed.periodTo) || period.periodTo),
      ...stats,
      updated_at: nowIso(),
    });

    logger.info('Statement import completed', { importId: id, bank: statementBank, ...stats });
    // New unsorted rows: let the background job suggest categories for them now.
    if (stats.inserted > stats.auto_categorized) suggestionWorker.nudge();
    return findById(userId, id);
  } catch (err) {
    try {
      updateRow(db, 'imports', id, { status: 'failed', error: err.message, updated_at: nowIso() });
    } catch (saveErr) {
      logger.error('Could not mark import as failed', { importId: id, error: saveErr.message });
    }
    logger.warn('Statement import failed', { importId: id, error: err.message });
    throw err;
  }
}

async function listImports(userId, { page, limit }) {
  const db = getDb();
  const items = db
    .prepare('SELECT * FROM active_imports WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?')
    .all(userId, limit, (page - 1) * limit)
    .map(toImport);
  const total = db.prepare('SELECT count(*) FROM active_imports WHERE user_id = ?').pluck().get(userId);
  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

async function getImport(userId, id) {
  const batch = findById(userId, id);
  if (!batch) throw AppError.notFound('Import not found');
  return batch;
}

// Undo an import without physically deleting archived transactions or their batch.
async function deleteImport(userId, id) {
  const db = getDb();
  if (!findById(userId, id)) throw AppError.notFound('Import not found');

  const transactionsDeleted = db.transaction(() => {
    const now = nowIso();
    const { changes } = db.prepare('UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE import_id = ? AND user_id = ? AND deleted_at IS NULL').run(now, now, id, userId);
    db.prepare('UPDATE imports SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(now, now, id, userId);
    return changes;
  })();

  logger.info('Statement import deleted', { importId: id, transactionsDeleted });
  return { transactionsDeleted };
}

module.exports = { createImport, listImports, getImport, deleteImport };
