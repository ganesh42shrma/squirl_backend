// Disposable local Git remotes and an encrypted synthetic DB. Never contacts GitHub/systemd/home.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3-multiple-ciphers');
const t = require('../deployment/release-tools');
const { publish } = require('../deployment/publish');
const { deploy } = require('../deployment/deploy');
const { install, units } = require('../deployment/install');
process.env.GIT_CONFIG_GLOBAL = '/dev/null'; process.env.GIT_CONFIG_NOSYSTEM = '1';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'squirl-deploy-test-'));
const sources = path.join(scratch, 'sources'); t.mkdir(sources);
const backend = path.join(sources, 'squirl_backend'), frontend = path.join(sources, 'squirl_frontend');
const actualBackend = path.resolve(__dirname, '..');
const root = path.join(scratch, 'controller');
for (const part of ['repos', 'releases', 'backups']) t.mkdir(path.join(root, part));
const dbFile = path.join(scratch, 'private.db');
const key = 'synthetic-encrypted-release-test-key';
function openDb() {
  const db = new Database(dbFile); db.pragma("cipher = 'sqlcipher'"); db.pragma('legacy = 4'); db.pragma(`key = '${key}'`); return db;
}
function readDb(fn) { const db = openDb(); try { return fn(db); } finally { db.close(); } }
const schema = () => readDb((db) => db.pragma('user_version', { simple: true }));
function init(repo, name) {
  t.mkdir(repo); t.run('git', ['init', '-b', 'main', repo]);
  t.git(repo, ['config', 'user.name', 'Synthetic release test']); t.git(repo, ['config', 'user.email', 'release@example.invalid']);
  const remote = path.join(scratch, `${name}.git`); t.run('git', ['init', '--bare', remote]); t.git(repo, ['remote', 'add', 'origin', remote]);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\ndist/\n.env\n');
  fs.symlinkSync(path.join(actualBackend, 'node_modules'), path.join(repo, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(repo, 'fixture-check.js'), `const assert=require('node:assert/strict'); assert.equal(process.env.NODE_ENV,'test'); assert.match(process.env.DB_KEY,/^[a-f0-9]{64}$/); assert.equal(process.env.PUSH_PRIVATE_KEY,'');`);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { 'test:synthetic': 'node fixture-check.js', ...(name === 'frontend' ? { build: 'node fixture-build.js' } : {}) } }));
  return remote;
}
const backendUrl = init(backend, 'backend'), frontendUrl = init(frontend, 'frontend');
fs.cpSync(path.join(actualBackend, 'src'), path.join(backend, 'src'), { recursive: true });
fs.writeFileSync(path.join(frontend, 'fixture-build.js'), "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','synthetic build');");
const commit = (repo, message) => { t.git(repo, ['add', '.']); t.git(repo, ['commit', '-m', message]); return t.git(repo, ['rev-parse', 'HEAD']); };
commit(backend, 'Initial synthetic backend'); commit(frontend, 'Initial synthetic frontend');
const originalMigrations = fs.readFileSync(path.join(backend, 'src/config/migrations.js'), 'utf8');
const baseVersion = require('../src/config/migrations').length;
readDb((db) => {
  db.pragma('foreign_keys = OFF');
  for (const migration of require('../src/config/migrations')) typeof migration === 'function' ? migration(db) : db.exec(migration);
  db.pragma(`user_version = ${baseVersion}`);
  db.exec("CREATE TABLE deployment_data(k TEXT PRIMARY KEY,v TEXT); INSERT INTO deployment_data VALUES('initial','retained');");
});
const envFile = path.join(scratch, 'production.env');
fs.writeFileSync(envFile, `NODE_ENV=production\nHOST=127.0.0.1\nPORT=4000\nSERVE_FRONTEND=true\nDB_MUST_EXIST=true\nDB_PATH=${dbFile}\nDB_KEY=${key}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(root, 'empty.env'), '');
fs.symlinkSync(sources, path.join(root, 'current'), 'dir');
const config = { root, envFile, node: process.execPath, backendUrl, frontendUrl };
let running = true, badCommit = null;
const controls = [];
const target = () => fs.realpathSync(path.join(root, 'current'));
const selected = () => t.readJson(path.join(target(), 'release.json'))?.commit;
const control = (verb) => {
  controls.push(verb); running = verb === 'start';
  if (verb === 'start' && selected()) {
    t.run(process.execPath, [path.join(actualBackend, 'deployment/db-tool.js'), path.join(target(), 'squirl_backend'), '--migrate'], { cwd: path.join(target(), 'squirl_backend'), env: {
      ...process.env, DOTENV_CONFIG_PATH: path.join(root, 'empty.env'), DB_PATH: dbFile, DB_KEY: key, DB_MUST_EXIST: 'true', NODE_ENV: 'test', LOG_LEVEL: 'error',
    } });
    if (selected() === badCommit) readDb((db) => db.prepare('INSERT OR REPLACE INTO deployment_data VALUES(?, ?)').run(badCommit, 'accepted after start'));
  }
};
const health = async () => running && selected() !== badCommit;
const stageChecks = async (folder) => {
  for (const name of ['squirl_backend', 'squirl_frontend']) fs.symlinkSync(path.join(actualBackend, 'node_modules'), path.join(folder, name, 'node_modules'), 'dir');
  t.checks(folder, { install: false });
};
const release = () => publish({ backend, frontend });
const update = (extra = {}) => deploy(config, { check: stageChecks, control, health, ...extra });
const changeFrontend = (text) => { fs.writeFileSync(path.join(frontend, 'version.txt'), text); commit(frontend, text); };
const migrate = (sql) => { fs.writeFileSync(path.join(backend, 'src/config/migrations.js'), originalMigrations.replace(/\];\s*$/, `\`${sql}\`,\n];\n`)); commit(backend, 'Synthetic migration change'); };

async function testInstaller() {
  const installRoot = path.join(scratch, 'installed controller');
  const home = path.join(scratch, 'test-home');
  fs.copyFileSync(envFile, path.join(backend, '.env'));
  // The installer copies its own runtime; all Git/network and systemd commands below are simulated.
  let failure = null;
  const commands = [];
  const execute = (command, args) => {
    commands.push({ command, args });
    if (command === 'systemd-analyze' && failure === 'syntax') throw new Error('Synthetic unit syntax error');
    if (command === 'systemctl' && args.includes('--property=LoadState')) return failure === args[2] ? 'bad-setting' : 'loaded';
    if (command === 'systemctl' && args.includes('--property=ActiveState')) return failure === 'inactive' && args[2] === 'squirl-deploy.timer' ? 'inactive' : 'active';
    return '';
  };
  const setup = () => install({ source: backend, root: installRoot, home, execute, health: async () => true });
  const installed = await setup();
  const appFile = path.join(home, '.config/systemd/user/squirl.service.d/release.conf');
  const serviceFile = path.join(home, '.config/systemd/user/squirl-deploy.service');
  for (const file of [appFile, serviceFile]) {
    const directory = fs.readFileSync(file, 'utf8').split('\n').find((line) => line.startsWith('WorkingDirectory=')).slice('WorkingDirectory='.length);
    assert(path.isAbsolute(directory), 'systemd requires an absolute WorkingDirectory with no surrounding quotes');
    assert(fs.statSync(directory).isDirectory(), 'spaces in a literal WorkingDirectory must still refer to the real folder');
  }
  assert.equal(installed.root, installRoot);
  assert(commands.findIndex((c) => c.command === 'systemd-analyze') < commands.findIndex((c) => c.args.includes('enable')));
  for (const [mode, error] of [['syntax', /unit syntax error/], ['squirl.service', /squirl.service did not load/], ['squirl-deploy.service', /squirl-deploy.service did not load/], ['inactive', /timer did not become active/]]) {
    failure = mode; commands.length = 0;
    await assert.rejects(setup(), error, 'installation must reject invalid units or an inactive timer');
    if (mode !== 'inactive') assert(!commands.some((c) => c.args.includes('enable')));
    assert(!commands.some((c) => c.command === 'systemctl' && ['stop', 'start', 'restart'].includes(c.args[1]) && c.args[2] === 'squirl.service'), 'installation never restarts the running app');
  }
  assert.equal(fs.readFileSync(path.join(backend, '.env'), 'utf8'), fs.readFileSync(envFile, 'utf8'));
}

async function main() {
  assert.throws(() => t.run(process.execPath, ['-e', "console.error('https://synthetic-token@example.invalid/repo');process.exit(1)"]), (error) => !error.message.includes('synthetic-token'));
  const first = await release();
  assert.equal(t.git(backendUrl, ['rev-parse', 'refs/heads/main']), first.backend);
  assert.equal(t.git(frontendUrl, ['rev-parse', 'refs/heads/main']), first.frontend);
  assert.equal(JSON.parse(t.git(backendUrl, ['show', `refs/heads/${t.BRANCH}:release.json`])).frontend, first.frontend);
  const result = await update();
  assert.equal(result.status, 'deployed');
  assert.equal(schema(), baseVersion);
  assert.equal(fs.existsSync(path.join(result.path, 'squirl_backend/.env')), false);
  const backup = t.readJson(path.join(root, 'state.json')).active.backup;
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.notEqual(fs.readFileSync(backup).subarray(0, 16).toString(), 'SQLite format 3\0');
  const events = controls.length;
  const stateFile = path.join(root, 'state.json');
  const interrupted = t.readJson(stateFile); interrupted.activating = { ...interrupted.active, previous: sources };
  delete interrupted.active; t.writeJson(stateFile, interrupted);
  assert.equal((await update()).status, 'current', 'healthy post-switch interruptions are adopted without another restart');
  const beforeSwitch = t.readJson(stateFile); beforeSwitch.activating = { path: path.join(root, 'never-selected'), previous: target() };
  t.writeJson(stateFile, beforeSwitch);
  assert.equal((await update()).status, 'current', 'pre-switch interruptions keep the healthy prior app running');
  assert.equal(controls.length, events);
  assert.equal((await update()).status, 'current'); assert.equal(controls.length, events);
  changeFrontend('ordinary code push'); t.git(frontend, ['push', 'origin', 'main']);
  assert.equal((await update()).status, 'current', 'main pushes alone cannot deploy mismatched repositories');
  await release();
  const previous = target();
  await assert.rejects(update({ check: async () => { throw new Error('synthetic build failure'); } }), /synthetic build failure/);
  assert.equal(target(), previous); assert.equal(controls.length, events); assert(running);
  assert.equal((await update()).status, 'deployed', 'a preparation failure can retry without an app interruption');

  changeFrontend('unhealthy same-schema release');
  const broken = await release(); badCommit = broken.commit;
  const lastGood = target();
  await assert.rejects(update(), /previous app restored/);
  assert.equal(target(), lastGood); assert(running);
  assert.equal(readDb((db) => db.prepare('SELECT v FROM deployment_data WHERE k = ?').pluck().get(broken.commit)), 'accepted after start', 'rollback preserves data accepted by the failed app');
  assert.equal((await update()).status, 'failed', 'failed activations are not retried every minute');

  migrate('THIS IS NOT VALID SQL');
  await release(); badCommit = null;
  await assert.rejects(update(), /schema check failed/);
  assert.equal(schema(), baseVersion); assert.equal(target(), lastGood); assert(running, 'failed trial migrations leave the real schema and old app intact');
  migrate('CREATE TABLE release_v_next(id TEXT)');
  const schemaRelease = await release(); badCommit = schemaRelease.commit;
  await assert.rejects(update(), /safe code rollback was not possible/);
  assert.equal(schema(), baseVersion + 1); assert.equal(running, false);
  assert.equal(readDb((db) => db.prepare('SELECT v FROM deployment_data WHERE k = ?').pluck().get(schemaRelease.commit)), 'accepted after start');
  assert.equal(t.readJson(path.join(root, 'state.json')).failed.recovery, true);
  changeFrontend('compatible replacement'); await release(); badCommit = null;
  assert.equal((await update()).status, 'deployed'); assert(running); assert.equal(schema(), baseVersion + 1);
  assert.equal(t.readJson(path.join(root, 'state.json')).failed, undefined);

  let winner;
  await assert.rejects(publish({ backend, frontend, check: async () => { winner = await publish({ backend, frontend, check: async () => {} }); } }), /failed/);
  assert.equal(t.git(backendUrl, ['rev-parse', `refs/heads/${t.BRANCH}`]), winner.commit, 'a concurrent publisher cannot overwrite the winner');
  const savedDb = `${dbFile}.saved`; fs.renameSync(dbFile, savedDb);
  await assert.rejects(update(), /existing absolute DB_PATH/); fs.renameSync(savedDb, dbFile);
  assert(running);
  await testInstaller();
  fs.writeFileSync(path.join(backend, '.env'), 'synthetic-secret'); t.git(backend, ['add', '-f', '.env']); t.git(backend, ['commit', '-m', 'Forbidden test file']);
  await assert.rejects(release(), /forbidden file/);
  fs.writeFileSync(path.join(frontend, 'dirty.txt'), 'uncommitted');
  await assert.rejects(release(), /Commit or stash/);
  const text = units(config);
  assert(text.app.includes('current/squirl_backend')); assert(text.app.includes('DOTENV_CONFIG_PATH='));
  assert(text.service.includes('Type=oneshot')); assert(text.timer.includes('OnUnitInactiveSec=60s'));
  assert.equal(fs.readFileSync(envFile, 'utf8').includes(key), true, 'production env is preserved');
  console.log('Passed: pinned two-repo publication, concurrent publish guard, staged checks, marker-only deployment, encrypted backup, trial migrations, health rollback without data loss, schema-change recovery, missing drive, secret/dirty-tree rejection, literal systemd paths, and installer failure checks.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(scratch, { recursive: true, force: true }));
