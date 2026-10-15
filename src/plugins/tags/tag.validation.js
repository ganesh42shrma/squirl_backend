const { z } = require('zod');
const { idParams } = require('../../core/schemas');
const { normalizeTag } = require('./tag.helper');

const tagName = z.string().trim().min(1).max(40).transform(normalizeTag);

const tagBody = z.object({
  name: tagName,
  group: tagName.optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex color like #ff8800').optional(),
});

const listTags = z.object({ query: z.object({ group: tagName.optional() }) });

const createTag = z.object({ body: tagBody });

const updateTag = z.object({
  params: idParams,
  body: tagBody.partial().refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
});

const tagId = z.object({ params: idParams });

module.exports = { listTags, createTag, updateTag, tagId };
