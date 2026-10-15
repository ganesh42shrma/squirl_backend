const Transaction = require('./transaction.model');
const Category = require('../categories/category.model');
const { getCategoryFamilyIds } = require('../categories/category.service');
const AppError = require('../../core/AppError');
const { buildFilter, buildSort, buildSummaryStages } = require('./transaction.helper');

// Category with its parent's name, so a row can show "Food & Drinks › Food Delivery".
const CATEGORY_POPULATE = {
  path: 'category',
  select: 'name color icon type parent',
  populate: { path: 'parent', select: 'name color icon' },
};

// Filtering by a category also matches its subcategories.
async function buildQueryFilter(query) {
  const hasCategory = query.category && query.category !== 'none';
  const categoryIds = hasCategory ? await getCategoryFamilyIds(query.category) : undefined;
  return buildFilter(query, categoryIds);
}

async function assertCategoriesExist(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return;

  const found = await Category.countDocuments({ _id: { $in: unique } });
  if (found !== unique.length) throw AppError.badRequest('Category not found', 'INVALID_CATEGORY');
}

async function listTransactions(query) {
  const filter = await buildQueryFilter(query);
  const { page, limit } = query;

  const [items, total] = await Promise.all([
    Transaction.find(filter)
      .sort(buildSort(query.sort))
      .skip((page - 1) * limit)
      .limit(limit)
      .populate(CATEGORY_POPULATE)
      .lean(),
    Transaction.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

async function getSummary(query) {
  const filter = await buildQueryFilter(query);

  const [groups, [totals]] = await Promise.all([
    Transaction.aggregate([{ $match: filter }, ...buildSummaryStages(query.groupBy)]),
    // Totals are computed separately: with groupBy=tag one row can count towards several groups.
    Transaction.aggregate([{ $match: filter }, ...buildSummaryStages('total')]),
  ]);

  return {
    groupBy: query.groupBy,
    totals: totals || { debit: 0, credit: 0, net: 0, count: 0 },
    groups,
  };
}

async function getTransaction(id) {
  const transaction = await Transaction.findById(id).populate(CATEGORY_POPULATE).lean();
  if (!transaction) throw AppError.notFound('Transaction not found');
  return transaction;
}

async function createTransaction(data) {
  await assertCategoriesExist([data.category]);
  const created = await Transaction.create({ ...data, source: 'manual' });
  return created.populate(CATEGORY_POPULATE);
}

async function bulkCreateTransactions(rows) {
  await assertCategoriesExist(rows.map((r) => r.category));
  const docs = rows.map((r) => ({ ...r, source: 'manual' }));
  const created = await Transaction.insertMany(docs);
  return { inserted: created.length };
}

async function updateTransaction(id, data) {
  if (data.category) await assertCategoriesExist([data.category]);

  const transaction = await Transaction.findById(id);
  if (!transaction) throw AppError.notFound('Transaction not found');

  transaction.set(data);
  await transaction.save();
  return transaction.populate(CATEGORY_POPULATE);
}

// $addToSet and $pull on the same field can't share one update, so they run as separate steps.
async function bulkUpdateTransactions(ids, { category, tags, addTags, removeTags }) {
  if (category) await assertCategoriesExist([category]);

  const filter = { _id: { $in: ids } };
  const $set = {};
  if (category !== undefined) $set.category = category;
  if (tags) $set.tags = tags;

  const operations = [];
  if (Object.keys($set).length) operations.push({ $set });
  if (addTags?.length) operations.push({ $addToSet: { tags: { $each: addTags } } });
  if (removeTags?.length) operations.push({ $pull: { tags: { $in: removeTags } } });

  let modified = 0;
  for (const update of operations) {
    const result = await Transaction.updateMany(filter, update);
    modified = Math.max(modified, result.modifiedCount);
  }

  const matched = await Transaction.countDocuments(filter);
  return { matched, modified };
}

async function deleteTransaction(id) {
  const deleted = await Transaction.findByIdAndDelete(id);
  if (!deleted) throw AppError.notFound('Transaction not found');
  return deleted;
}

module.exports = {
  listTransactions,
  getSummary,
  getTransaction,
  createTransaction,
  bulkCreateTransactions,
  updateTransaction,
  bulkUpdateTransactions,
  deleteTransaction,
};
