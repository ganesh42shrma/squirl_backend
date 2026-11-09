const { Router } = require('express');
const validate = require('../../core/validate');
const schemas = require('./ai.validation');
const controller = require('./ai.controller');

const router = Router();

router.get('/settings', controller.getSettings);
router.patch('/settings', validate(schemas.update), controller.updateSettings);
router.get('/models', validate(schemas.models), controller.models);
router.post('/test', validate(schemas.test), controller.test);

module.exports = router;
