const { z } = require('zod');
const { entityId, idParams } = require('../../core/schemas');
const { KINDS, PLANS, STATUSES, SAVING_IN } = require('./goal.model');

const money = z.coerce.number().positive().max(1e10);
const rate = z.coerce.number().min(0).max(50);
const date = z.iso.date();

const fields = {
  name: z.string().trim().min(1).max(80),
  kind: z.enum(KINDS).default('other'),
  price: money, // what it costs today
  priceAsOf: date.optional(),
  plan: z.enum(PLANS),
  targetDate: date.nullable().optional(),
  monthly: money.nullable().optional(),
  opening: z.coerce.number().min(0).max(1e10).optional(),
  inflationRate: rate.default(6),
  savingIn: z.enum(Object.keys(SAVING_IN)).default('savings'),
  returnRate: rate.optional(),
  startDate: date.optional(),
  watchAccount: z.string().trim().toLowerCase().min(1).max(30).nullable().optional(),
  autoDebit: entityId.nullable().optional(),
  status: z.enum(STATUSES).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
};

// A by-date plan needs a future date; a by-amount plan needs the monthly amount.
const planRules = (schema) =>
  schema
    .refine((b) => b.plan !== 'by_date' || b.targetDate, { message: 'Pick a date for this goal', path: ['targetDate'] })
    .refine((b) => b.plan !== 'by_amount' || b.monthly, { message: 'Enter how much you can save each month', path: ['monthly'] });

const create = z.object({ body: planRules(z.object(fields)) });

// On update nothing is defaulted, so a partial edit never resets a field.
const partial = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, (v.removeDefault ? v.removeDefault() : v).optional()]));
const update = z.object({
  params: idParams,
  body: z.object(partial).refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
});

const plan = z.object({
  body: planRules(
    z.object({
      price: money,
      priceAsOf: date.optional(),
      plan: z.enum(PLANS),
      targetDate: date.nullable().optional(),
      monthly: money.nullable().optional(),
      opening: z.coerce.number().min(0).max(1e10).optional(),
      inflationRate: rate.default(6),
      savingIn: z.enum(Object.keys(SAVING_IN)).optional(),
      returnRate: rate.optional(),
    }),
  ),
});

// Setup help: the name, plus whichever plan the person has typed so far (to work the numbers out).
const assist = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(80),
    notes: z.string().trim().max(300).optional(),
    plan: z.enum(PLANS).optional(),
    targetDate: date.nullable().optional(),
    monthly: money.nullable().optional(),
    opening: z.coerce.number().min(0).max(1e10).optional(),
  }),
});

const byId = z.object({ params: idParams });

const addContribution = z.object({
  params: idParams,
  body: z
    .object({
      amount: z.coerce.number().min(-1e10).max(1e10).refine((v) => v !== 0, 'Enter an amount').optional(),
      date: date.optional(),
      note: z.string().trim().max(120).optional(),
      transactionId: entityId.optional(),
    })
    .refine((b) => b.transactionId || b.amount, { message: 'Enter an amount', path: ['amount'] }),
});

const contribution = z.object({ params: z.object({ id: entityId, contributionId: entityId }) });
const exclude = z.object({ params: idParams, body: z.object({ transactionId: entityId }) });
const candidates = z.object({ params: idParams, query: z.object({ search: z.string().trim().max(60).optional() }) });

module.exports = { create, update, plan, assist, byId, addContribution, contribution, exclude, candidates };
