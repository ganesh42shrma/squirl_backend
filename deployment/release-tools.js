// Deployment helpers use Node/Git/npm only; production keys are never needed for builds/tests.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');

const BRANCH = 'squirl-deploy';
const SHA = /^[a-f0-9]{40}$/;
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', SSH_AUTH_SOCK: '', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15' });
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60_000,
    env: gitEnv(), ...options });
  if (result.error || result.status !== 0) {
    const detail = String(result.error?.message || result.stderr || result.stdout || `exit ${result.status}`)
      .replace(/https?:\/\/[^\s/]+@/g, 'https://***@');
    throw new Error(`${path.basename(command)} ${args[0] || ''} failed: ${detail.slice(-2500)}`);
  }
  return String(result.stdout || '').trim();
}
const git = (repo, args, options) => run('git', ['-C', repo, ...args], options);
function mkdir(folder) { fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); }
function writeJson(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}
function readJson(file, fallback = null) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
function manifest(value) {
  if (value?.schema !== 1 || !SHA.test(value.backend) || !SHA.test(value.frontend)
    || Object.keys(value).sort().join(',') !== 'backend,createdAt,frontend,schema' || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('Invalid release manifest');
  return value;
}
function safeTree(repo, sha) {
  if (!SHA.test(sha)) throw new Error('Expected a full commit SHA');
  for (const entry of git(repo, ['ls-tree', '-rz', sha]).split('\0').filter(Boolean)) {
    const [header, name] = entry.split('\t');
    const parts = name.split('/');
    if (!/^100(?:644|755) blob /.test(header) || parts.some((p) => ['..', '.git', '.local', 'node_modules', 'dist', 'logs'].includes(p))
      || parts.some((p) => p.startsWith('.env') && p !== '.env.example') || /\.(?:db|sqlite3?|jks|keystore|p12)(?:-journal)?$/i.test(name)) {
      throw new Error(`Release contains a forbidden file or link: ${name}`);
    }
  }
}
function extract(repo, sha, destination) {
  safeTree(repo, sha); mkdir(destination);
  const archive = `${destination}.tar`;
  try {
    git(repo, ['archive', '--format=tar', `--output=${archive}`, sha]);
    run('tar', ['-xf', archive, '-C', destination]);
  } finally { if (fs.existsSync(archive)) fs.unlinkSync(archive); }
}
function testEnvironment(folder) {
  const envFile = path.join(folder, 'checks.env');
  fs.writeFileSync(envFile, '', { mode: 0o600 });
  return { ...gitEnv(), NODE_ENV: 'test', DOTENV_CONFIG_PATH: envFile,
    DB_PATH: path.join(folder, 'unused-test.db'), DB_KEY: randomBytes(32).toString('hex'), DB_MUST_EXIST: 'false',
    SESSION_SECRET: randomBytes(32).toString('hex'), REDIS_URL: 'redis://127.0.0.1:1', HOST: '127.0.0.1', PORT: '4000',
    COOKIE_SECURE: 'false', SERVE_FRONTEND: 'false', TRUST_PROXY_LOOPBACK: 'false',
    PUSH_PUBLIC_KEY: '', PUSH_PRIVATE_KEY: '', PUSH_SUBJECT: '',
    VITE_API_URL: '', VITE_API_PROXY: 'http://127.0.0.1:4000' };
}
function checks(folder, { install = true, execute = run } = {}) {
  const env = testEnvironment(folder);
  const backend = path.join(folder, 'squirl_backend'), frontend = path.join(folder, 'squirl_frontend');
  if (install) for (const cwd of [backend, frontend]) {
    console.log(`Installing locked dependencies: ${path.basename(cwd)}`);
    execute('npm', ['ci', '--include=dev', '--no-audit', '--no-fund', ...(cwd === frontend ? ['--legacy-peer-deps'] : [])], { cwd, env });
  }
  console.log('Building frontend snapshot');
  execute('npm', ['run', 'build'], { cwd: frontend, env: { ...env, NODE_ENV: 'production' } });
  for (const cwd of [backend, frontend]) {
    const scripts = readJson(path.join(cwd, 'package.json')).scripts || {};
    for (const script of Object.keys(scripts).filter((s) => s.startsWith('test:'))) {
      console.log(`Checking ${path.basename(cwd)} ${script}`);
      execute('npm', ['run', script], { cwd, env });
    }
  }
}
function switchCurrent(root, target) {
  const temporary = path.join(root, `current-${randomUUID()}`);
  fs.symlinkSync(target, temporary, 'dir');
  fs.renameSync(temporary, path.join(root, 'current'));
}
async function healthy(url, attempts = 1) {
  for (let n = 0; n < attempts; n++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      const value = await response.json();
      if (response.ok && value.success && value.data?.status === 'ok' && value.data.db === 'connected' && value.data.sessions === 'connected') return true;
    } catch { /* A restarting backend may not be listening yet. */ }
    if (n + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}
const defaultRoot = () => path.join(os.homedir(), '.local/share/squirl-deploy');
module.exports = { BRANCH, SHA, run, git, gitEnv, mkdir, writeJson, readJson, manifest, extract, checks, switchCurrent, healthy, defaultRoot };
