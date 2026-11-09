// One Redis connection for sessions and login rate limits.
const { createClient } = require('redis');
const config = require('./index');
const logger = require('../core/logger');

const client = createClient({ url: config.redis.url });
client.on('error', (err) => logger.error('Redis error', { error: err.message }));

async function connectRedis() {
  await client.connect();
  logger.info(`Redis connected: ${config.redis.url.replace(/\/\/[^@]*@/, '//***@')}`);
}

async function disconnectRedis() {
  if (client.isOpen) await client.quit();
}

const redisStatus = () => (client.isReady ? 'connected' : 'unavailable');

module.exports = { redis: client, connectRedis, disconnectRedis, redisStatus };
