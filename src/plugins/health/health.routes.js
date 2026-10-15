const { Router } = require('express');
const controller = require('./health.controller');

const router = Router();

router.get('/', controller.getHealth);

module.exports = router;
