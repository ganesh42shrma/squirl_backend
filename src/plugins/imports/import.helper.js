const { createHash } = require('crypto');

function toDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Fingerprint of a statement row. The running balance is included so two genuinely
 * identical rows on the same day (e.g. two ₹20 UPI payments) still get different hashes.
 */
function makeHash({ bank, date, amount, type, refNo, description, balance }) {
  const key = [bank, date.toISOString().slice(0, 10), amount, type, refNo || '', description, balance ?? '']
    .join('|')
    .toLowerCase();
  return createHash('sha256').update(key).digest('hex');
}

/** Maps one parser row to a Transaction document, or returns null if the row is unusable. */
function toTransaction(row, { bank, importId }) {
  const date = toDate(row.date);
  const debit = Number(row.debit) || 0;
  const credit = Number(row.credit) || 0;
  const amount = Math.round(Math.abs(debit || credit) * 100) / 100;
  if (!date || !amount) return null;

  const doc = {
    date,
    description: row.description.replace(/\s+/g, ' ').trim() || 'Statement entry',
    amount,
    type: debit ? 'debit' : 'credit',
    account: bank,
    source: 'import',
    importId,
    refNo: row.refNo?.trim() || undefined,
    balance: row.balance ?? undefined,
  };
  doc.hash = makeHash({ ...doc, bank });
  return doc;
}

/** Earliest and latest transaction dates, used when the parser doesn't report the period. */
function getPeriod(docs) {
  if (!docs.length) return {};
  const times = docs.map((d) => d.date.getTime());
  return { periodFrom: new Date(Math.min(...times)), periodTo: new Date(Math.max(...times)) };
}

module.exports = { toDate, makeHash, toTransaction, getPeriod };
