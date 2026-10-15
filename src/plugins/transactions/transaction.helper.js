const mongoose = require('mongoose');

const DAY_MS = 24 * 60 * 60 * 1000;

const SORT_FIELDS = {
  date: 'date',
  amount: 'amount',
  description: 'description',
  createdAt: 'createdAt',
};

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `from`/`to` are YYYY-MM-DD strings; `to` is inclusive of the whole day.
function buildDateRange(from, to) {
  if (!from && !to) return undefined;
  const range = {};
  if (from) range.$gte = new Date(from);
  if (to) range.$lt = new Date(new Date(to).getTime() + DAY_MS);
  return range;
}

/**
 * Builds a Mongo filter from list/summary query params.
 * `categoryIds` is the requested category plus its subcategories (resolved by the service).
 */
function buildFilter(query = {}, categoryIds) {
  const filter = {};

  const date = buildDateRange(query.from, query.to);
  if (date) filter.date = date;

  if (query.type) filter.type = query.type;
  if (query.account) filter.account = query.account.toLowerCase();
  if (query.source) filter.source = query.source;
  if (query.tag) filter.tags = query.tag;
  if (query.importId) filter.importId = new mongoose.Types.ObjectId(query.importId);

  if (query.category === 'none') filter.category = null;
  else if (categoryIds?.length) filter.category = { $in: categoryIds };

  if (query.minAmount !== undefined || query.maxAmount !== undefined) {
    filter.amount = {};
    if (query.minAmount !== undefined) filter.amount.$gte = query.minAmount;
    if (query.maxAmount !== undefined) filter.amount.$lte = query.maxAmount;
  }

  if (query.search) {
    const regex = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [{ description: regex }, { notes: regex }, { refNo: regex }];
  }

  return filter;
}

// "-date" → { date: -1 }. A stable tiebreaker keeps pagination consistent.
function buildSort(sort = '-date') {
  const desc = sort.startsWith('-');
  const field = SORT_FIELDS[desc ? sort.slice(1) : sort] || 'date';
  return { [field]: desc ? -1 : 1, _id: desc ? -1 : 1 };
}

const SUMMARY_GROUP_KEYS = {
  total: null, // everything in a single row
  category: '$category', // exact category (subcategory if one is set)
  topCategory: { $ifNull: ['$cat.parent', '$category'] }, // subcategories rolled into their parent
  categoryType: { $ifNull: ['$cat.type', 'uncategorized'] }, // expense / income / investment / …
  account: '$account',
  tag: '$tags',
  month: { $dateToString: { format: '%Y-%m', date: '$date' } },
};

const CATEGORY_GROUPS = ['category', 'topCategory'];

const lookupCategory = (localField, as) => ({
  $lookup: { from: 'categories', localField, foreignField: '_id', as },
});

// After grouping by a category id: label it "Parent › Child", or "Uncategorized".
const categoryLabelStages = [
  lookupCategory('_id', 'c'),
  { $set: { c: { $first: '$c' } } },
  lookupCategory('c.parent', 'p'),
  {
    $set: {
      categoryType: '$c.type',
      label: {
        $switch: {
          branches: [
            { case: { $not: ['$c'] }, then: 'Uncategorized' },
            { case: { $gt: [{ $size: '$p' }, 0] }, then: { $concat: [{ $first: '$p.name' }, ' › ', '$c.name'] } },
          ],
          default: '$c.name',
        },
      },
    },
  },
];

// Aggregation stages that produce one row per group with debit/credit totals.
function buildSummaryStages(groupBy) {
  const stages = [];

  if (groupBy === 'tag') stages.push({ $unwind: '$tags' });
  if (groupBy === 'topCategory' || groupBy === 'categoryType') {
    stages.push(lookupCategory('category', 'cat'), { $set: { cat: { $first: '$cat' } } });
  }

  stages.push({
    $group: {
      _id: SUMMARY_GROUP_KEYS[groupBy],
      debit: { $sum: { $cond: [{ $eq: ['$type', 'debit'] }, '$amount', 0] } },
      credit: { $sum: { $cond: [{ $eq: ['$type', 'credit'] }, '$amount', 0] } },
      count: { $sum: 1 },
    },
  });

  if (CATEGORY_GROUPS.includes(groupBy)) stages.push(...categoryLabelStages);
  else if (groupBy !== 'total') stages.push({ $set: { label: '$_id' } });

  stages.push({
    $project: {
      _id: 0,
      ...(groupBy !== 'total' && { key: '$_id', label: 1 }),
      ...(CATEGORY_GROUPS.includes(groupBy) && { categoryType: 1 }),
      count: 1,
      debit: { $round: ['$debit', 2] },
      credit: { $round: ['$credit', 2] },
      net: { $round: [{ $subtract: ['$credit', '$debit'] }, 2] },
    },
  });

  if (groupBy !== 'total') {
    stages.push({ $sort: groupBy === 'month' ? { key: 1 } : { debit: -1, credit: -1 } });
  }

  return stages;
}

module.exports = { buildFilter, buildSort, buildSummaryStages, SUMMARY_GROUP_KEYS };
