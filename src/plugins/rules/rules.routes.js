const { Router } = require('express');
const validate = require('../../core/validate');
const schemas = require('./rules.validation');
const controller = require('./rules.controller');

const router = Router();

router.get('/', controller.list);
router.post('/apply', controller.apply);
router.delete('/:id', validate(schemas.ruleId), controller.remove);

module.exports = router;
