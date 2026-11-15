const { Router } = require('express');
const validate = require('../../core/validate');
const { sendSuccess } = require('../../core/response');
const rateLimit = require('../../core/rateLimit');
const schemas = require('./sms.validation');
const service = require('./sms.service');

// This router is mounted before browser-session auth, and authenticates ONLY this endpoint.
const ingestRouter = Router();
ingestRouter.post('/ingest', (req, res, next) => {
  req.smsDevice = service.authenticate(req.get('Authorization'));
  next();
}, validate(schemas.ingest), async (req, res) => {
  await rateLimit.hit(`sms-ingest:${req.smsDevice.id}`, { limit: 120, windowSec: 60 });
  const result = service.ingest(req.smsDevice, req.body);
  require('../notifications/notification.worker').nudge();
  sendSuccess(res, result);
});

// Management and review inherit the ordinary session and CSRF guards.
const router = Router();
router.get('/accounts', (req, res) => sendSuccess(res, { accounts: service.listAccounts(req.user.id) }));
router.put('/accounts', validate(schemas.accounts), (req, res) => sendSuccess(res, { accounts: service.saveAccounts(req.user.id, req.body) }));
router.get('/devices', (req, res) => sendSuccess(res, { devices: service.listDevices(req.user.id) }));
router.post('/devices', validate(schemas.device), async (req, res) => {
  await rateLimit.hit(`sms-pair:${req.user.id}`, { limit: 10, windowSec: 3600 });
  sendSuccess(res, service.createDevice(req.user.id, req.body), { status: 201 });
});
router.delete('/devices/:id', validate(schemas.eventId), (req, res) => { service.revokeDevice(req.user.id, req.params.id); sendSuccess(res, null); });
router.get('/events', validate(schemas.list), (req, res) => {
  const { items, meta } = service.listEvents(req.user.id, req.query);
  sendSuccess(res, { items }, { meta });
});
router.post('/events/:id/confirm', validate(schemas.confirm), (req, res) => {
  const result = service.reviewEvent(req.user.id, req.params.id, req.body);
  require('../notifications/notification.worker').nudge();
  sendSuccess(res, result);
});
router.post('/events/:id/dismiss', validate(schemas.eventId), (req, res) => sendSuccess(res, service.reviewEvent(req.user.id, req.params.id)));
module.exports = { router, ingestRouter };
