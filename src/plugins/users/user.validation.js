const { z } = require('zod');
const { normalizePhone } = require('./contact.helper');
const { entityId } = require('../../core/schemas');

const email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')).pipe(z.string().max(200));
const name = z.string().trim().min(1, 'Enter your name').max(80);
// Length is what matters most; 10+ characters, no composition rules.
const password = z.string().min(10, 'Use at least 10 characters').max(200);
const familyContact = z.object({
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().max(32).refine((v) => !v || normalizePhone(v), 'Enter a 10-digit Indian mobile number, optionally with +91').transform((v) => normalizePhone(v) || '').default(''),
  relationship: z.string().trim().max(80).default(''),
  aliases: z.array(z.string().trim().min(2).max(80)).max(20).default([]),
});
const dashboardConfig = z.object({
  version: z.literal(1),
  widgets: z.array(z.object({
    id: z.enum(['overview', 'attention', 'balance', 'monthStats', 'breakdown', 'cashflow', 'trend', 'accountSplit', 'whereItWent', 'comingUp', 'recent']),
    enabled: z.boolean(),
    width: z.enum(['half', 'full']),
    period: z.enum(['latest', '3m', '6m', '12m', 'all']),
    account: z.string().trim().regex(/^[a-z0-9_-]{1,30}$/),
    metric: z.enum(['expense', 'income', 'investment']),
  })).min(1).max(11).refine((w) => new Set(w.map((x) => x.id)).size === w.length, 'Widgets must be unique')
    .refine((w) => w.some((x) => x.enabled), 'Choose at least one widget'),
});

const updateProfile = z.object({
  body: z.object({
    name: name.optional(), email: email.optional(),
    familyContacts: z.array(familyContact).max(200).optional(),
    dashboardConfig: dashboardConfig.optional(),
  }).refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
});

const changePassword = z.object({
  body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: password }),
});

const deleteAccount = z.object({ body: z.object({ password: z.string().min(1).max(200) }) });
const addFamilyMember = z.object({ body: familyContact.extend({ transactionId: entityId }) });
const resetFinancialData = z.object({ body: z.object({ confirmation: z.literal('RESET') }) });

module.exports = { email, name, password, updateProfile, changePassword, deleteAccount, addFamilyMember, resetFinancialData };
