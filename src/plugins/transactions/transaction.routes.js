const { Router } = require('express');
const validate = require('../../core/validate');
const schemas = require('./transaction.validation');
const controller = require('./transaction.controller');

const router = Router();

router.get('/', validate(schemas.listTransactions), controller.list);
router.get('/summary', validate(schemas.summary), controller.summary);
router.post('/', validate(schemas.createTransaction), controller.create);
router.post('/bulk', validate(schemas.bulkCreateTransactions), controller.bulkCreate);
router.patch('/bulk', validate(schemas.bulkUpdateTransactions), controller.bulkUpdate);
router.get('/:id', validate(schemas.transactionId), controller.getOne);
router.patch('/:id', validate(schemas.updateTransaction), controller.update);
router.delete('/:id', validate(schemas.transactionId), controller.remove);

module.exports = router;
