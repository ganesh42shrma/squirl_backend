const ImportBatch = require('./import.model');
const Transaction = require('../transactions/transaction.model');
const AppError = require('../../core/AppError');
const logger = require('../../core/logger');
const { parseStatement } = require('./import.client');
const { toDate, toTransaction, getPeriod } = require('./import.helper');

// Drops rows already in the DB (from an earlier import) and repeats within this same file.
async function removeDuplicates(docs) {
  const hashes = docs.map((d) => d.hash);
  const existing = await Transaction.find({ hash: { $in: hashes } }, { hash: 1 }).lean();
  const seen = new Set(existing.map((t) => t.hash));

  return docs.filter((doc) => {
    if (seen.has(doc.hash)) return false;
    seen.add(doc.hash);
    return true;
  });
}

async function createImport({ file, bank, password }) {
  const batch = await ImportBatch.create({ bank, fileName: file.originalname });
  logger.info('Statement import started', { importId: batch.id, bank, fileName: file.originalname });

  try {
    const parsed = await parseStatement({ buffer: file.buffer, fileName: file.originalname, bank, password });

    const docs = parsed.transactions.map((row) => toTransaction(row, { bank, importId: batch._id })).filter(Boolean);
    const fresh = await removeDuplicates(docs);
    if (fresh.length) await Transaction.insertMany(fresh);

    const period = getPeriod(docs);
    batch.set({
      status: 'completed',
      periodFrom: toDate(parsed.periodFrom) || period.periodFrom,
      periodTo: toDate(parsed.periodTo) || period.periodTo,
      stats: {
        parsed: parsed.transactions.length,
        inserted: fresh.length,
        duplicates: docs.length - fresh.length,
        skipped: parsed.transactions.length - docs.length,
      },
    });
    await batch.save();

    logger.info('Statement import completed', { importId: batch.id, ...batch.stats.toObject() });
    return batch;
  } catch (err) {
    batch.set({ status: 'failed', error: err.message });
    await batch.save();
    logger.warn('Statement import failed', { importId: batch.id, error: err.message });
    throw err;
  }
}

async function listImports({ page, limit }) {
  const [items, total] = await Promise.all([
    ImportBatch.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ImportBatch.countDocuments(),
  ]);
  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

async function getImport(id) {
  const batch = await ImportBatch.findById(id).lean();
  if (!batch) throw AppError.notFound('Import not found');
  return batch;
}

// Undo an import: removes the batch and every transaction it created.
async function deleteImport(id) {
  const batch = await ImportBatch.findById(id);
  if (!batch) throw AppError.notFound('Import not found');

  const { deletedCount } = await Transaction.deleteMany({ importId: batch._id });
  await batch.deleteOne();

  logger.info('Statement import deleted', { importId: id, transactionsDeleted: deletedCount });
  return { transactionsDeleted: deletedCount };
}

module.exports = { createImport, listImports, getImport, deleteImport };
