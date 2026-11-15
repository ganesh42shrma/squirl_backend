require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

const env = process.env.NODE_ENV || 'development';

const config = Object.freeze({
  env,
  isDev: env === 'development',
  port: Number(process.env.PORT) || 4000,
  host: process.env.HOST || '127.0.0.1',
  serveFrontend: process.env.SERVE_FRONTEND === 'true',
  trustProxyLoopback: process.env.TRUST_PROXY_LOOPBACK === 'true',
  push: Object.freeze({
    publicKey: process.env.PUSH_PUBLIC_KEY || '',
    privateKey: process.env.PUSH_PRIVATE_KEY || '',
    subject: process.env.PUSH_SUBJECT || '',
  }),
  db: Object.freeze({
    // SQLCipher-encrypted SQLite file. Default: the "mushroom" pendrive.
    path: process.env.DB_PATH || '/Volumes/mushroom/squirl/squirl.db',
    mustExist: process.env.DB_MUST_EXIST === 'true',
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
  // Optional photo attachments. Left raw here: src/plugins/media/media.runtime.js validates it and
  // decides whether the feature is on, so a bad value switches media off instead of stopping boot.
  media: Object.freeze({
    dir: process.env.MEDIA_DIR || '',
    key: process.env.MEDIA_KEY || '',
    maxBytes: Number(process.env.MEDIA_MAX_BYTES) || 8 * 1024 * 1024,
    userQuotaBytes: Number(process.env.MEDIA_USER_QUOTA_BYTES) || 5 * 1024 * 1024 * 1024,
    maxPerOwner: Number(process.env.MEDIA_MAX_PER_OWNER) || 10,
    // Optional encrypted replica in S3-compatible storage; used only when the four required values are set.
    s3: Object.freeze({
      endpoint: process.env.S3_ENDPOINT || '',
      bucket: process.env.S3_BUCKET || '',
      region: process.env.S3_REGION || 'auto',
      accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
      pathStyle: process.env.S3_PATH_STYLE !== 'false',
    }),
  }),
  parser: Object.freeze({
    url: process.env.PARSER_SERVICE_URL || 'http://127.0.0.1:8000',
    timeoutMs: Number(process.env.PARSER_TIMEOUT_MS) || 60000,
  }),
});

module.exports = config;
