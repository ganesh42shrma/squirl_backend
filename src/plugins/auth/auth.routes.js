const { Router } = require('express');
const validate = require('../../core/validate');
const { requireAuth } = require('../../core/auth');
const schemas = require('./auth.validation');
const controller = require('./auth.controller');

const router = Router();

router.post('/register', validate(schemas.register), controller.register);
router.post('/login', validate(schemas.login), controller.login);
router.post('/logout', controller.logout);
router.post('/password/forgot', validate(schemas.forgotPassword), controller.forgotPassword);
router.post('/password/reset', validate(schemas.resetPassword), controller.resetPassword);
router.get('/me', requireAuth, controller.me);

module.exports = router;
