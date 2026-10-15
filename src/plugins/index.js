const { Router } = require('express');

const router = Router();

router.use('/health', require('./health/health.routes'));
router.use('/categories', require('./categories/category.routes'));
router.use('/tags', require('./tags/tag.routes'));
router.use('/transactions', require('./transactions/transaction.routes'));
router.use('/imports', require('./imports/import.routes'));

module.exports = router;
