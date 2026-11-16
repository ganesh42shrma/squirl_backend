const { z } = require('zod');
const { entityId } = require('../../core/schemas');

const { OWNER_TYPES } = require('./media.owners');

const ownerType = z.enum(OWNER_TYPES);

// Multipart fields arrive as plain strings; the file itself is checked by its bytes in the service.
// A habit's photos belong to one day (YYYY-MM-DD); nothing else takes a day.
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid day').refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Invalid day');
const onlyHabitsHaveDays = (b, ctx) => {
  if (b.ownerType !== 'habit' && b.day !== undefined) ctx.addIssue({ code: 'custom', path: ['day'], message: 'Only habit photos have a day' });
};
const upload = z.object({
  body: z.object({ ownerType, ownerId: entityId, day: day.optional() }).superRefine((b, ctx) => {
    if (b.ownerType === 'habit' && b.day === undefined) ctx.addIssue({ code: 'custom', path: ['day'], message: 'Say which day this photo is for' });
    onlyHabitsHaveDays(b, ctx);
  }),
});
const list = z.object({ query: z.object({ ownerType, ownerId: entityId, day: day.optional() }).superRefine(onlyHabitsHaveDays) });
const attachmentId = z.object({ params: z.object({ id: entityId }) });
const mediaId = z.object({ params: z.object({ mediaId: entityId }) });

module.exports = { upload, list, attachmentId, mediaId };
