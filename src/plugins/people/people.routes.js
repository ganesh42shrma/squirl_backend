const { Router } = require('express');
const validate = require('../../core/validate');
const { uploadVcf } = require('../../core/upload');
const schemas = require('./people.validation');
const controller = require('./people.controller');

const router = Router();

router.get('/', validate(schemas.listPeople), controller.list);
router.post('/', validate(schemas.createPerson), controller.create);
router.post('/import', uploadVcf, controller.importContacts);
router.post('/remove', validate(schemas.removePeople), controller.removeMany); // before /:id
router.get('/:id', validate(schemas.personId), controller.getOne);
router.patch('/:id', validate(schemas.updatePerson), controller.update);
router.delete('/:id', validate(schemas.personId), controller.remove);

module.exports = router;
