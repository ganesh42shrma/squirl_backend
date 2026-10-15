const { z } = require('zod');
const { objectId, idParams } = require('../../core/schemas');
const { CATEGORY_TYPES } = require('./category.model');

const categoryBody = z.object({
  name: z.string().trim().min(1).max(50),
  // Ignored for subcategories: they always take their parent's type.
  type: z.enum(CATEGORY_TYPES).optional(),
  parent: objectId.nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex color like #ff8800').optional(),
  icon: z.string().max(30).optional(),
});

const listCategories = z.object({
  query: z.object({
    type: z.enum(CATEGORY_TYPES).optional(),
    view: z.enum(['tree', 'flat']).default('tree'),
  }),
});

const createCategory = z.object({ body: categoryBody });

const updateCategory = z.object({
  params: idParams,
  body: categoryBody.partial().refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
});

const categoryId = z.object({ params: idParams });

module.exports = { listCategories, createCategory, updateCategory, categoryId };
