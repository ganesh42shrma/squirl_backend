// Live data feeds. Synthetic responses and an in-memory database only: no network calls.
const assert = require('node:assert/strict');
const Database = require('better-sqlite3-multiple-ciphers');

const db = new Database(':memory:');
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports }; };
stub('../src/config/db', { getDb: () => db });
stub('../src/core/logger', { info() {}, warn() {}, error() {}, debug() {} });

const migrations = require('../src/config/migrations');
db.pragma('foreign_keys = ON');
for (const m of migrations) typeof m === 'function' ? m(db) : db.exec(m);

// Fake network: answers by URL; `down` makes every source fail.
let down = false;
const calls = [];
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
global.fetch = async (url) => {
  calls.push(url);
  if (down) throw new Error('offline');
  if (url.includes('geocoding-api')) return json({ results: [{ name: 'Bengaluru', admin1: 'Karnataka', country: 'India', latitude: 12.97194, longitude: 77.59369, timezone: 'Asia/Kolkata' }] });
  if (url.includes('air-quality-api')) return json({ current: { us_aqi: 72, pm2_5: 21.5, pm10: 40 } });
  if (url.includes('api.open-meteo.com')) return json({ timezone: 'Asia/Kolkata', current: { time: '2026-11-10T09:00', temperature_2m: 24, apparent_temperature: 25, relative_humidity_2m: 70, wind_speed_10m: 8, weather_code: 2, is_day: 1 }, daily: { time: ['2026-11-10', '2026-11-11'], weather_code: [2, 61], temperature_2m_max: [29, 27], temperature_2m_min: [19, 19], precipitation_probability_max: [10, 70] } });
  if (url.includes('frankfurter.dev/v1/currencies')) return json({ USD: 'US Dollar', EUR: 'Euro' });
  if (url.includes('frankfurter.dev')) return json({ base: 'INR', rates: { '2026-10-09': { USD: 0.0105, EUR: 0.0095 }, '2026-11-09': { USD: 0.0104, EUR: 0.0096 } } });
  if (url.includes('mfapi.in/mf/search')) return json([{ schemeCode: 122639, schemeName: 'Synthetic Flexi Cap - Direct - Growth' }]);
  if (url.includes('mfapi.in/mf/999')) return json({ status: 'ERROR' }, 500);
  if (url.includes('mfapi.in/mf/')) return json({ meta: { scheme_name: 'Synthetic Flexi Cap - Direct - Growth', fund_house: 'Synthetic AMC', scheme_category: 'Equity' }, data: [{ date: '06-11-2026', nav: '110.0000' }, { date: '06-10-2026', nav: '100.0000' }, { date: '06-11-2025', nav: '88.0000' }] });
  if (url.includes('coingecko.com/api/v3/coins/markets')) return json([{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', image: 'x', current_price: 7000000, price_change_percentage_24h: -1.234 }]);
  if (url.includes('guardianapis.com')) return json({ response: { results: [{ id: 'a', webTitle: 'Synthetic headline', webUrl: 'https://example.com/a', sectionName: 'Business', webPublicationDate: '2026-11-09T10:00:00Z', fields: { trailText: '<p>Synthetic &amp; short</p>' } }] } });
  if (url.includes('themoviedb.org/3/genre/')) return json({ genres: [{ id: 16, name: 'Animation' }, { id: 28, name: 'Action' }] });
  if (url.includes('themoviedb.org/3/search/multi')) return json({ results: [
    { id: 11, media_type: 'movie', title: 'Synthetic Film', overview: 'x', release_date: '2020-01-01', vote_average: 6, vote_count: 10, genre_ids: [28, 18, 16] },
    { id: 12, media_type: 'tv', name: 'Synthetic Anime Show', original_language: 'ja', first_air_date: '2021-01-01', vote_average: 8, vote_count: 10, genre_ids: [16] },
    { id: 13, media_type: 'person', name: 'Somebody' },
  ] });
  if (url.includes('themoviedb.org/3/movie/popular')) return json({ results: [{ id: 101, title: 'Synthetic Movie', overview: 'A test.', poster_path: '/p.jpg', release_date: '2026-10-01', vote_average: 7.46, vote_count: 900, genre_ids: [28] }] });
  if (url.includes('themoviedb.org/3/tv/popular')) return json({ results: [{ id: 202, name: 'Synthetic Show', overview: '', poster_path: null, first_air_date: '2025-01-01', vote_average: 0, vote_count: 0, genre_ids: [] }] });
  if (url.includes('themoviedb.org/3/discover/tv')) return json({ results: [{ id: 303, name: 'Synthetic Anime', overview: 'Anime.', poster_path: '/a.jpg', first_air_date: '2024-04-01', vote_average: 8.8, vote_count: 50, genre_ids: [16] }] });
  if (url.includes('api.cricapi.com') && url.includes('apikey=bad')) return json({ status: 'failure', reason: 'Invalid API Key' });
  if (url.includes('api.cricapi.com') && url.includes('apikey=spent')) return json({ status: 'failure', reason: 'hits limit exceeded' });
  if (url.includes('api.cricapi.com')) return json({ status: 'success', info: { hitsToday: 12, hitsLimit: 100 }, data: [
    { id: 'm1', name: 'IND vs AUS, 1st Test', matchType: 'test', status: 'India won by 5 wickets', dateTimeGMT: '2026-11-01T04:00:00', matchStarted: true, matchEnded: true, teamInfo: [{ name: 'India', shortname: 'IND' }, { name: 'Australia', shortname: 'AUS' }], score: [{ r: 300, w: 10, o: 90.2, inning: 'Australia Inning 1' }] },
    { id: 'm2', name: 'IND vs AUS, 2nd Test', matchType: 'test', status: 'Day 2: India 210/3', dateTimeGMT: '2026-11-09T04:00:00', matchStarted: true, matchEnded: false, teams: ['India', 'Australia'], score: [] },
  ] });
  if (url.includes('api.marketstack.com') && url.includes('access_key=bad')) return json({ error: { code: 'invalid_access_key', message: 'bad key' } }, 401);
  if (url.includes('api.marketstack.com') && url.includes('access_key=spent')) return json({ error: { code: 'usage_limit_reached', message: 'limit' } }, 429);
  if (url.includes('api.marketstack.com/v2/tickerslist')) return json({ error: { code: 'invalid_api_function', message: 'not found' } }, 404);
  if (url.includes('api.marketstack.com/v2/tickers')) return json({ data: [{ symbol: 'RELIANCE.XNSE', name: 'Reliance Industries', stock_exchange: { acronym: 'NSE', mic: 'XNSE', country_code: 'IN' } }] });
  if (url.includes('api.marketstack.com/v2/eod')) return json({ pagination: { count: 4 }, data: [
    { symbol: 'RELIANCE.XNSE', date: '2026-11-07T00:00:00+0000', close: 1500, open: 1480, high: 1510, low: 1470, volume: 1000, exchange: 'XNSE' },
    { symbol: 'AAPL', date: '2026-11-07T00:00:00+0000', close: 230, exchange: 'XNAS' },
    { symbol: 'RELIANCE.XNSE', date: '2026-11-06T00:00:00+0000', close: 1450, exchange: 'XNSE' },
    { symbol: 'RELIANCE.XNSE', date: '2026-10-08T00:00:00+0000', close: 1200, exchange: 'XNSE' },
  ] });
  if (url.includes('api.worldbank.org')) return json([{ page: 1 }, [{ date: '2025', value: 2.3988 }, { date: '2024', value: 4.953 }, { date: '2023', value: null }]]);
  return json({}, 404);
};
const http = require('../src/plugins/feeds/http');
let mospiPages = [];
http.mospiGetImpl = async (path) => {
  calls.push(path);
  if (down) throw http.unavailable('MoSPI');
  const page = Number(new URL(`https://x${path}`).searchParams.get('page'));
  return { data: mospiPages[page - 1] || [] };
};

const { insertUser } = require('../src/plugins/users/user.model');
const feeds = require('../src/plugins/feeds/feeds.service');
const sources = require('../src/plugins/feeds/sources');
const schemas = require('../src/plugins/feeds/feeds.validation');

const row = (o) => ({ base_year: '2024', series: 'Current', year: '2026', month: 'September', state: 'All India', sector: 'Combined', group: null, class: null, item: null, ...o });

const run = async () => {
  const a = insertUser(db, { name: 'Synthetic A', email: 'a@example.invalid', passwordHash: 'unused' });
  const b = insertUser(db, { name: 'Synthetic B', email: 'b@example.invalid', passwordHash: 'unused' });

  // Settings: defaults, per person, keys write-only.
  const s0 = await feeds.getSettings(a);
  assert.deepEqual(s0.currencies, ['USD', 'EUR', 'GBP']);
  const s1 = await feeds.updateSettings(a, { keys: { guardian: 'guardian-synthetic-key-1234' }, coins: ['bitcoin', 'bitcoin'] });
  assert.deepEqual(s1.keys.guardian, { saved: true, last4: '1234' });
  assert.ok(!JSON.stringify(s1).includes('guardian-synthetic-key'), 'the key never comes back');
  assert.deepEqual(s1.coins, ['bitcoin'], 'duplicates dropped');
  assert.equal((await feeds.getSettings(b)).keys.guardian.saved, false);

  // Weather works straight away for Bengaluru, the default city; every source is on by default.
  assert.equal((await feeds.getSettings(a)).location.name, 'Bengaluru');
  assert.ok(Object.values((await feeds.getSettings(a)).enabled).every(Boolean));
  assert.equal((await feeds.getWeather(b)).data.current.temperature, 24);
  const [place] = (await sources.searchPlaces('Bengaluru')).data;
  assert.deepEqual([place.latitude, place.longitude, place.region], [12.97, 77.59, 'Karnataka, India']);
  await feeds.updateSettings(a, { location: place });
  const w = await feeds.getWeather(a);
  assert.equal(w.data.current.temperature, 24);
  assert.equal(w.data.daily[1].rainChance, 70);
  assert.equal(w.data.air.usAqi, 72);
  assert.equal(w.stale, false);

  // Cache: a second read doesn't call the network; when a source is down, the last copy is stale.
  const before = calls.length;
  await feeds.getWeather(a);
  assert.equal(calls.length, before, 'served from the cache');
  db.prepare('UPDATE feed_cache SET expires_at = 0').run();
  down = true;
  const staleWeather = await feeds.getWeather(a);
  assert.equal(staleWeather.stale, true);
  assert.equal(staleWeather.data.current.temperature, 24);
  await assert.rejects(sources.searchPlaces('Nowhere'), (e) => e.code === 'FEED_UNAVAILABLE', 'nothing cached → a clear error');
  down = false;

  // Exchange rates: rupees per unit, 30-day change, names.
  const fx = await feeds.getRates(a);
  const usd = fx.data.rates.find((r) => r.code === 'USD');
  assert.equal(Math.round(usd.inr * 100) / 100, 96.15);
  assert.ok(usd.change30d > 0, 'the rupee weakened against USD over the month');
  assert.equal(fx.names.USD, 'US Dollar');

  // Funds: value = units × NAV; returns from older NAVs; one bad scheme doesn't hide the rest.
  await feeds.updateSettings(a, { funds: [{ code: '122639', name: 'Synthetic Flexi Cap', units: 10.5 }, { code: '999', name: 'Broken', units: 1 }] });
  const f = await feeds.getFunds(a);
  const good = f.data.items.find((i) => i.code === '122639');
  assert.equal(good.value, 1155);
  assert.equal(good.return1m, 10);
  assert.equal(good.return1y, 25);
  assert.ok(f.data.items.find((i) => i.code === '999').error);
  assert.equal(f.data.total, 1155);

  // Crypto and news.
  assert.equal((await feeds.getCoins(a)).data[0].change24h, -1.23);
  assert.equal((await feeds.getNews(b)).needsSetup, 'key');
  const n = await feeds.getNews(a);
  assert.equal(n.data[0].summary, 'Synthetic & short', 'HTML stripped from summaries');

  // Inflation: MoSPI pages until the month changes; goal kinds get the matching CPI lines.
  mospiPages = [
    [row({ division: 'CPI (General)', inflation: '5.54' }), row({ sector: 'Rural', division: 'CPI (General)', inflation: '6.08' }), row({ division: 'Transport', inflation: '5.01' })],
    [row({ division: 'Transport', group: 'Purchase of vehicles', inflation: '-2.56' }), row({ division: 'Education services', inflation: '3.94' }), row({ month: 'August', division: 'CPI (General)', inflation: '5.10' })],
    [row({ month: 'August', division: 'Transport', inflation: '9.99' })],
  ];
  const inf = await feeds.getInflation();
  assert.equal(inf.cpi.data.general, 5.54);
  assert.equal(inf.cpi.data.month, 'September');
  assert.ok(!inf.cpi.data.divisions.some((d) => d.inflation === 9.99), 'stops at the previous month');
  assert.deepEqual(inf.cpi.forKinds.vehicle, [{ label: 'Purchase of vehicles', inflation: -2.56 }, { label: 'Transport', inflation: 5.01 }]);
  assert.deepEqual(inf.cpi.forKinds.education, [{ label: 'Education services', inflation: 3.94 }]);
  assert.deepEqual(inf.history.data.map((h) => h.year), [2024, 2025], 'World Bank rows without a value are dropped');
  // One source down doesn't hide the other.
  db.prepare("DELETE FROM feed_cache WHERE key = 'cpi:mospi'").run();
  mospiPages = [[]];
  const partial = await feeds.getInflation();
  assert.equal(partial.cpi, null);
  assert.ok(partial.cpiError);
  assert.ok(partial.history.data.length);

  // Validation.
  assert.equal(schemas.update.safeParse({ body: { currencies: ['usd'] } }).success, false);
  assert.equal(schemas.update.safeParse({ body: { funds: [{ code: 'abc', name: 'x' }] } }).success, false);
  assert.equal(schemas.update.safeParse({ body: { location: { name: 'X', latitude: 200, longitude: 0 } } }).success, false);
  assert.equal(schemas.update.safeParse({ body: { news: { section: 'sport' } } }).success, false);

  // A source switched off in Profile is never called, and its card says so.
  await feeds.updateSettings(a, { enabled: { crypto: false, inflation: false } });
  const callsBefore = calls.length;
  assert.equal((await feeds.getCoins(a)).disabled, true);
  assert.equal((await feeds.getInflation(a)).disabled, true);
  assert.equal(calls.length, callsBefore, 'no network call for a switched-off source');
  assert.equal((await feeds.getSettings(a)).enabled.weather, true, 'other sources unaffected');
  assert.equal((await feeds.getSettings(b)).enabled.crypto, true, 'per person');
  assert.equal(schemas.update.safeParse({ body: { enabled: { crypto: 'no' } } }).success, false);

  // --- Entertainment: TMDB (key in Profile), watchlist, cricket.
  await feeds.updateSettings(b, { enabled: { movies: true, cricket: true } });
  assert.equal((await feeds.getTitles(b, 'movies')).needsSetup, 'key');
  await feeds.updateSettings(b, { keys: { tmdb: 'synthetic-v3-key-0123456789abcdef' } });
  const movies = await feeds.getTitles(b, 'movies');
  assert.deepEqual(movies.data[0], { tmdbId: 101, mediaType: 'movie', anime: false, title: 'Synthetic Movie', overview: 'A test.', poster: 'https://image.tmdb.org/t/p/w342/p.jpg', year: 2026, rating: 7.5, genres: ['Action'], starred: false, list: null });
  assert.ok(calls.some((u) => u.includes('/movie/popular') && u.includes('region=IN') && u.includes('api_key=')), 'v3 key in the query, India region');
  assert.equal((await feeds.getTitles(b, 'shows')).data[0].rating, null, 'no votes, no rating');
  const anime = await feeds.getTitles(b, 'anime');
  assert.equal(anime.data[0].anime, true);
  assert.ok(calls.some((u) => u.includes('/discover/tv') && u.includes('with_genres=16') && u.includes('with_original_language=ja')));
  // A v4 read token goes in the Authorization header instead.
  const headersSeen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { headersSeen.push([url, opts.headers]); return realFetch(url, opts); };
  await feeds.updateSettings(b, { keys: { tmdb: 'eyJsynthetic.token.value' } });
  await feeds.getTitles(b, 'movies');
  const [tokenUrl, tokenHeaders] = headersSeen.find(([u]) => u.includes('/movie/popular'));
  assert.equal(tokenHeaders.Authorization, 'Bearer eyJsynthetic.token.value');
  assert.ok(!tokenUrl.includes('api_key='));
  global.fetch = realFetch;

  // Search: movies and shows only (no people), anime recognised, at most two genres per title.
  const searched = await feeds.searchTitles(b, 'synthetic');
  assert.deepEqual(searched.data.map((t) => [t.tmdbId, t.mediaType, t.anime]), [[11, 'movie', false], [12, 'tv', true]]);
  assert.equal(searched.data[0].genres.length, 2);
  assert.ok(calls.some((u) => u.includes('/search/multi') && u.includes('query=synthetic')));

  // Watchlist: star, lists, and removal when neither.
  const movie = movies.data[0];
  await feeds.setWatch(b, { ...movie, starred: true });
  let wl = (await feeds.getWatchlist(b)).items;
  assert.equal(wl.length, 1);
  assert.equal(wl[0].starred, true);
  await feeds.setWatch(b, { tmdbId: 101, mediaType: 'movie', list: 'must_watch' });
  wl = (await feeds.getWatchlist(b)).items;
  assert.deepEqual([wl[0].starred, wl[0].list], [true, 'must_watch'], 'starring and listing are independent');
  assert.equal((await feeds.getTitles(b, 'movies')).data[0].list, 'must_watch', 'popular titles show what is already saved');
  await feeds.setWatch(b, { tmdbId: 101, mediaType: 'movie', list: 'watch_later' });
  assert.equal((await feeds.getWatchlist(b)).items[0].list, 'watch_later', 'one list at a time');
  await feeds.setWatch(b, { tmdbId: 101, mediaType: 'movie', starred: false, list: null });
  assert.equal((await feeds.getWatchlist(b)).items.length, 0, 'neither starred nor listed → removed');
  await assert.rejects(feeds.setWatch(b, { tmdbId: 999, mediaType: 'tv', starred: true }), /title is needed/);
  assert.equal((await feeds.getWatchlist(a)).items.length, 0, 'per person');
  assert.equal(schemas.watch.safeParse({ body: { tmdbId: 1, mediaType: 'movie', title: 'x', poster: 'https://evil.example/p.jpg', starred: true } }).success, false, 'posters only from TMDB');

  // Cricket: live first, scores normalised, daily call count; key and quota errors explained.
  assert.equal((await feeds.getCricket(b)).needsSetup, 'key');
  await feeds.updateSettings(b, { keys: { cricket: 'synthetic-cricket-key' } });
  const cricket = await feeds.getCricket(b);
  assert.deepEqual(cricket.data.matches.map((m) => m.id), ['m2', 'm1'], 'live match first');
  assert.deepEqual(cricket.data.matches[1].score[0], { inning: 'Australia Inning 1', runs: 300, wickets: 10, overs: 90.2 });
  assert.deepEqual(cricket.data.matches[0].teams.map((t) => t.name), ['India', 'Australia'], 'falls back to plain team names');
  assert.deepEqual(cricket.data.hits, { used: 12, limit: 100 });
  await feeds.updateSettings(b, { keys: { cricket: 'bad-key-123' } });
  await assert.rejects(feeds.getCricket(b), (e) => e.code === 'FEED_KEY_INVALID');
  await feeds.updateSettings(b, { keys: { cricket: 'spent-key-123' } });
  await assert.rejects(feeds.getCricket(b), (e) => e.code === 'FEED_RATE_LIMITED');
  await feeds.updateSettings(b, { enabled: { movies: false } });
  assert.equal((await feeds.getTitles(b, 'movies')).disabled, true);

  // --- Stocks (Marketstack): one daily call for all symbols, counted against a monthly budget.
  assert.equal((await feeds.getStocks(b)).needsSetup, 'key');
  await feeds.updateSettings(b, { keys: { marketstack: 'synthetic-marketstack-key' } });
  const found = await feeds.searchStocks(b, 'reliance');
  assert.deepEqual(found[0], { symbol: 'RELIANCE.XNSE', name: 'Reliance Industries', exchange: 'NSE', country: 'IN', currency: null });
  assert.ok(calls.some((u) => u.includes('/v2/tickerslist')) && calls.some((u) => u.includes('/v2/tickers?')), 'falls back to the older search path');
  assert.equal(sources.marketstackUsage(), 1, 'only the successful search counts');
  await feeds.updateSettings(b, { stocks: { symbols: [{ symbol: 'RELIANCE.XNSE', name: 'Reliance Industries', units: 10 }, { symbol: 'AAPL', name: 'Apple' }] } });
  const st = await feeds.getStocks(b);
  const rel = st.data.items.find((i) => i.symbol === 'RELIANCE.XNSE');
  assert.deepEqual([rel.close, rel.change, rel.change30d, rel.currency, rel.value, rel.date], [1500, 3.45, 25, 'INR', 15000, '2026-11-07']);
  assert.equal(st.data.items.find((i) => i.symbol === 'AAPL').currency, 'USD');
  assert.equal(st.data.usage, 3, 'two symbols cost two requests');
  const eodCall = calls.filter((u) => u.includes('/v2/eod')).at(-1);
  assert.ok(eodCall.includes('symbols=AAPL%2CRELIANCE.XNSE'), 'all symbols in one call');
  const eodCalls = calls.filter((u) => u.includes('/v2/eod')).length;
  await feeds.getStocks(b);
  assert.equal(calls.filter((u) => u.includes('/v2/eod')).length, eodCalls, 'kept for a day: no second call');
  // Past the budget: no call; the last copy is served (or a clear error when there is none).
  db.prepare("UPDATE feed_cache SET expires_at = 0 WHERE key LIKE 'stocks:eod:%'").run();
  await feeds.updateSettings(b, { stocks: { budget: 3 } });
  const capped = await feeds.getStocks(b);
  assert.equal(capped.stale, true);
  assert.equal(calls.filter((u) => u.includes('/v2/eod')).length, eodCalls, 'no call past the budget');
  await feeds.updateSettings(b, { stocks: { symbols: [{ symbol: 'TCS.XNSE', name: 'TCS' }] } });
  await assert.rejects(feeds.getStocks(b), (e) => e.code === 'FEED_BUDGET_REACHED');
  await feeds.updateSettings(b, { stocks: { budget: 100 }, keys: { marketstack: 'bad-key-12345' } });
  await assert.rejects(feeds.getStocks(b), (e) => e.code === 'FEED_KEY_INVALID');
  await feeds.updateSettings(b, { keys: { marketstack: 'spent-key-12345' } });
  await assert.rejects(feeds.getStocks(b), (e) => e.code === 'FEED_RATE_LIMITED');
  assert.equal(schemas.update.safeParse({ body: { stocks: { symbols: Array.from({ length: 6 }, (_, i) => ({ symbol: `S${i}` })) } } }).success, false, 'five symbols at most');
  assert.ok(!JSON.stringify(await feeds.getSettings(b)).includes('spent-key'), 'the key never comes back');

  console.log('feeds: all checks passed');
};

run().catch((err) => { console.error(err); process.exit(1); });
