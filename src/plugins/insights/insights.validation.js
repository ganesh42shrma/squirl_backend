const { z } = require('zod');
const { entityId, idParams } = require('../../core/schemas');

const range = z
  .object({ from: z.iso.date().optional(), to: z.iso.date().optional(), account: z.string().trim().toLowerCase().min(1).max(30).optional() })
  .refine((r) => !r.from || !r.to || r.from <= r.to, '`from` must be on or before `to`');

const balances = z.object({ query: range });
const history = z.object({ query: range });
const summary = z.object({ body: range.default({}) });

const listSuggestions = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(0).max(1000).default(100), // 0 = just the job's status
    offset: z.coerce.number().int().min(0).default(0),
  }),
});

const applySuggestions = z.object({
  body: z.object({
    items: z.array(z.object({ id: entityId, categoryId: entityId.optional() })).min(1).max(2000),
  }),
});

const suggestionId = z.object({ params: idParams });

module.exports = { balances, history, summary, listSuggestions, applySuggestions, suggestionId };
