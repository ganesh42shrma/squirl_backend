// Exercises the actual app, Redis session middleware, and HTTPS proxy cookies with synthetic data.
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createECDH } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Database = require('better-sqlite3-multiple-ciphers');
const webpush = require('web-push');
const db = new Database(':memory:');
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports }; };
const values = new Map();
const redis = {
  get: async (key) => values.get(key) || null,
  set: async (key, value) => { values.set(key, value); return 'OK'; },
  del: async (keys) => { for (const key of [keys].flat()) values.delete(key); },
  expire: async () => 1,
};
const vapid = webpush.generateVAPIDKeys();
stub('../src/config', {
  env: 'production', isDev: false, serveFrontend: true, trustProxyLoopback: true,
  corsOrigin: 'https://squirl.example.invalid', appUrl: 'https://squirl.example.invalid',
  session: { secret: 'a-long-synthetic-session-secret-for-testing-only', cookieSecure: true },
  push: { ...vapid, subject: 'mailto:test@example.invalid' },
  llm: { url: 'http://127.0.0.1:1', model: 'test', timeoutMs: 100 },
  parser: { url: 'http://127.0.0.1:1', timeoutMs: 100 },
});
stub('../src/config/db', { getDb: () => db, dbStatus: () => 'connected' });
stub('../src/config/redis', { redis, redisStatus: () => 'connected' });
stub('../src/core/rateLimit', { hit: async () => {}, reset: async () => {} });
stub('../src/core/logger', { log() {}, info() {}, warn() {}, error() {} });
for (const m of require('../src/config/migrations')) typeof m === 'function' ? m(db) : db.exec(m);
db.pragma('foreign_keys = ON');
const { hashPassword } = require('../src/core/password');
const { insertUser } = require('../src/plugins/users/user.model');
const app = require('../src/app');
let server;

async function main() {
  // A missing mounted database must fail before creating folders or even reading a DB key.
  const dbFile = path.resolve(__dirname, '../src/config/db.js');
  const dbModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(dbFile, 'utf8'), {
    module: dbModule,
    require(name) {
      if (name === './index') return { db: { path: '/squirl-synthetic-unmounted-drive/no-db.sqlite', mustExist: true } };
      if (name === './dbKey') return { getDbKey() { throw new Error('must not read a key'); } };
      return createRequire(dbFile)(name);
    },
  });
  await assert.rejects(dbModule.exports.connectDB(), /Mount the database drive/);
  // Key generation preserves existing configuration, writes no secret to stdout, and never rotates keys silently.
  const keyScript = fs.readFileSync(path.resolve(__dirname, 'push-keys.js'), 'utf8');
  const runKeys = (existing, subject = 'mailto:phone@example.invalid') => {
    let content = existing;
    const output = [];
    let mode;
    const syntheticFs = {
      existsSync: () => content !== null,
      readFileSync: () => content,
      chmodSync: (file, permissions) => { mode = permissions; },
      writeFileSync: (file, text, options) => { content = text; mode = options.mode; },
    };
    let exitCode = null;
    try {
      vm.runInNewContext(keyScript, {
        __dirname,
        process: { argv: ['node', 'push-keys.js', subject], exit: (code) => { exitCode = code; throw new Error('synthetic-exit'); } },
        console: { log: (message) => output.push(message), error: (message) => output.push(message) },
        require: (name) => name === 'node:fs' ? syntheticFs : require(name),
      });
    } catch (err) { if (err.message !== 'synthetic-exit') throw err; }
    return { content, mode, output, exitCode };
  };
  const generated = runKeys('PORT=4000\nDB_KEY=synthetic-existing-key\nPUSH_PUBLIC_KEY=\nPUSH_PRIVATE_KEY=\nPUSH_SUBJECT=\n');
  assert.equal(generated.mode, 0o600); assert(generated.content.includes('DB_KEY=synthetic-existing-key'));
  assert.equal((generated.content.match(/^PUSH_PUBLIC_KEY=/gm) || []).length, 1);
  const privateKey = generated.content.match(/^PUSH_PRIVATE_KEY=(.+)$/m)[1];
  assert(!generated.output.join('').includes(privateKey));
  const duplicate = runKeys(generated.content);
  assert.equal(duplicate.exitCode, 1); assert.equal(duplicate.content, generated.content);
  const invalid = runKeys('PORT=4000\n', 'not-a-contact');
  assert.equal(invalid.exitCode, 1); assert.equal(invalid.content, 'PORT=4000\n');

  insertUser(db, { email: 'phone@example.invalid', name: 'Phone test', passwordHash: await hashPassword('synthetic-password') });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, options = {}) => fetch(`${base}${path}`, options);
  let res = await call('/app/tasks/today');
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
  assert((await res.text()).includes('rel="manifest"'));
  assert(res.headers.get('content-security-policy').includes('https://fonts.gstatic.com'));
  for (const [path, type] of [['/manifest.webmanifest', 'application/manifest+json'], ['/sw.js', 'javascript'], ['/icons/squirl-512.png', 'image/png']]) {
    res = await call(path); assert.equal(res.status, 200); assert(res.headers.get('content-type').includes(type));
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  }
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'squirl', 'X-Forwarded-Proto': 'https' };
  res = await call('/api/notifications/status', { method: 'POST', headers, body: '{}' });
  assert.equal(res.status, 401);
  const loginBody = JSON.stringify({ email: 'phone@example.invalid', password: 'synthetic-password' });
  res = await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: loginBody });
  assert.equal(res.status, 403, 'CSRF guard remains active');
  res = await call('/api/auth/login', { method: 'POST', headers, body: loginBody });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert(cookie?.includes('Secure')); assert(cookie.includes('HttpOnly')); assert(cookie.includes('SameSite=Strict'));
  headers.Cookie = cookie.split(';')[0];
  res = await call('/api/notifications/status', { method: 'POST', headers, body: '{}' });
  assert.equal(res.status, 200); assert.equal((await res.json()).data.enabled, false);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  res = await call('/api/no-such-route', { headers });
  assert.equal(res.status, 404); assert(res.headers.get('content-type').includes('application/json'), 'API errors never become SPA HTML');
  const key = createECDH('prime256v1'); key.generateKeys();
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/http-test', keys: { p256dh: key.getPublicKey().toString('base64url'), auth: Buffer.alloc(16).toString('base64url') } };
  res = await call('/api/notifications/subscription', { method: 'PUT', headers, body: JSON.stringify({ subscription, preferences: {} }) });
  assert.equal(res.status, 200); assert.equal((await res.json()).data.enabled, true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM push_subscriptions').get().n, 1);
  res = await call('/api/auth/logout', { method: 'POST', headers });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM push_subscriptions').get().n, 0, 'logout revokes this session’s push device');
  res = await call('/api/notifications/status', { method: 'POST', headers, body: '{}' });
  assert.equal(res.status, 401);
  console.log('Passed: missing-drive protection, private key setup, SPA deep links, manifest/icons/worker headers, private API guard, CSRF, secure proxy login cookies, subscription route, API 404s, and logout revocation.');
}
main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  db.close();
});
