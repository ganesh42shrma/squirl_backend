// Database cache for public data: answers are kept per request key with an expiry. A fresh copy is
// served as is; an expired one triggers a refetch; if the source is down, the last good copy is
// served marked `stale` so the card still shows something. Concurrent requests share one fetch.
const { getDb } = require('../../config/db');

const inFlight = new Map();

function read(key) {
  return getDb().prepare('SELECT body, fetched_at, expires_at FROM feed_cache WHERE key = ?').get(key);
}

function write(key, data, ttlMs) {
  const fetchedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO feed_cache (key, body, fetched_at, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
    )
    .run(key, JSON.stringify(data), fetchedAt, Date.now() + ttlMs);
  return fetchedAt;
}

async function cached(key, ttlMs, fetcher) {
  const row = read(key);
  if (row && row.expires_at > Date.now()) return { data: JSON.parse(row.body), fetchedAt: row.fetched_at, stale: false };
  if (!inFlight.has(key)) {
    inFlight.set(
      key,
      (async () => {
        try {
          const data = await fetcher();
          return { data, fetchedAt: write(key, data, ttlMs), stale: false };
        } finally {
          inFlight.delete(key);
        }
      })(),
    );
  }
  try {
    return await inFlight.get(key);
  } catch (err) {
    if (row) return { data: JSON.parse(row.body), fetchedAt: row.fetched_at, stale: true };
    throw err;
  }
}

module.exports = { cached };
