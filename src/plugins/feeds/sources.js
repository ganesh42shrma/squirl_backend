// One function per public data source. Each returns a small, normalised shape (never the raw
// response) so the frontend and the cache don't depend on a provider's format.
//
//  Open-Meteo     weather + air quality, place search        no key   open-meteo.com
//  Frankfurter    ECB reference exchange rates                no key   frankfurter.dev
//  mfapi.in       Indian mutual fund NAVs (AMFI data)          no key   mfapi.in
//  CoinGecko      crypto prices in INR                         optional demo key
//  The Guardian   news                                         free key (the person's own)
//  MoSPI          official India CPI inflation                 no key   api.mospi.gov.in
//  World Bank     annual India inflation history               no key   api.worldbank.org
//  TMDB           popular movies, shows and anime              free key (the person's own)
//  CricketData    live and recent cricket matches              free key (100 calls a day)
//  Marketstack    end-of-day stock prices                      the person's key (free: 100 requests a month)
const { createHash } = require('crypto');
const http = require('./http');
const { cached } = require('./cache');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const q = encodeURIComponent;
const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;

// --- Weather (Open-Meteo) --------------------------------------------------------------------

async function searchPlaces(name) {
  return cached(`places:${name.toLowerCase()}`, 7 * DAY, async () => {
    const body = await http.getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${q(name)}&count=6&language=en&format=json`, { source: 'Open-Meteo' });
    return (body.results || []).map((r) => ({
      name: r.name,
      region: [r.admin1, r.country].filter(Boolean).join(', '),
      latitude: round2(r.latitude),
      longitude: round2(r.longitude),
      timezone: r.timezone,
    }));
  });
}

async function weather({ latitude, longitude }) {
  const lat = round2(latitude);
  const lon = round2(longitude);
  return cached(`weather:${lat},${lon}`, 30 * MIN, async () => {
    const [forecast, air] = await Promise.all([
      http.getJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=5&timezone=auto`,
        { source: 'Open-Meteo' },
      ),
      // Air quality is a nice extra: its failure must not hide the forecast.
      http.getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,pm2_5,pm10&timezone=auto`, { source: 'Open-Meteo' }).catch(() => null),
    ]);
    const c = forecast.current || {};
    const d = forecast.daily || {};
    return {
      current: {
        time: c.time,
        temperature: c.temperature_2m,
        feelsLike: c.apparent_temperature,
        humidity: c.relative_humidity_2m,
        wind: c.wind_speed_10m,
        code: c.weather_code,
        isDay: c.is_day === 1,
      },
      daily: (d.time || []).map((date, i) => ({
        date,
        code: d.weather_code?.[i],
        max: d.temperature_2m_max?.[i],
        min: d.temperature_2m_min?.[i],
        rainChance: d.precipitation_probability_max?.[i] ?? null,
      })),
      air: air?.current ? { usAqi: air.current.us_aqi, pm25: air.current.pm2_5, pm10: air.current.pm10 } : null,
      timezone: forecast.timezone,
    };
  });
}

// --- Exchange rates (Frankfurter / ECB) ------------------------------------------------------

async function currencies() {
  return cached('fx:currencies', 7 * DAY, () => http.getJson('https://api.frankfurter.dev/v1/currencies', { source: 'Frankfurter' }));
}

/** Rupees per one unit of each currency, today and 30 days ago. */
async function exchangeRates(symbols) {
  const list = [...new Set(symbols)].filter((s) => s !== 'INR').sort();
  if (!list.length) return { data: { date: null, rates: [] }, fetchedAt: null, stale: false };
  return cached(`fx:${list.join(',')}`, 6 * HOUR, async () => {
    const start = new Date(Date.now() - 32 * DAY).toISOString().slice(0, 10);
    const series = await http.getJson(`https://api.frankfurter.dev/v1/${start}..?base=INR&symbols=${list.join(',')}`, { source: 'Frankfurter' });
    const dates = Object.keys(series.rates || {}).sort();
    const perInr = (date, code) => series.rates[date]?.[code];
    const latest = dates.at(-1);
    return {
      date: latest || null,
      rates: list
        .filter((code) => perInr(latest, code))
        .map((code) => {
          const now = 1 / perInr(latest, code);
          const then = perInr(dates[0], code) ? 1 / perInr(dates[0], code) : null;
          return {
            code,
            inr: Math.round(now * 10000) / 10000, // ₹ per 1 unit
            change30d: then ? round2(((now - then) / then) * 100) : null,
            trend: dates.map((date) => (perInr(date, code) ? Math.round((1 / perInr(date, code)) * 100) / 100 : null)),
          };
        }),
    };
  });
}

// --- Mutual funds (mfapi.in) -----------------------------------------------------------------

async function searchFunds(term) {
  return cached(`mf:search:${term.toLowerCase()}`, DAY, async () => {
    const body = await http.getJson(`https://api.mfapi.in/mf/search?q=${q(term)}`, { source: 'mfapi.in' });
    return (Array.isArray(body) ? body : []).slice(0, 25).map((f) => ({ code: String(f.schemeCode), name: f.schemeName }));
  });
}

const fromDdMmYyyy = (s) => {
  const [dd, mm, yyyy] = String(s).split('-');
  return `${yyyy}-${mm}-${dd}`;
};

/** Latest NAV plus the NAV about a month and a year earlier (for returns). */
async function fund(code) {
  return cached(`mf:${code}`, 6 * HOUR, async () => {
    const body = await http.getJson(`https://api.mfapi.in/mf/${q(code)}`, { source: 'mfapi.in' });
    const rows = (body.data || []).map((r) => ({ date: fromDdMmYyyy(r.date), nav: Number(r.nav) })).filter((r) => Number.isFinite(r.nav) && r.nav > 0);
    if (!rows.length) return null;
    const latest = rows[0]; // newest first
    const onOrBefore = (days) => {
      const target = new Date(Date.parse(latest.date) - days * DAY).toISOString().slice(0, 10);
      return rows.find((r) => r.date <= target) || null;
    };
    const ret = (old) => (old ? round2(((latest.nav - old.nav) / old.nav) * 100) : null);
    return {
      code: String(code),
      name: body.meta?.scheme_name,
      house: body.meta?.fund_house,
      category: body.meta?.scheme_category,
      nav: latest.nav,
      date: latest.date,
      return1m: ret(onOrBefore(30)),
      return1y: ret(onOrBefore(365)),
    };
  });
}

// --- Crypto (CoinGecko) ----------------------------------------------------------------------

const geckoHeaders = (key) => (key ? { 'x-cg-demo-api-key': key } : {});

async function searchCoins(term, key) {
  return cached(`crypto:search:${term.toLowerCase()}`, DAY, async () => {
    const body = await http.getJson(`https://api.coingecko.com/api/v3/search?query=${q(term)}`, { source: 'CoinGecko', headers: geckoHeaders(key) });
    return (body.coins || []).slice(0, 10).map((c) => ({ id: c.id, name: c.name, symbol: String(c.symbol || '').toUpperCase(), rank: c.market_cap_rank ?? null }));
  });
}

async function coins(ids, key) {
  const list = [...new Set(ids)].sort();
  if (!list.length) return { data: [], fetchedAt: null, stale: false };
  return cached(`crypto:${list.join(',')}`, 5 * MIN, async () => {
    const body = await http.getJson(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=inr&ids=${list.map(q).join(',')}`, { source: 'CoinGecko', headers: geckoHeaders(key) });
    return (Array.isArray(body) ? body : []).map((c) => ({
      id: c.id,
      name: c.name,
      symbol: String(c.symbol || '').toUpperCase(),
      image: c.image,
      price: c.current_price,
      change24h: c.price_change_percentage_24h == null ? null : round2(c.price_change_percentage_24h),
    }));
  });
}

// --- News (The Guardian) ---------------------------------------------------------------------

const SECTIONS = ['business', 'money', 'world', 'technology', 'all'];
const stripTags = (html) => String(html || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

async function news({ key, query, section }) {
  const params = new URLSearchParams({ 'order-by': 'newest', 'page-size': '12', 'show-fields': 'trailText,thumbnail', 'api-key': key });
  if (query) params.set('q', query);
  if (section && section !== 'all') params.set('section', section);
  return cached(`news:${hash(key)}:${section || 'all'}:${(query || '').toLowerCase()}`, 30 * MIN, async () => {
    const body = await http.getJson(`https://content.guardianapis.com/search?${params}`, { source: 'The Guardian' });
    return (body.response?.results || []).map((a) => ({
      id: a.id,
      title: a.webTitle,
      url: a.webUrl,
      section: a.sectionName,
      published: a.webPublicationDate,
      summary: stripTags(a.fields?.trailText).slice(0, 240),
      thumbnail: a.fields?.thumbnail || null,
    }));
  });
}

// --- Inflation (MoSPI CPI, World Bank) -------------------------------------------------------

/**
 * The latest month of India's CPI (base 2024, current series), All India, Combined sector:
 * the headline plus every division and group, each with its year-on-year inflation.
 * The API returns at most 100 rows a page, newest month first; read pages until the month changes.
 */
async function cpi() {
  return cached('cpi:mospi', 12 * HOUR, async () => {
    const rows = [];
    let month = null;
    for (let page = 1; page <= 6; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const body = await http.mospiGet(`/api/cpi/getCPIData?base_year=2024&series_code=Current&Format=JSON&limit=100&page=${page}`);
      const data = body.data || [];
      if (!data.length) break;
      month = month || `${data[0].year}-${data[0].month}`;
      const inMonth = data.filter((r) => `${r.year}-${r.month}` === month);
      rows.push(...inMonth);
      if (inMonth.length < data.length) break; // reached the previous month
    }
    const combined = rows.filter((r) => r.state === 'All India' && r.sector === 'Combined' && !r.class && !r.item && r.inflation != null);
    const headline = combined.find((r) => r.division === 'CPI (General)' && !r.group);
    if (!headline) throw http.unavailable('MoSPI');
    const toNumber = (v) => Math.round(Number(v) * 100) / 100;
    return {
      month: headline.month,
      year: Number(headline.year),
      general: toNumber(headline.inflation),
      divisions: combined.filter((r) => !r.group && r.division !== 'CPI (General)').map((r) => ({ name: r.division, inflation: toNumber(r.inflation) })),
      groups: combined.filter((r) => r.group).map((r) => ({ division: r.division, name: r.group, inflation: toNumber(r.inflation) })),
    };
  });
}

/** India's annual consumer price inflation for the last ten years with data. */
async function worldBankInflation() {
  return cached('cpi:worldbank', 7 * DAY, async () => {
    const body = await http.getJson('https://api.worldbank.org/v2/country/IND/indicator/FP.CPI.TOTL.ZG?format=json&per_page=10&mrnev=10', { source: 'World Bank' });
    const rows = Array.isArray(body) ? body[1] || [] : []; // the reply is [metadata, rows]
    return rows
      .filter((r) => r.value != null)
      .map((r) => ({ year: Number(r.date), inflation: round2(r.value) }))
      .sort((a, b) => a.year - b.year);
  });
}

// --- Movies, shows, anime (TMDB) -------------------------------------------------------------

const TMDB = 'https://api.themoviedb.org/3';
const POSTER = 'https://image.tmdb.org/t/p/w342';

// A v4 "read access token" (a JWT, starts with eyJ) goes in a header; a v3 key in the query.
function tmdbRequest(key, path, params = {}) {
  const query = new URLSearchParams({ language: 'en-US', ...params });
  const bearer = key.startsWith('eyJ');
  if (!bearer) query.set('api_key', key);
  return http.getJson(`${TMDB}${path}?${query}`, { source: 'TMDB', headers: bearer ? { Authorization: `Bearer ${key}` } : {} });
}

async function tmdbGenres(key) {
  return cached('tmdb:genres', 7 * DAY, async () => {
    const [movie, tv] = await Promise.all([tmdbRequest(key, '/genre/movie/list'), tmdbRequest(key, '/genre/tv/list')]);
    return Object.fromEntries([...(movie.genres || []), ...(tv.genres || [])].map((g) => [g.id, g.name]));
  });
}

// What each tab asks for. Anime: TMDB has no anime genre, so Animation (16) made in Japanese.
const TMDB_LISTS = {
  movies: { path: '/movie/popular', params: { region: 'IN' }, mediaType: 'movie' },
  shows: { path: '/tv/popular', params: {}, mediaType: 'tv' },
  anime: { path: '/discover/tv', params: { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc' }, mediaType: 'tv', anime: true },
};

const toTitle = (r, mediaType, genres, anime = false) => ({
  tmdbId: r.id,
  mediaType,
  anime,
  title: r.title || r.name,
  overview: String(r.overview || '').slice(0, 600),
  poster: r.poster_path ? `${POSTER}${r.poster_path}` : null,
  year: Number(String(r.release_date || r.first_air_date || '').slice(0, 4)) || null,
  rating: r.vote_count ? Math.round(r.vote_average * 10) / 10 : null,
  genres: (r.genre_ids || []).map((id) => genres[id]).filter(Boolean).slice(0, 2),
});

/** Search movies and shows by name (anime included). Kept a day per search term. */
async function tmdbSearch(term, key) {
  return cached(`tmdb:search:${term.toLowerCase()}:${hash(key)}`, DAY, async () => {
    const [body, genres] = await Promise.all([
      tmdbRequest(key, '/search/multi', { query: term, include_adult: 'false', page: '1' }),
      tmdbGenres(key).then((g) => g.data).catch(() => ({})),
    ]);
    return (body.results || [])
      .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
      .map((r) => toTitle(r, r.media_type, genres, (r.genre_ids || []).includes(16) && r.original_language === 'ja'))
      .slice(0, 18);
  });
}

async function tmdbPopular(list, key, page = 1) {
  const spec = TMDB_LISTS[list];
  return cached(`tmdb:${list}:${page}:${hash(key)}`, 6 * HOUR, async () => {
    const [body, genres] = await Promise.all([tmdbRequest(key, spec.path, { ...spec.params, page: String(page) }), tmdbGenres(key).then((g) => g.data).catch(() => ({}))]);
    return (body.results || []).map((r) => toTitle(r, spec.mediaType, genres, Boolean(spec.anime)));
  });
}

// --- Cricket (CricketData.org) ---------------------------------------------------------------

/**
 * Current and recently finished matches. The free plan allows 100 calls a day, so the answer is
 * kept for 15 minutes (at most ~96 calls a day even with the page always open).
 * CricketData answers HTTP 200 with { status: 'failure', reason } on errors.
 */
async function cricketMatches(key) {
  return cached(`cricket:${hash(key)}`, 15 * MIN, async () => {
    const body = await http.getJson(`https://api.cricapi.com/v1/currentMatches?apikey=${q(key)}&offset=0`, { source: 'CricketData.org' });
    if (body.status !== 'success') {
      const reason = String(body.reason || '');
      if (/key/i.test(reason)) throw http.keyError('CricketData.org');
      if (/limit|hits/i.test(reason)) throw http.rateError('CricketData.org');
      throw http.unavailable('CricketData.org');
    }
    const matches = (body.data || []).map((m) => ({
      id: m.id,
      name: m.name,
      type: String(m.matchType || '').toUpperCase(),
      status: m.status,
      venue: m.venue,
      date: m.dateTimeGMT || m.date || null,
      started: Boolean(m.matchStarted),
      ended: Boolean(m.matchEnded),
      teams: (m.teamInfo?.length ? m.teamInfo : (m.teams || []).map((name) => ({ name }))).map((t) => ({ name: t.name, short: t.shortname || null, img: t.img || null })),
      score: (m.score || []).map((s) => ({ inning: s.inning, runs: s.r, wickets: s.w, overs: s.o })),
    }));
    // Live first, then upcoming, then finished; newest first within each.
    const order = (m) => (m.started && !m.ended ? 0 : !m.started ? 1 : 2);
    matches.sort((a, b) => order(a) - order(b) || String(b.date).localeCompare(String(a.date)));
    return { matches: matches.slice(0, 15), hits: body.info ? { used: body.info.hitsToday ?? body.info.hitsUsed ?? null, limit: body.info.hitsLimit ?? null } : null };
  });
}

// --- Stocks (Marketstack) --------------------------------------------------------------------
//
// The free plan is 100 requests a month and every ticker in a call counts as one, so Squirl:
//  - fetches end-of-day prices at most once a day (they only change once a day), all symbols
//    in one call that also returns 30 days of history (latest close, day change and trend);
//  - keeps ticker searches for 30 days;
//  - counts every request it makes this month (stock_usage below) and stops at the person's budget.

const MARKETSTACK = 'https://api.marketstack.com/v2';
const monthKey = () => new Date().toISOString().slice(0, 7);

function marketstackUsage() {
  const { getDb } = require('../../config/db');
  const row = getDb().prepare('SELECT body FROM feed_cache WHERE key = ?').get(`marketstack:usage:${monthKey()}`);
  return row ? JSON.parse(row.body).count : 0;
}

function addMarketstackUsage(n) {
  const { getDb } = require('../../config/db');
  const key = `marketstack:usage:${monthKey()}`;
  getDb()
    .prepare(
      `INSERT INTO feed_cache (key, body, fetched_at, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET body = json_set(body, '$.count', json_extract(body, '$.count') + ?), fetched_at = excluded.fetched_at`,
    )
    .run(key, JSON.stringify({ count: n }), new Date().toISOString(), Date.now() + 40 * DAY, n);
}

/** Marketstack errors arrive as { error: { code, message } }, mostly with 4xx statuses. */
async function marketstackGet(key, path, params, cost) {
  const query = new URLSearchParams({ access_key: key, ...params });
  let response;
  try {
    response = await fetch(`${MARKETSTACK}${path}?${query}`, { headers: { 'User-Agent': http.USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw http.unavailable('Marketstack');
  }
  const body = await response.json().catch(() => null);
  const code = body?.error?.code;
  if (!code && response.ok && body) {
    addMarketstackUsage(cost); // failed requests don't count toward Marketstack's quota
    return body;
  }
  if (/access_key/.test(code || '')) throw http.keyError('Marketstack');
  if (code === 'usage_limit_reached' || code === 'rate_limit_reached' || response.status === 429) throw http.rateError('Marketstack');
  const err = http.unavailable('Marketstack');
  err.marketstackCode = code || `http_${response.status}`;
  if (code === 'function_access_restricted') err.message = 'Your Marketstack plan doesn’t include this data.';
  throw err;
}

const budgetError = () => {
  const err = http.rateError('Marketstack');
  err.message = 'This month’s Marketstack budget is used up (set it in Profile → Data sources). Showing the last prices.';
  err.code = 'FEED_BUDGET_REACHED';
  return err;
};

/** Ticker search (one request; kept 30 days). Tries v2's tickerslist, then the older tickers path. */
async function searchStocks(term, key, budget) {
  return cached(`stocks:search:${term.toLowerCase()}`, 30 * DAY, async () => {
    if (marketstackUsage() + 1 > budget) throw budgetError();
    let body;
    try {
      body = await marketstackGet(key, '/tickerslist', { search: term, limit: '10' }, 1);
    } catch (err) {
      if (!/invalid_api_function|http_404/.test(err.marketstackCode || '')) throw err;
      body = await marketstackGet(key, '/tickers', { search: term, limit: '10' }, 1);
    }
    return (body.data || []).slice(0, 10).map((t) => ({
      symbol: t.ticker || t.symbol,
      name: t.name,
      exchange: t.stock_exchange?.acronym || t.stock_exchange?.mic || t.exchange || null,
      country: t.stock_exchange?.country_code || t.stock_exchange?.country || null,
      currency: t.currency || t.stock_exchange?.currency || null,
    })).filter((t) => t.symbol);
  });
}

/**
 * Latest end-of-day price, the change from the previous close and a 30-day trend, for up to five
 * symbols, in one call. Kept 24 hours; refused (stale copy instead) past the monthly budget.
 */
async function stocks(symbols, key, budget) {
  const list = [...new Set(symbols)].sort();
  if (!list.length) return { data: { quotes: [], usage: marketstackUsage() }, fetchedAt: null, stale: false };
  const result = await cached(`stocks:eod:${list.join(',')}:${hash(key)}`, DAY, async () => {
    if (marketstackUsage() + list.length > budget) throw budgetError();
    const from = new Date(Date.now() - 45 * DAY).toISOString().slice(0, 10);
    const body = await marketstackGet(key, '/eod', { symbols: list.join(','), date_from: from, sort: 'DESC', limit: '1000' }, list.length);
    const bySymbol = new Map();
    for (const row of body.data || []) {
      if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
      bySymbol.get(row.symbol).push(row);
    }
    return {
      quotes: list.map((symbol) => {
        const rows = (bySymbol.get(symbol) || []).sort((a, b) => String(b.date).localeCompare(String(a.date))); // newest first
        const last = rows[0];
        if (!last) return { symbol, error: 'No prices returned for this symbol' };
        const prev = rows[1];
        const close = last.close ?? last.adj_close;
        return {
          symbol,
          date: String(last.date).slice(0, 10),
          close,
          open: last.open,
          high: last.high,
          low: last.low,
          volume: last.volume,
          change: prev?.close ? round2(((close - prev.close) / prev.close) * 100) : null,
          change30d: rows.length > 1 ? round2(((close - rows.at(-1).close) / rows.at(-1).close) * 100) : null,
          trend: rows.slice(0, 31).reverse().map((r) => r.close),
          exchange: last.exchange || null,
        };
      }),
    };
  });
  return { ...result, data: { ...result.data, usage: marketstackUsage() } };
}

module.exports = { SECTIONS, TMDB_LISTS, tmdbSearch, searchStocks, stocks, marketstackUsage, tmdbPopular, cricketMatches, searchPlaces, weather, currencies, exchangeRates, searchFunds, fund, searchCoins, coins, news, cpi, worldBankInflation };
