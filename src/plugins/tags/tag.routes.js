const { Router } = require('express');
const validate = require('../../core/validate');
const schemas = require('./tag.validation');
const controller = require('./tag.controller');

const router = Router();

router.get('/', validate(schemas.listTags), controller.list);
router.post('/', validate(schemas.createTag), controller.create);
router.patch('/:id', validate(schemas.updateTag), controller.update);
router.delete('/:id', validate(schemas.tagId), controller.remove);

module.exports = router;
