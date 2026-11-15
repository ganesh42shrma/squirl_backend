// Explicit local-only launcher settings. Never reads or rewrites the normal backend .env.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parse } = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
const EMAIL = 'local@squirl.test';
// The demo password is generated per machine and kept in the ignored .local/development.env,
// so no credential is committed. `npm run dev:local` prints it at startup.
const newPassword = () => `demo-${randomBytes(9).toString('base64url')}`;

function localSettings(root = ROOT) {
  const folder = path.join(root, '.local');
  if (fs.existsSync(folder) && (!fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink())) throw new Error('The local test folder must be a real directory, not a link.');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, 'development.env');
  const database = path.join(folder, 'squirl-dev.db');
  for (const target of [file, database]) {
    let stat;
    try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && (stat.isSymbolicLink() || stat.nlink > 1)) throw new Error('Local test settings/database cannot be symbolic links or hard links.');
  }
  if (!fs.existsSync(file)) {
    if (fs.existsSync(database)) throw new Error('The local test database exists but its settings/key are missing. Restore .local/development.env instead of generating a replacement key.');
    const push = require('web-push').generateVAPIDKeys();
    const settings = {
      NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '4000', LOG_LEVEL: 'info',
      DB_PATH: database, DB_KEY: randomBytes(32).toString('hex'), DB_MUST_EXIST: 'false',
      REDIS_URL: 'redis://127.0.0.1:6381', COOKIE_SECURE: 'false', TRUST_PROXY_LOOPBACK: 'false',
      SESSION_SECRET: randomBytes(32).toString('hex'), ALLOW_REGISTRATION: 'true', SERVE_FRONTEND: 'true',
      APP_URL: 'http://localhost:5173', CORS_ORIGIN: 'http://localhost:5173',
      LLM_URL: 'http://127.0.0.1:11435', LLM_MODEL: 'qwen3.5:9b', LLM_TIMEOUT_MS: '10000',
      PARSER_SERVICE_URL: 'http://127.0.0.1:8000', PARSER_TIMEOUT_MS: '60000',
      PUSH_PUBLIC_KEY: push.publicKey, PUSH_PRIVATE_KEY: push.privateKey, PUSH_SUBJECT: 'mailto:local@squirl.test',
      LOCAL_DEMO_PASSWORD: newPassword(),
    };
    fs.writeFileSync(file, Object.entries(settings).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  }
  let env = parse(fs.readFileSync(file));
  // Setups created before the password moved here get one added; the caller resets the demo login to it.
  const passwordAdded = !env.LOCAL_DEMO_PASSWORD;
  if (passwordAdded) {
    fs.appendFileSync(file, `LOCAL_DEMO_PASSWORD=${JSON.stringify(newPassword())}\n`);
    env = parse(fs.readFileSync(file));
  }
  if (env.DB_PATH !== database || env.HOST !== '127.0.0.1' || env.PORT !== '4000'
    || env.NODE_ENV !== 'development' || env.REDIS_URL !== 'redis://127.0.0.1:6381'
    || env.COOKIE_SECURE !== 'false' || env.TRUST_PROXY_LOOPBACK !== 'false'
    || !env.DB_KEY || !env.SESSION_SECRET) throw new Error('Local test settings must use the dedicated .local database, loopback host, port 4000, and Redis port 6381.');
  fs.chmodSync(file, 0o600);
  return { folder, database, password: env.LOCAL_DEMO_PASSWORD, passwordAdded, env: { ...env, DOTENV_CONFIG_PATH: file } };
}

module.exports = { ROOT, EMAIL, localSettings };
