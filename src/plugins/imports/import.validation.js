const { z } = require('zod');
const { idParams, pagination } = require('../../core/schemas');
const { BANKS } = require('./import.model');

const createImport = z.object({
  body: z.object({
    bank: z.enum(BANKS),
    password: z.string().max(100).optional(),
  }),
});

const listImports = z.object({ query: z.object({ ...pagination }) });

const importId = z.object({ params: idParams });

// Shape the Python parser service must return (see README → "Parser service contract").
const parserResponse = z.object({
  periodFrom: z.string().nullish(),
  periodTo: z.string().nullish(),
  transactions: z.array(
    z.object({
      date: z.string(),
      description: z.string().default(''),
      refNo: z.string().nullish(),
      debit: z.coerce.number().nullish(),
      credit: z.coerce.number().nullish(),
      balance: z.coerce.number().nullish(),
    }),
  ),
});

module.exports = { createImport, listImports, importId, parserResponse };
