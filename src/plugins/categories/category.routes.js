const { Router } = require('express');
const validate = require('../../core/validate');
const schemas = require('./category.validation');
const controller = require('./category.controller');

const router = Router();

router.get('/', validate(schemas.listCategories), controller.list);
router.post('/', validate(schemas.createCategory), controller.create);
router.patch('/:id', validate(schemas.updateCategory), controller.update);
router.delete('/:id', validate(schemas.categoryId), controller.remove);

module.exports = router;
