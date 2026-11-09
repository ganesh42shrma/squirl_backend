const { z } = require('zod');
const { entityId, idParams } = require('../../core/schemas');
const { KINDS, FREQUENCIES } = require('./commitment.model');

const money = z.coerce.number().positive().max(1e10);
const date = z.iso.date();

const body = z.object({
  kind: z.enum(KINDS),
  name: z.string().trim().min(1).max(80),
  lender: z.string().trim().max(80).nullable().optional(),
  amount: money.nullable().optional(), // EMI / charge per period
  frequency: z.enum(FREQUENCIES).default('monthly'),
  dueDay: z.coerce.number().int().min(1).max(31),
  startDate: date,
  endDate: date.nullable().optional(),
  principal: money.nullable().optional(),
  interestRate: z.coerce.number().min(0).max(100).nullable().optional(),
  tenureMonths: z.coerce.number().int().min(1).max(600).nullable().optional(),
  paidPrincipal: z.coerce.number().min(0).max(1e10).nullable().optional(),
  outstanding: z.coerce.number().min(0).max(1e10).nullable().optional(),
  balanceAsOf: date.nullable().optional(),
  account: z.string().trim().toLowerCase().max(30).nullable().optional(),
  category: entityId.nullable().optional(),
  matchKey: z.string().trim().max(120).nullable().optional(),
  remindDays: z.coerce.number().int().min(0).max(30).default(3),
  active: z.boolean().default(true),
  notes: z.string().trim().max(500).nullable().optional(),
});

const withDates = (schema) =>
  schema.refine((b) => !b.endDate || !b.startDate || b.endDate >= b.startDate, { message: 'The end date is before the start date', path: ['endDate'] });

const create = z.object({ body: withDates(body) });
const update = z.object({
  params: idParams,
  body: withDates(body.partial()).refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
});
const byId = z.object({ params: idParams });
const merchants = z.object({ query: z.object({ search: z.string().trim().max(60).optional() }) });

module.exports = { create, update, byId, merchants };
