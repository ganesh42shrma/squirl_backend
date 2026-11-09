const { Router } = require('express');
const validate = require('../../core/validate');
const schemas = require('./user.validation');
const controller = require('./user.controller');

const router = Router();

router.get('/me', controller.me);
router.get('/me/family-sync', controller.familySync);
router.patch('/me', validate(schemas.updateProfile), controller.update);
router.post('/me/family-contacts', validate(schemas.addFamilyMember), controller.addFamilyMember);
router.post('/me/financial-data/reset', validate(schemas.resetFinancialData), controller.resetFinancialData);
router.post('/me/password', validate(schemas.changePassword), controller.changePassword);
router.delete('/me', validate(schemas.deleteAccount), controller.remove);

module.exports = router;
