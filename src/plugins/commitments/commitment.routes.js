const { Router } = require('express');
const validate = require('../../core/validate');
const schemas = require('./commitment.validation');
const controller = require('./commitment.controller');

const router = Router();

router.get('/', controller.list);
router.get('/alerts', controller.alerts);
router.get('/detected', controller.detected);
router.get('/merchants', validate(schemas.merchants), controller.merchants);
router.post('/', validate(schemas.create), controller.create);
router.get('/:id', validate(schemas.byId), controller.getOne);
router.get('/:id/schedule', validate(schemas.byId), controller.schedule);
router.patch('/:id', validate(schemas.update), controller.update);
router.delete('/:id', validate(schemas.byId), controller.remove);

module.exports = router;
