const { toApiDate } = require('../../core/sql');

const BANKS = ['sbi', 'kotak'];
const AUTO_BANK = 'auto';
const IMPORT_STATUSES = ['processing', 'completed', 'failed'];

// Table: imports, one row per uploaded statement.
function toImport(row) {
  if (!row) return null;
  return {
    _id: row.id,
    bank: row.bank, // null until the parser has detected it
    fileName: row.file_name,
    status: row.status,
    stats: {
      parsed: row.parsed,
      inserted: row.inserted,
      duplicates: row.duplicates,
      skipped: row.skipped,
      autoCategorized: row.auto_categorized, // of the inserted rows, sorted by merchant memory
    },
    periodFrom: toApiDate(row.period_from),
    periodTo: toApiDate(row.period_to),
    // Date range of the rows this import added (the rest were already in the ledger).
    newFrom: toApiDate(row.new_from),
    newTo: toApiDate(row.new_to),
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { BANKS, AUTO_BANK, IMPORT_STATUSES, toImport };
