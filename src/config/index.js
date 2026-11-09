require('dotenv').config();

const env = process.env.NODE_ENV || 'development';

const config = Object.freeze({
  env,
  isDev: env === 'development',
  port: Number(process.env.PORT) || 4000,
  db: Object.freeze({
    // SQLCipher-encrypted SQLite file. Default: the "mushroom" pendrive.
    path: process.env.DB_PATH || '/Volumes/mushroom/squirl/squirl.db',
    // Optional. When unset the key is read from the macOS Keychain (see `npm run db:key`).
    key: process.env.DB_KEY || null,
  }),
  logLevel: process.env.LOG_LEVEL || (env === 'development' ? 'debug' : 'info'),
  // Where the frontend lives, for links in emails (password reset).
  appUrl: process.env.APP_URL || 'http://localhost:5173',
  // Exact origin of the frontend. Cookies are sent cross-origin only to this origin.
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  redis: Object.freeze({
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  }),
  session: Object.freeze({
    // Optional; by default derived from the database key.
    secret: process.env.SESSION_SECRET || null,
    // Send the cookie over HTTPS only. Leave false for http://localhost.
    cookieSecure: process.env.COOKIE_SECURE === 'true',
  }),
  // New accounts can sign up while this is on. Turn off once everyone who should have one does.
  allowRegistration: process.env.ALLOW_REGISTRATION !== 'false',
  // Optional local LLM speaking the OpenAI chat API. Default: Squirl's own Ollama server
  // (`npm run llm`, port 11435, models on the pendrive). Used for written summaries and
  // category suggestions; every number it shows was computed by this app, not the model.
  llm: Object.freeze({
    url: process.env.LLM_URL || 'http://127.0.0.1:11435',
    model: process.env.LLM_MODEL || 'qwen3.5:9b',
    // Long enough to wait out the model loading from the USB stick (~3 min) on a cold start.
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 300000,
  }),
  parser: Object.freeze({
    url: process.env.PARSER_SERVICE_URL || 'http://127.0.0.1:8000',
    timeoutMs: Number(process.env.PARSER_TIMEOUT_MS) || 60000,
  }),
});

module.exports = config;
