const { z } = require('zod');
const { entityId } = require('../../core/schemas');

const { OWNER_TYPES } = require('./media.owners');

const ownerType = z.enum(OWNER_TYPES);

// Multipart fields arrive as plain strings; the file itself is checked by its bytes in the service.
const upload = z.object({ body: z.object({ ownerType, ownerId: entityId }) });
const list = z.object({ query: z.object({ ownerType, ownerId: entityId }) });
const attachmentId = z.object({ params: z.object({ id: entityId }) });
const mediaId = z.object({ params: z.object({ mediaId: entityId }) });

module.exports = { upload, list, attachmentId, mediaId };
