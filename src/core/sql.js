// Small SQLite helpers shared by the plugins: ids, money, dates and generic insert/update.
const { randomBytes } = require('crypto');

// 24-char hex ids: opaque to clients, same shape the API has always used.
const ID_PATTERN = /^[a-f0-9]{24}$/i;
const newId = () => randomBytes(12).toString('hex');
const nowIso = () => new Date().toISOString();

// Money is stored as integer paise so sums are exact; the API speaks rupees.
const toPaise = (rupees) => (rupees === null || rupees === undefined ? null : Math.round(Number(rupees) * 100));
const fromPaise = (paise) => (paise === null || paise === undefined ? undefined : paise / 100);

// Calendar dates are stored as 'YYYY-MM-DD' and returned as UTC midnight ISO strings.
const toDateKey = (value) => (value ? new Date(value).toISOString().slice(0, 10) : null);
const toApiDate = (key) => (key ? `${key}T00:00:00.000Z` : undefined);

// '?, ?, ?' for an IN (...) list.
const placeholders = (values) => values.map(() => '?').join(', ');

// Table and column names always come from code, never from request input.
function insertRow(db, table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`).run(row);
}

function updateRow(db, table, id, changes) {
  const columns = Object.keys(changes);
  if (!columns.length) return 0;
  const sets = columns.map((c) => `${c} = @${c}`).join(', ');
  return db.prepare(`UPDATE ${table} SET ${sets} WHERE id = @__id`).run({ ...changes, __id: id }).changes;
}

module.exports = { ID_PATTERN, newId, nowIso, toPaise, fromPaise, toDateKey, toApiDate, placeholders, insertRow, updateRow };
