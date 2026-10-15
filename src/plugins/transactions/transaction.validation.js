const { z } = require('zod');
const { objectId, idParams, pagination } = require('../../core/schemas');
const { TRANSACTION_TYPES, SOURCES } = require('./transaction.model');
const { SUMMARY_GROUP_KEYS } = require('./transaction.helper');
const { normalizeTag, normalizeTags } = require('../tags/tag.helper');

const tags = z.array(z.string().max(40)).max(20).transform(normalizeTags);
const tag = z.string().trim().max(40).transform(normalizeTag);
const summaryGroups = Object.keys(SUMMARY_GROUP_KEYS).filter((g) => g !== 'total');

const transactionBody = z.object({
  date: z.coerce.date({ error: 'A valid date is required (YYYY-MM-DD)' }),
  description: z.string().trim().min(1).max(500),
  amount: z.coerce.number().positive(),
  type: z.enum(TRANSACTION_TYPES).default('debit'),
  category: objectId.nullable().optional(),
  tags: tags.optional(),
  notes: z.string().trim().max(1000).optional(),
  account: z.string().trim().max(30).optional(),
  paymentMode: z.string().trim().max(30).optional(),
});

const createTransaction = z.object({ body: transactionBody });

const bulkCreateTransactions = z.object({
  body: z.object({ transactions: z.array(transactionBody).min(1).max(1000) }),
});

const updateTransaction = z.object({
  params: idParams,
  body: transactionBody
    .partial()
    .refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
});

const bulkUpdateTransactions = z.object({
  body: z.object({
    ids: z.array(objectId).min(1).max(1000),
    set: z
      .object({
        category: objectId.nullable().optional(),
        tags: tags.optional(),
        addTags: tags.optional(),
        removeTags: tags.optional(),
      })
      .refine((s) => Object.keys(s).length > 0, 'Nothing to update')
      .refine((s) => !(s.tags && (s.addTags || s.removeTags)), 'Use either tags or addTags/removeTags, not both'),
  }),
});

const transactionId = z.object({ params: idParams });

const dateString = z.iso.date();

const listTransactions = z.object({
  query: z.object({
    from: dateString.optional(),
    to: dateString.optional(),
    type: z.enum(TRANSACTION_TYPES).optional(),
    category: z.union([objectId, z.literal('none')]).optional(),
    tag: tag.optional(),
    account: z.string().trim().optional(),
    source: z.enum(SOURCES).optional(),
    importId: objectId.optional(),
    search: z.string().trim().max(100).optional(),
    minAmount: z.coerce.number().min(0).optional(),
    maxAmount: z.coerce.number().min(0).optional(),
    sort: z.string().default('-date'),
    ...pagination,
  }),
});

const summary = z.object({
  query: z.object({
    from: dateString.optional(),
    to: dateString.optional(),
    type: z.enum(TRANSACTION_TYPES).optional(),
    account: z.string().trim().optional(),
    category: z.union([objectId, z.literal('none')]).optional(),
    tag: tag.optional(),
    groupBy: z.enum(summaryGroups).default('category'),
  }),
});

module.exports = {
  createTransaction,
  bulkCreateTransactions,
  updateTransaction,
  bulkUpdateTransactions,
  transactionId,
  listTransactions,
  summary,
};
