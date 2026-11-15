const { z } = require('zod');
const { entityId, pagination } = require('../../core/schemas');
const sender = z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,32}$/, 'Use the exact SMS sender ID');
const accounts = z.object({ body: z.object({ accounts: z.array(z.object({
  bank: z.enum(['sbi', 'kotak']), last4: z.string().regex(/^\d{4}$/),
  senders: z.array(sender).min(1).max(10).transform((a) => [...new Set(a)]),
}).strict()).min(1).max(2).refine((a) => new Set(a.map((b) => b.bank)).size === a.length, 'One account per bank in this version') }).strict() });
const device = z.object({ body: z.object({ name: z.string().trim().min(1).max(80) }).strict() });
const ingest = z.object({ body: z.object({
  eventId: z.string().regex(/^[\w.-]{1,128}$/), sender,
  body: z.string().trim().min(1).max(1500), receivedAt: z.iso.datetime({ offset: true }),
}).strict() });
const eventId = z.object({ params: z.object({ id: entityId }) });
const confirm = z.object({ params: z.object({ id: entityId }), body: z.object({
  date: z.iso.date(), amount: z.number().positive().refine((n) => Number.isSafeInteger(Math.round(n * 100)) && Math.abs(n * 100 - Math.round(n * 100)) < 0.0001),
  type: z.enum(['debit', 'credit']), refNo: z.string().regex(/^\d{12}$/),
  last4: z.string().regex(/^\d{4}$/), description: z.string().trim().min(1).max(500),
}).strict() });
const list = z.object({ query: z.object({ ...pagination, status: z.enum(['captured', 'reconciled', 'duplicate', 'review', 'ignored', 'dismissed']).optional() }) });
module.exports = { accounts, device, ingest, eventId, confirm, list };
