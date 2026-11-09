const { Router } = require('express');
const validate = require('../../core/validate');
const schemas = require('./insights.validation');
const controller = require('./insights.controller');

const router = Router();

router.get('/balances', validate(schemas.balances), controller.balances);
router.get('/history', validate(schemas.history), controller.history);
router.post('/history/summary', validate(schemas.summary), controller.summary);
router.get('/llm', controller.llmStatus);
router.get('/suggestions', validate(schemas.listSuggestions), controller.listSuggestions);
router.post('/suggestions/apply', validate(schemas.applySuggestions), controller.applySuggestions);
router.post('/suggestions/run', controller.runSuggestions);
router.post('/suggestions/:id/dismiss', validate(schemas.suggestionId), controller.dismissSuggestion);

module.exports = router;
