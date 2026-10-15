const { z } = require('zod');
const mongoose = require('mongoose');

// Small reusable Zod pieces shared across plugin validation files.
const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), { message: 'Invalid id' });

const idParams = z.object({ id: objectId });

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
};

module.exports = { objectId, idParams, pagination };
