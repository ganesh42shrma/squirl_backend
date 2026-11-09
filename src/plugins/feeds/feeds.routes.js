const { Router } = require('express');
const validate = require('../../core/validate');
const schemas = require('./feeds.validation');
const controller = require('./feeds.controller');

const router = Router();

router.get('/settings', controller.settings);
router.patch('/settings', validate(schemas.update), controller.updateSettings);
router.get('/weather', controller.weather);
router.get('/places', validate(schemas.search), controller.places);
router.get('/rates', controller.rates);
router.get('/currencies', controller.currencies);
router.get('/funds', controller.funds);
router.get('/funds/search', validate(schemas.search), controller.fundSearch);
router.get('/crypto', controller.coins);
router.get('/crypto/search', validate(schemas.search), controller.coinSearch);
router.get('/news', controller.news);
router.get('/inflation', controller.inflation);
router.get('/titles-search', validate(schemas.search), controller.titleSearch);
router.get('/titles/:list', validate(schemas.titles), controller.titles);
router.get('/cricket', controller.cricket);
router.get('/stocks', controller.stocks);
router.get('/stocks/search', validate(schemas.search), controller.stockSearch);
router.get('/watchlist', controller.watchlist);
router.put('/watchlist', validate(schemas.watch), controller.setWatch);

module.exports = router;
