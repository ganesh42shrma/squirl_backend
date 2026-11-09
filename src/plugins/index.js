const { Router } = require('express');
const { requireAuth } = require('../core/auth');

const router = Router();

// Public
router.use('/health', require('./health/health.routes'));
router.use('/auth', require('./auth/auth.routes'));

// Everything below needs a signed-in user; services scope every query to req.user.id.
router.use(requireAuth);
router.use('/users', require('./users/user.routes'));
router.use('/categories', require('./categories/category.routes'));
router.use('/tags', require('./tags/tag.routes'));
router.use('/transactions', require('./transactions/transaction.routes'));
router.use('/imports', require('./imports/import.routes'));
router.use('/insights', require('./insights/insights.routes'));
router.use('/rules', require('./rules/rules.routes'));
router.use('/commitments', require('./commitments/commitment.routes'));
router.use('/goals', require('./goals/goal.routes'));
router.use('/ai', require('./ai/ai.routes'));
router.use('/feeds', require('./feeds/feeds.routes'));

module.exports = router;
