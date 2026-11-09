const { z } = require('zod');
const { ID_PATTERN } = require('./sql');

// Small reusable Zod pieces shared across plugin validation files.
const entityId = z.string().regex(ID_PATTERN, 'Invalid id');

const idParams = z.object({ id: entityId });

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
};

module.exports = { entityId, idParams, pagination };
