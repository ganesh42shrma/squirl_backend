// Fixed-window counters in Redis, used to slow down password guessing.
const { redis } = require('../config/redis');
const AppError = require('./AppError');

/**
 * Counts an attempt under `key`; throws 429 once `limit` attempts happen within `windowSec`.
 * The window starts at the first attempt.
 */
async function hit(key, { limit, windowSec }) {
  const fullKey = `squirl:rl:${key}`;
  const count = await redis.incr(fullKey);
  if (count === 1) await redis.expire(fullKey, windowSec);
  if (count > limit) {
    const ttl = await redis.ttl(fullKey);
    throw new AppError(`Too many attempts. Try again in ${Math.ceil(Math.max(ttl, 60) / 60)} minute(s)`, 429, 'TOO_MANY_ATTEMPTS');
  }
}

const reset = (key) => redis.del(`squirl:rl:${key}`);

module.exports = { hit, reset };
