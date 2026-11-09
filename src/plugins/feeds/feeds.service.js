// Live data for the Live page and the goal form. Per-person preferences (city, watchlists, fund
// holdings, optional API keys) live in users.feeds (JSON, in the encrypted database); keys are
// write-only through the API. Public data is cached for everyone in feed_cache (see cache.js).
const { getDb } = require('../../config/db');
const AppError = require('../../core/AppError');
const { newId, nowIso, updateRow } = require('../../core/sql');
const sources = require('./sources');

const SOURCES = ['weather', 'rates', 'inflation', 'funds', 'stocks', 'crypto', 'news', 'movies', 'cricket'];

const DEFAULTS = Object.freeze({
  // Each source can be switched off in Profile → Data sources; a switched-off source is never called.
  enabled: Object.fromEntries(SOURCES.map((s) => [s, true])),
  location: { name: 'Bengaluru', region: 'Karnataka, India', latitude: 12.97, longitude: 77.59 }, // changeable in Profile
  currencies: ['USD', 'EUR', 'GBP'],
  funds: [], //      [{ code, name, units }]
  coins: ['bitcoin', 'ethereum'],
  stocks: { symbols: [], budget: 100 }, // symbols: [{ symbol, name, exchange, currency, units }]
  news: { section: 'business', query: 'India economy' },
  keys: { guardian: null, coingecko: null, tmdb: null, cricket: null, marketstack: null },
});

function getPrefs(userId) {
  const raw = getDb().prepare('SELECT feeds FROM users WHERE id = ?').pluck().get(userId);
  const saved = raw ? JSON.parse(raw) : {};
  return {
    ...DEFAULTS,
    ...saved,
    enabled: { ...DEFAULTS.enabled, ...saved.enabled },
    location: saved.location || DEFAULTS.location,
    stocks: { ...DEFAULTS.stocks, ...saved.stocks },
    news: { ...DEFAULTS.news, ...saved.news },
    keys: { ...DEFAULTS.keys, ...saved.keys },
  };
}

const hint = (key) => (key ? { saved: true, last4: key.slice(-4) } : { saved: false });
const toPublic = (p) => ({ ...p, keys: Object.fromEntries(Object.keys(DEFAULTS.keys).map((k) => [k, hint(p.keys[k])])) });

async function getSettings(userId) {
  return toPublic(getPrefs(userId));
}

async function updateSettings(userId, changes) {
  const p = getPrefs(userId);
  const next = {
    ...p,
    ...(changes.location !== undefined && { location: changes.location }),
    ...(changes.currencies && { currencies: [...new Set(changes.currencies)] }),
    ...(changes.funds && { funds: changes.funds }),
    ...(changes.coins && { coins: [...new Set(changes.coins)] }),
    enabled: { ...p.enabled, ...changes.enabled },
    stocks: { ...p.stocks, ...changes.stocks },
    news: { ...p.news, ...changes.news },
    keys: { ...p.keys },
  };
  // A key is replaced when given, removed with null, kept when left out.
  for (const [name, key] of Object.entries(changes.keys || {})) if (key !== undefined) next.keys[name] = key;
  updateRow(getDb(), 'users', userId, { feeds: JSON.stringify(next), updated_at: nowIso() });
  return toPublic(next);
}

// Every card gets the same envelope: data + when it was fetched + whether it's a stale copy.
const off = (source) => ({ disabled: true, source });

const card = (source, url, result, extra = {}) => ({ source, sourceUrl: url, data: result.data, fetchedAt: result.fetchedAt, stale: result.stale, ...extra });

async function getWeather(userId) {
  const { location, enabled } = getPrefs(userId);
  if (!enabled.weather) return off('Open-Meteo');
  return card('Open-Meteo', 'https://open-meteo.com/', await sources.weather(location), { location });
}

async function getRates(userId) {
  const { currencies, enabled } = getPrefs(userId);
  if (!enabled.rates) return off('Frankfurter');
  const [rates, names] = await Promise.all([sources.exchangeRates(currencies), sources.currencies().catch(() => ({ data: {} }))]);
  return card('European Central Bank via Frankfurter', 'https://frankfurter.dev/', rates, { names: names.data });
}

/** Each holding's latest NAV and value. One fund failing doesn't hide the others. */
async function getFunds(userId) {
  const { funds, enabled } = getPrefs(userId);
  if (!enabled.funds) return off('mfapi.in');
  const items = await Promise.all(
    funds.map(async (h) => {
      try {
        const r = await sources.fund(h.code);
        if (!r.data) return { ...h, error: 'No NAV published for this scheme' };
        return { ...h, ...r.data, units: h.units, value: h.units ? Math.round(h.units * r.data.nav * 100) / 100 : null, stale: r.stale, fetchedAt: r.fetchedAt };
      } catch (err) {
        return { ...h, error: err.message };
      }
    }),
  );
  const valued = items.filter((i) => i.value != null);
  return {
    source: 'AMFI data via mfapi.in',
    sourceUrl: 'https://www.mfapi.in/',
    data: { items, total: valued.length ? Math.round(valued.reduce((s, i) => s + i.value, 0) * 100) / 100 : null },
    stale: items.some((i) => i.stale),
    fetchedAt: items.map((i) => i.fetchedAt).filter(Boolean).sort()[0] || null,
  };
}

async function getCoins(userId) {
  const { coins, keys, enabled } = getPrefs(userId);
  if (!enabled.crypto) return off('CoinGecko');
  return card('CoinGecko', 'https://www.coingecko.com/', await sources.coins(coins, keys.coingecko));
}

async function getNews(userId) {
  const { news, keys, enabled } = getPrefs(userId);
  if (!enabled.news) return off('The Guardian');
  if (!keys.guardian) return { needsSetup: 'key', source: 'The Guardian', sourceUrl: 'https://open-platform.theguardian.com/access/' };
  return card('The Guardian', 'https://www.theguardian.com/', await sources.news({ key: keys.guardian, ...news }), { news });
}

// --- Stocks (Marketstack) --------------------------------------------------------------------

// Rupee prices on Indian exchanges; otherwise what the search said, else USD.
const currencyFor = (s) => s.currency || (/\.(XNSE|XBOM|NSE|BSE)$/i.test(s.symbol) ? 'INR' : 'USD');

async function getStocks(userId) {
  const { stocks, keys, enabled } = getPrefs(userId);
  if (!enabled.stocks) return off('Marketstack');
  if (!keys.marketstack) return { needsSetup: 'key', source: 'Marketstack', sourceUrl: 'https://marketstack.com/' };
  const result = await sources.stocks(stocks.symbols.map((s) => s.symbol), keys.marketstack, stocks.budget);
  const quotes = new Map((result.data.quotes || []).map((q) => [q.symbol, q]));
  const items = stocks.symbols.map((s) => {
    const q = quotes.get(s.symbol) || {};
    return { ...s, ...q, currency: currencyFor(s), value: s.units && q.close ? Math.round(s.units * q.close * 100) / 100 : null };
  });
  return card('Marketstack', 'https://marketstack.com/', { ...result, data: { items, usage: result.data.usage, budget: stocks.budget } });
}

async function searchStocks(userId, term) {
  const { keys, enabled, stocks } = getPrefs(userId);
  if (!enabled.stocks || !keys.marketstack) return [];
  return (await sources.searchStocks(term, keys.marketstack, stocks.budget)).data;
}

// --- Entertainment ---------------------------------------------------------------------------

/** Popular movies, shows or anime from TMDB, marked with what's already on the person's list. */
async function getTitles(userId, list, page = 1) {
  const { keys, enabled } = getPrefs(userId);
  if (!enabled.movies) return off('TMDB');
  if (!keys.tmdb) return { needsSetup: 'key', source: 'TMDB', sourceUrl: 'https://www.themoviedb.org/settings/api' };
  const result = await sources.tmdbPopular(list, keys.tmdb, page);
  const saved = new Map(watchlistRows(userId).map((w) => [`${w.media_type}:${w.tmdb_id}`, w]));
  const data = result.data.map((t) => {
    const w = saved.get(`${t.mediaType}:${t.tmdbId}`);
    return { ...t, starred: Boolean(w?.starred), list: w?.list ?? null };
  });
  return card('TMDB', 'https://www.themoviedb.org/', { ...result, data }, { page });
}

/** Search results, marked with what's already on the person's list. */
async function searchTitles(userId, term) {
  const { keys, enabled } = getPrefs(userId);
  if (!enabled.movies) return off('TMDB');
  if (!keys.tmdb) return { needsSetup: 'key', source: 'TMDB', sourceUrl: 'https://www.themoviedb.org/settings/api' };
  const result = await sources.tmdbSearch(term, keys.tmdb);
  const saved = new Map(watchlistRows(userId).map((w) => [`${w.media_type}:${w.tmdb_id}`, w]));
  const data = result.data.map((t) => {
    const w = saved.get(`${t.mediaType}:${t.tmdbId}`);
    return { ...t, starred: Boolean(w?.starred), list: w?.list ?? null };
  });
  return card('TMDB', 'https://www.themoviedb.org/', { ...result, data }, { query: term });
}

async function getCricket(userId) {
  const { keys, enabled } = getPrefs(userId);
  if (!enabled.cricket) return off('CricketData.org');
  if (!keys.cricket) return { needsSetup: 'key', source: 'CricketData.org', sourceUrl: 'https://cricketdata.org/' };
  return card('CricketData.org', 'https://cricketdata.org/', await sources.cricketMatches(keys.cricket));
}

const watchlistRows = (userId) => getDb().prepare('SELECT * FROM watchlist WHERE user_id = ? ORDER BY updated_at DESC').all(userId);

const toWatchItem = (w) => ({
  tmdbId: w.tmdb_id,
  mediaType: w.media_type,
  anime: w.anime === 1,
  title: w.title,
  poster: w.poster,
  overview: w.overview,
  year: w.year,
  rating: w.rating,
  starred: w.starred === 1,
  list: w.list,
  addedAt: w.created_at,
});

async function getWatchlist(userId) {
  return { items: watchlistRows(userId).map(toWatchItem) };
}

/**
 * Stars a title and/or puts it on a list (or takes it off). A title that's neither starred nor on
 * a list is removed, so the watchlist only holds what the person chose.
 */
async function setWatch(userId, { tmdbId, mediaType, title, poster, overview, year, rating, anime, starred, list }) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM watchlist WHERE user_id = ? AND media_type = ? AND tmdb_id = ?').get(userId, mediaType, tmdbId);
  const nextStarred = starred ?? existing?.starred === 1;
  const nextList = list === undefined ? existing?.list ?? null : list;
  if (!nextStarred && !nextList) {
    if (existing) db.prepare('DELETE FROM watchlist WHERE id = ?').run(existing.id);
    return { item: null };
  }
  const now = nowIso();
  if (existing) {
    updateRow(db, 'watchlist', existing.id, { starred: nextStarred ? 1 : 0, list: nextList, updated_at: now });
  } else {
    if (!title) throw AppError.badRequest('A title is needed to save it', 'VALIDATION_ERROR');
    db.prepare(
      `INSERT INTO watchlist (id, user_id, media_type, tmdb_id, title, poster, overview, year, rating, anime, starred, list, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId(), userId, mediaType, tmdbId, title, poster ?? null, overview ?? null, year ?? null, rating ?? null, anime ? 1 : 0, nextStarred ? 1 : 0, nextList, now, now);
  }
  return { item: toWatchItem(db.prepare('SELECT * FROM watchlist WHERE user_id = ? AND media_type = ? AND tmdb_id = ?').get(userId, mediaType, tmdbId)) };
}

// Goal kind → the CPI line that best matches what's being bought (division, and group if any).
const KIND_CPI = {
  vehicle: { division: 'Transport', group: 'Purchase of vehicles' },
  home: { division: 'Housing, water, electricity, gas and other fuels' },
  travel: { division: 'Restaurants and accommodation services', group: 'Accommodation services' },
  education: { division: 'Education services', group: 'Higher education' },
  gadget: { division: 'Information and communication', group: 'Information and communication equipment' },
};

/** Official CPI (MoSPI) and India's annual inflation history (World Bank); either may be missing. */
async function getInflation(userId) {
  if (userId && !getPrefs(userId).enabled.inflation) return { disabled: true, cpi: null, history: null };
  const [cpi, history] = await Promise.allSettled([sources.cpi(), sources.worldBankInflation()]);
  const c = cpi.status === 'fulfilled' ? cpi.value : null;
  const forKinds = {};
  if (c?.data) {
    for (const [kind, map] of Object.entries(KIND_CPI)) {
      const options = [];
      const group = map.group && c.data.groups.find((g) => g.division === map.division && g.name === map.group);
      const division = c.data.divisions.find((d) => d.name === map.division);
      if (group) options.push({ label: group.name, inflation: group.inflation });
      if (division) options.push({ label: division.name, inflation: division.inflation });
      forKinds[kind] = options;
    }
  }
  return {
    cpi: c ? { source: 'MoSPI (CPI, base 2024)', sourceUrl: 'https://esankhyiki.mospi.gov.in/', data: c.data, fetchedAt: c.fetchedAt, stale: c.stale, forKinds } : null,
    cpiError: cpi.status === 'rejected' ? cpi.reason.message : undefined,
    history: history.status === 'fulfilled' ? { source: 'World Bank', sourceUrl: 'https://data.worldbank.org/indicator/FP.CPI.TOTL.ZG?locations=IN', data: history.value.data, fetchedAt: history.value.fetchedAt, stale: history.value.stale } : null,
  };
}

module.exports = { searchTitles, getStocks, searchStocks, SOURCES, DEFAULTS, getPrefs, getSettings, updateSettings, getWeather, getRates, getFunds, getCoins, getNews, getInflation, getTitles, getCricket, getWatchlist, setWatch, KIND_CPI };
