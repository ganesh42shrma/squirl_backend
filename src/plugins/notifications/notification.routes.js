const { Router } = require('express');
const validate = require('../../core/validate');
const { sendSuccess } = require('../../core/response');
const rateLimit = require('../../core/rateLimit');
const schemas = require('./notification.validation');
const service = require('./notification.service');
const payments = require('./payment-prompts');

const router = Router();
router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
router.get('/payments/:id', validate(schemas.payment), async (req, res) => sendSuccess(res, await payments.get(req.user.id, req.params.id)));
router.post('/payments/:id/reply', validate(schemas.paymentReply), async (req, res) => {
  await rateLimit.hit(`payment-reply:${req.user.id}`, { limit: 120, windowSec: 60 });
  sendSuccess(res, await payments.reply(req.user.id, req.params.id, req.body.note));
});
router.post('/status', validate(schemas.device), (req, res) => {
  sendSuccess(res, service.deviceStatus(req.user.id, req.sessionID, req.body.endpoint));
});
router.put('/subscription', validate(schemas.subscribe), async (req, res) => {
  await rateLimit.hit(`push-subscribe:${req.user.id}`, { limit: 60, windowSec: 3600 });
  sendSuccess(res, service.subscribe(req.user.id, req.sessionID, req.session.passwordChangedAt, req.body));
});
router.post('/remove', validate(schemas.byEndpoint), (req, res) => {
  service.remove(req.user.id, req.sessionID, req.body.endpoint);
  sendSuccess(res, null);
});
router.post('/test', validate(schemas.byEndpoint), async (req, res) => {
  await rateLimit.hit(`push-test:${req.user.id}`, { limit: 3, windowSec: 60 });
  await service.test(req.user.id, req.sessionID, req.body.endpoint);
  sendSuccess(res, null, { message: 'Test notification sent' });
});
module.exports = router;
