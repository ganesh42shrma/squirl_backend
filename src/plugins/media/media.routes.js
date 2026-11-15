const { Router } = require('express');
const validate = require('../../core/validate');
const AppError = require('../../core/AppError');
const { sendSuccess } = require('../../core/response');
const rateLimit = require('../../core/rateLimit');
const { uploadImage } = require('../../core/upload');
const schemas = require('./media.validation');
const service = require('./media.service');

// Mounted at /api/media after requireAuth and the CSRF guard, like every other private router.
const router = Router();

// The one route that works when media is off, so the app can ask whether to show the feature at all.
router.get('/status', (req, res) => sendSuccess(res, service.status()));

// Everything below answers 503 MEDIA_NOT_CONFIGURED until MEDIA_DIR and MEDIA_KEY are set.
router.use((req, res, next) => { service.requireConfigured(); next(); });

router.post('/upload', async (req, res, next) => {
  try {
    await rateLimit.hit(`media-upload:${req.user.id}`, { limit: 30, windowSec: 60 }); // before reading the body
    next();
  } catch (err) { next(err); }
}, uploadImage, validate(schemas.upload), (req, res) => {
  if (!req.file) throw AppError.badRequest('Choose a photo to upload', 'FILE_REQUIRED');
  const { attachment, created } = service.upload(req.user.id, { ...req.body, buffer: req.file.buffer });
  sendSuccess(res, { attachment }, { status: created ? 201 : 200 });
});

router.get('/attachments', validate(schemas.list), (req, res) => {
  sendSuccess(res, { attachments: service.listAttachments(req.user.id, req.query) });
});

router.delete('/attachments/:id', validate(schemas.attachmentId), (req, res) => {
  service.detach(req.user.id, req.params.id);
  sendSuccess(res, null);
});

router.get('/:mediaId/file', validate(schemas.mediaId), async (req, res) => {
  const { buffer, mime, extension } = await service.openFile(req.user.id, req.params.mediaId);
  // Everything about how the browser may treat the bytes is set here, never taken from the client:
  // the type comes from what we verified at upload, and the headers stop it being run as a page.
  res.set({
    'Content-Type': mime,
    'Content-Length': String(buffer.length),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `inline; filename="receipt.${extension}"`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    // The dev frontend (localhost:5173) is a different origin on the same site; helmet's default would block it.
    'Cross-Origin-Resource-Policy': 'same-site',
  });
  res.status(200).end(buffer);
});

module.exports = router;
