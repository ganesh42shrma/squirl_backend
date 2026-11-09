const { toPaise, fromPaise, placeholders } = require('../../core/sql');

const SORT_COLUMNS = {
  date: 't.date',
  amount: 't.amount_paise',
  description: 't.description',
  createdAt: 't.created_at',
};

/**
 * Builds a SQL WHERE clause (on alias `t`) from list/summary query params, always scoped to
 * `userId` first: there is no way to build a filter that reads another account's rows.
 * `categoryIds` is the requested category plus its subcategories (resolved by the service).
 * Values always go in `params`; only fixed SQL text is concatenated.
 */
function buildFilter(userId, query = {}, categoryIds) {
  if (!userId) throw new Error('buildFilter needs a userId');
  const clauses = [];
  const params = [];
  const add = (clause, ...values) => {
    clauses.push(clause);
    params.push(...values);
  };

  add('t.user_id = ?', userId);

  // `from`/`to` are YYYY-MM-DD strings, both inclusive.
  if (query.from) add('t.date >= ?', query.from);
  if (query.to) add('t.date <= ?', query.to);

  if (query.type) add('t.type = ?', query.type);
  if (query.account) add('t.account = ?', query.account.toLowerCase());
  if (query.source) add('t.source = ?', query.source);
  if (query.tag) add('EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = t.id AND tt.user_id = t.user_id AND tt.tag = ?)', query.tag);
  if (query.importId) add('t.import_id = ?', query.importId);
  if (query.auto) add('t.auto_categorized = 1');

  if (query.category === 'none') add('t.category_id IS NULL');
  else if (categoryIds?.length) add(`t.category_id IN (${placeholders(categoryIds)})`, ...categoryIds);

  if (query.minAmount !== undefined) add('t.amount_paise >= ?', toPaise(query.minAmount));
  if (query.maxAmount !== undefined) add('t.amount_paise <= ?', toPaise(query.maxAmount));

  if (query.search) {
    // Case-insensitive substring match (ASCII), like the old regex search.
    const needle = query.search.toLowerCase();
    add(
      "(instr(lower(t.description), ?) > 0 OR instr(lower(ifnull(t.notes, '')), ?) > 0 OR instr(lower(ifnull(t.ref_no, '')), ?) > 0)",
      needle,
      needle,
      needle,
    );
  }

  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

// "-date" → "t.date DESC, t.rowid DESC". rowid (insertion order) keeps pagination stable.
function buildSort(sort = '-date') {
  const desc = sort.startsWith('-');
  const column = SORT_COLUMNS[desc ? sort.slice(1) : sort] || 't.date';
  const dir = desc ? 'DESC' : 'ASC';
  return `${column} ${dir}, t.rowid ${dir}`;
}

// SQL expression for each groupBy. `c` is the row's category.
const SUMMARY_GROUP_KEYS = {
  total: null, // everything in a single row
  category: 't.category_id', // exact category (subcategory if one is set)
  topCategory: 'ifnull(c.parent_id, t.category_id)', // subcategories rolled into their parent
  categoryType: "ifnull(c.type, 'uncategorized')", // expense / income / investment / …
  account: 't.account',
  tag: 'tt.tag', // a row with 2 tags counts in both
  month: 'substr(t.date, 1, 7)',
};

const CATEGORY_GROUPS = ['category', 'topCategory'];

const SUMS = `
  ifnull(sum(CASE WHEN t.type = 'debit' THEN t.amount_paise END), 0) AS debit_paise,
  ifnull(sum(CASE WHEN t.type = 'credit' THEN t.amount_paise END), 0) AS credit_paise,
  count(*) AS count`;

/** One SQL query producing a row per group (or one row for 'total') with debit/credit sums in paise. */
function buildSummaryQuery(groupBy, filter) {
  const joins = ['LEFT JOIN active_categories c ON c.id = t.category_id AND c.user_id = t.user_id'];
  if (groupBy === 'tag') joins.push('JOIN transaction_tags tt ON tt.transaction_id = t.id AND tt.user_id = t.user_id');

  if (groupBy === 'total') {
    return { sql: `SELECT ${SUMS} FROM active_transactions t ${filter.where}`, params: filter.params };
  }

  const grouped = `SELECT ${SUMMARY_GROUP_KEYS[groupBy]} AS key, ${SUMS}
    FROM active_transactions t ${joins.join(' ')} ${filter.where} GROUP BY 1`;
  const order = groupBy === 'month' ? 'ORDER BY key ASC' : 'ORDER BY debit_paise DESC, credit_paise DESC';

  if (!CATEGORY_GROUPS.includes(groupBy)) {
    return { sql: `SELECT g.*, g.key AS label FROM (${grouped}) g ${order}`, params: filter.params };
  }

  // Label a category group "Parent › Child", or "Uncategorized".
  const sql = `
    SELECT g.*, gc.type AS category_type,
           CASE WHEN gc.id IS NULL THEN 'Uncategorized'
                WHEN gp.id IS NOT NULL THEN gp.name || ' › ' || gc.name
                ELSE gc.name END AS label
    FROM (${grouped}) g
    LEFT JOIN active_categories gc ON gc.id = g.key
    LEFT JOIN active_categories gp ON gp.id = gc.parent_id
    ${order}`;
  return { sql, params: filter.params };
}

/** A summary SQL row → API shape (rupees, rounded to 2 decimals). */
function toSummaryRow(row, groupBy) {
  const totals = {
    count: row.count,
    debit: fromPaise(row.debit_paise),
    credit: fromPaise(row.credit_paise),
    net: fromPaise(row.credit_paise - row.debit_paise),
  };
  if (groupBy === 'total') return totals;
  return {
    key: row.key,
    label: row.label,
    ...(CATEGORY_GROUPS.includes(groupBy) && { categoryType: row.category_type ?? undefined }),
    ...totals,
  };
}

module.exports = { buildFilter, buildSort, buildSummaryQuery, toSummaryRow, SUMMARY_GROUP_KEYS };
