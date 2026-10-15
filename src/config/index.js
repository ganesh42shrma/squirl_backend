require('dotenv').config();

const required = ['MONGO_URI'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error(`Missing required env vars: ${missing.join(', ')}`);
}

const env = process.env.NODE_ENV || 'development';

const config = Object.freeze({
  env,
  isDev: env === 'development',
  port: Number(process.env.PORT) || 4000,
  mongoUri: process.env.MONGO_URI,
  logLevel: process.env.LOG_LEVEL || (env === 'development' ? 'debug' : 'info'),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  parser: Object.freeze({
    url: process.env.PARSER_SERVICE_URL || 'http://127.0.0.1:8000',
    timeoutMs: Number(process.env.PARSER_TIMEOUT_MS) || 60000,
  }),
});

module.exports = config;
