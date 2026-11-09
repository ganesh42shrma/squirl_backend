const service = require('./feeds.service');
const sources = require('./sources');
const { sendSuccess } = require('../../core/response');

const settings = async (req, res) => sendSuccess(res, await service.getSettings(req.user.id));
const updateSettings = async (req, res) => sendSuccess(res, await service.updateSettings(req.user.id, req.body), { message: 'Saved' });
const weather = async (req, res) => sendSuccess(res, await service.getWeather(req.user.id));
const places = async (req, res) => sendSuccess(res, (await sources.searchPlaces(req.query.q)).data);
const rates = async (req, res) => sendSuccess(res, await service.getRates(req.user.id));
const currencies = async (req, res) => sendSuccess(res, (await sources.currencies()).data);
const funds = async (req, res) => sendSuccess(res, await service.getFunds(req.user.id));
const fundSearch = async (req, res) => sendSuccess(res, (await sources.searchFunds(req.query.q)).data);
const coins = async (req, res) => sendSuccess(res, await service.getCoins(req.user.id));
const coinSearch = async (req, res) => sendSuccess(res, (await sources.searchCoins(req.query.q, service.getPrefs(req.user.id).keys.coingecko)).data);
const news = async (req, res) => sendSuccess(res, await service.getNews(req.user.id));
const stocks = async (req, res) => sendSuccess(res, await service.getStocks(req.user.id));
const stockSearch = async (req, res) => sendSuccess(res, await service.searchStocks(req.user.id, req.query.q));
const titles = async (req, res) => sendSuccess(res, await service.getTitles(req.user.id, req.params.list, req.query.page));
const titleSearch = async (req, res) => sendSuccess(res, await service.searchTitles(req.user.id, req.query.q));
const cricket = async (req, res) => sendSuccess(res, await service.getCricket(req.user.id));
const watchlist = async (req, res) => sendSuccess(res, await service.getWatchlist(req.user.id));
const setWatch = async (req, res) => sendSuccess(res, await service.setWatch(req.user.id, req.body));
const inflation = async (req, res) => sendSuccess(res, await service.getInflation(req.user.id));

module.exports = { titleSearch, stocks, stockSearch, titles, cricket, watchlist, setWatch, settings, updateSettings, weather, places, rates, currencies, funds, fundSearch, coins, coinSearch, news, inflation };
