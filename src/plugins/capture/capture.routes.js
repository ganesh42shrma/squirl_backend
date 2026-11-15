const { Router } = require('express');
const validate = require('../../core/validate');
const rateLimit = require('../../core/rateLimit');
const { sendSuccess } = require('../../core/response');
const schemas = require('./capture.validation');
const service = require('./capture.service');

const router = Router();

// Rules previews run on every pause in typing and cost nothing; AI previews call a model, so they're capped.
router.post('/preview', validate(schemas.preview), async (req, res) => {
  if (req.body.ai) await rateLimit.hit(`capture-ai:${req.user.id}`, { limit: 20, windowSec: 60 });
  sendSuccess(res, await service.preview(req.user.id, req.body.text, { useAi: req.body.ai }));
});
router.post('/', validate(schemas.commit), (req, res) => {
  const { data, events } = service.commit(req.user.id, req.body);
  sendSuccess(res, data, { status: 201, events });
});
router.get('/inbox', (req, res) => sendSuccess(res, service.listInbox(req.user.id)));
router.get('/search', validate(schemas.search), (req, res) => sendSuccess(res, service.search(req.user.id, req.query.q)));
router.post('/:id/undo', validate(schemas.byId), (req, res) => {
  const { data, events } = service.undo(req.user.id, req.params.id);
  sendSuccess(res, data, { message: 'Undone', events });
});
router.post('/:id/dismiss', validate(schemas.byId), (req, res) => sendSuccess(res, service.dismiss(req.user.id, req.params.id)));

module.exports = router;
