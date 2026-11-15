const { z } = require('zod');
const { entityId, idParams } = require('../../core/schemas');
const { MAX_CLAUSES } = require('./capture.parser');

const day = z.iso.date();
const text = z.string().trim().min(1, 'Type something to capture').max(500);
// The palette's per-submission key. Letters, digits, "-" and "_" only: it is stored and range-queried as is.
const clientId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid client id');

// The palette sends back the actions it previewed. They are treated like any other client input:
// every field is re-checked here and ownership (category, habit) is checked in the service.
const action = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('transaction'),
    data: z.object({
      date: day,
      description: z.string().trim().min(1).max(500),
      amount: z.number().positive().max(1e9),
      direction: z.enum(['debit', 'credit']),
      category: entityId.nullable().optional(),
      categoryName: z.string().max(80).optional(), // display only; never trusted
      autoCategorized: z.boolean().optional(),
      paymentMode: z.string().trim().max(30).optional(),
      account: z.string().trim().max(30).optional(),
    }).strict(),
  }),
  z.object({
    type: z.literal('task'),
    data: z.object({
      title: z.string().trim().min(1).max(200),
      dueDate: day.nullable().optional(),
      dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM').nullable().optional(),
    }).strict(),
  }),
  z.object({
    type: z.literal('habit'),
    data: z.object({
      habitId: entityId,
      name: z.string().max(80).optional(), // display only
      quantity: z.number().min(0).max(100000).optional(),
      date: day.optional(),
    }).strict(),
  }),
  z.object({ type: z.literal('note'), data: z.object({ text: z.string().trim().min(1).max(500) }).strict() }),
]);

const preview = z.object({ body: z.object({ text, ai: z.boolean().default(false) }).strict() });
const categorise = z.object({ body: z.object({ text }).strict() });
const commit = z.object({
  body: z.object({
    text,
    actions: z.array(action).min(1).max(MAX_CLAUSES).optional(),
    inboxId: entityId.optional(),
    engine: z.enum(['rules', 'ai']).default('rules'),
    clientId: clientId.optional(),
  }).strict(),
});
const search = z.object({ query: z.object({ q: z.string().trim().min(2).max(100) }) });
const byId = z.object({ params: idParams });

module.exports = { preview, categorise, commit, search, byId, action };
