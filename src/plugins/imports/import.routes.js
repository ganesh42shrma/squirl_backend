const { Router } = require('express');
const validate = require('../../core/validate');
const { uploadPdf } = require('../../core/upload');
const schemas = require('./import.validation');
const controller = require('./import.controller');

const router = Router();

router.post('/', uploadPdf.single('file'), validate(schemas.createImport), controller.create);
router.get('/', validate(schemas.listImports), controller.list);
router.get('/:id', validate(schemas.importId), controller.getOne);
router.delete('/:id', validate(schemas.importId), controller.remove);

module.exports = router;
