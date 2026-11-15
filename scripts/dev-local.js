const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { ROOT, EMAIL, localSettings } = require('./local-settings');

const children = [];
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  const limit = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(code); }, 6000);
  await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode ? null : new Promise((resolve) => child.once('exit', resolve))));
  clearTimeout(limit); process.exit(code);
}
function child(command, args, options = {}) {
  const process = spawn(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
  children.push(process);
  process.once('error', (error) => { console.error(`Could not start ${command}: ${error.message}`); stop(1); });
  return process;
}
async function freePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Local development port ${port} is already in use or unavailable. Stop the previous local dev run first.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
async function run(command, args, options) {
  const process = child(command, args, options);
  const code = await new Promise((resolve) => process.once('exit', resolve));
  if (code !== 0) throw new Error(`Local build exited with code ${code}`);
}

async function main() {
  const settings = localSettings();
  Object.assign(process.env, settings.env); // Overrides inherited USB/home settings too.
  const { connectDB, disconnectDB, getDb } = require('../src/config/db');
  await connectDB();
  try {
    if (process.argv.includes('--payment')) {
      const user = getDb().prepare('SELECT id FROM users WHERE email = ?').get(EMAIL);
      if (!user) throw new Error('Start npm run dev:local once to create the demo account.');
      require('./local-fixtures').samplePayment(getDb(), user.id);
      console.log('Added one fictional SMS payment. Enabled local notifications will pick it up within a minute.');
      return;
    }
    const fixtures = require('./local-fixtures');
    const seeded = await fixtures.seedLocal(getDb(), settings.password);
    if (!seeded && settings.passwordAdded) await fixtures.setDemoPassword(getDb(), settings.password);
  } finally { await disconnectDB(); }

  for (const port of [4000, 5173, 6381]) await freePort(port);
  const frontend = path.resolve(ROOT, '../squirl_frontend');
  const vite = path.join(frontend, 'node_modules/vite/bin/vite.js');
  if (!fs.existsSync(vite)) throw new Error('Install the frontend dependencies first: cd ../squirl_frontend && npm install');
  const frontendEnv = { ...process.env, VITE_API_URL: '', VITE_API_PROXY: 'http://127.0.0.1:4000' };
  const buildEnv = { ...frontendEnv, NODE_ENV: 'production' };
  await run(process.execPath, [vite, 'build', '--logLevel', 'warn'], { cwd: frontend, env: buildEnv });
  await run(process.execPath, ['scripts/build-sw.mjs'], { cwd: frontend, env: buildEnv });
  const redis = child('redis-server', ['--bind', '127.0.0.1', '--port', '6381', '--save', '', '--appendonly', 'no', '--protected-mode', 'yes', '--dir', settings.folder], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local Redis did not become ready. Install it with brew install redis if needed.')), 10000);
    redis.stdout.on('data', (data) => { if (data.toString().includes('Ready to accept connections')) { clearTimeout(timer); resolve(); } });
    redis.stderr.on('data', (data) => process.stderr.write(data));
    redis.once('exit', () => { clearTimeout(timer); reject(new Error('The dedicated local Redis could not start.')); });
    redis.once('error', reject);
  });
  const backend = child(process.execPath, ['--watch', 'src/server.js'], { env: { ...process.env } });
  const ui = child(process.execPath, [vite, '--host', '127.0.0.1', '--port', '5173', '--strictPort'], { cwd: frontend, env: frontendEnv });
  for (const service of [redis, backend, ui]) service.once('exit', () => { if (!stopping) { console.error('A local development service exited; stopping the other services.'); stop(1); } });
  console.log(`\nLOCAL TEST DATA · ${settings.database}\nLive UI: http://localhost:5173\nPWA/build preview: http://localhost:4000\nDemo login: ${EMAIL}\nDemo password: ${settings.password}\nCtrl+C stops this local stack. Home/USB settings are unchanged.\n`);
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
main().catch((error) => { console.error(error.message); stop(1); });
