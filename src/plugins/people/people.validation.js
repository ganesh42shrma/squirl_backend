const { z } = require('zod');
const { idParams, pagination, entityId } = require('../../core/schemas');
const { normalizePhone } = require('../users/contact.helper');
const { MAX_PHONES, MAX_ALIASES } = require('./people.model');

const name = z.string().trim().min(2, 'Enter a name').max(80);
const phone = z.string().trim().max(32).refine((v) => normalizePhone(v), 'Enter a 10-digit Indian mobile number, optionally with +91').transform((v) => normalizePhone(v));
const phones = z.array(phone).max(MAX_PHONES).transform((list) => [...new Set(list)]);
const person = {
  phones,
  relationship: z.string().trim().max(80),
  aliases: z.array(z.string().trim().min(2).max(80)).max(MAX_ALIASES),
  isFamily: z.boolean(),
};

const listPeople = z.object({
  query: z.object({
    search: z.string().trim().max(100).optional(),
    family: z.stringbool().optional(),
    ...pagination,
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
});
const createPerson = z.object({ body: z.object({ name, phones: person.phones.default([]), relationship: person.relationship.default(''), aliases: person.aliases.default([]), isFamily: person.isFamily.default(false) }) });
const updatePerson = z.object({
  params: idParams,
  body: z.object({ name: name.optional(), phones: person.phones.optional(), relationship: person.relationship.optional(), aliases: person.aliases.optional(), isFamily: person.isFamily.optional() })
    .refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
});
// Either the exact people ticked, or one named group: never both, never neither.
const removePeople = z.object({
  body: z.object({
    ids: z.array(entityId).min(1).max(500).transform((ids) => [...new Set(ids)]).optional(),
    scope: z.enum(['imported', 'non_family']).optional(),
  }).refine((b) => (b.ids === undefined) !== (b.scope === undefined), 'Choose who to remove'),
});
const personId = z.object({ params: idParams });

module.exports = { listPeople, createPerson, updatePerson, personId, removePeople };
