const { Router } = require('express');
const validate = require('../../core/validate');
const schemas = require('./goal.validation');
const controller = require('./goal.controller');

const router = Router();

router.get('/', controller.list);
router.get('/options', controller.options);
router.post('/plan', validate(schemas.plan), controller.plan);
router.post('/assist', validate(schemas.assist), controller.assist);
router.post('/', validate(schemas.create), controller.create);
router.get('/:id', validate(schemas.byId), controller.getOne);
router.patch('/:id', validate(schemas.update), controller.update);
router.delete('/:id', validate(schemas.byId), controller.remove);
router.get('/:id/candidates', validate(schemas.candidates), controller.candidates);
router.post('/:id/contributions', validate(schemas.addContribution), controller.addContribution);
router.delete('/:id/contributions/:contributionId', validate(schemas.contribution), controller.removeContribution);
router.post('/:id/exclusions', validate(schemas.exclude), controller.exclude);
router.get('/:id/analysis', validate(schemas.byId), controller.getAnalysis);
router.post('/:id/analysis', validate(schemas.byId), controller.refreshAnalysis);

module.exports = router;
