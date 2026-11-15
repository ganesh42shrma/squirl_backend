const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { randomUUID } = require('node:crypto');
const t = require('./release-tools');

function production(config) {
  const env = parseEnv(fs.readFileSync(config.envFile, 'utf8'));
  if (env.NODE_ENV !== 'production' || env.DB_MUST_EXIST !== 'true' || !path.isAbsolute(env.DB_PATH || '') || !env.DB_KEY
    || !fs.existsSync(env.DB_PATH) || env.SERVE_FRONTEND !== 'true' || !['127.0.0.1', 'localhost'].includes(env.HOST || '127.0.0.1')) {
    throw new Error('Production .env must retain its existing DB_KEY, an existing absolute DB_PATH, DB_MUST_EXIST=true, SERVE_FRONTEND=true, and loopback HOST.');
  }
  const port = Number(env.PORT || 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid production port');
  return { env, url: `http://127.0.0.1:${port}/api/health` };
}
function fetchRepo(folder, url) {
  if (!fs.existsSync(folder)) t.run('git', ['init', '--bare', folder]);
  const remotes = t.git(folder, ['remote']).split('\n');
  t.git(folder, remotes.includes('origin') ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]);
}
function schema(config, backend, database, env, migrate = false) {
  const output = t.run(config.node, [path.join(__dirname, 'db-tool.js'), backend, ...(migrate ? ['--migrate'] : [])], {
    cwd: backend, env: { ...t.gitEnv(), ...env, DOTENV_CONFIG_PATH: path.join(config.root, 'empty.env'), DB_PATH: database,
      DB_MUST_EXIST: 'true', NODE_ENV: 'test', LOG_LEVEL: 'error' },
  });
  const result = JSON.parse(output.split('\n').at(-1));
  if (!Number.isInteger(result.version)) throw new Error('Invalid schema-check response');
  return result.version;
}
function copyDatabase(source, target) {
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600);
  const descriptor = fs.openSync(target, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function trimReleases(root, protectedPaths) {
  const folder = path.join(root, 'releases');
  const releases = fs.readdirSync(folder).filter((name) => /^[a-f0-9]{12}-[a-f0-9-]{36}$/.test(name))
    .map((name) => path.join(folder, name)).filter((file) => fs.existsSync(path.join(file, 'release.json')))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const release of releases.slice(3)) if (!protectedPaths.includes(release)) fs.rmSync(release, { recursive: true, force: true });
}

async function deploy(config, { check = t.checks, health = t.healthy, control = (verb) => t.run('systemctl', ['--user', verb, 'squirl.service']) } = {}) {
  const root = fs.realpathSync(config.root), stateFile = path.join(root, 'state.json');
  config = { ...config, root };
  const current = path.join(root, 'current');
  if (!fs.lstatSync(current).isSymbolicLink()) throw new Error('Deployment current must be the managed symlink.');
  const state = t.readJson(stateFile, {});
  const { env, url } = production(config);
  const persist = () => t.writeJson(stateFile, state);
  // A restart after interruption may already have brought the selected release up successfully.
  if (state.activating) {
    const selectedPath = fs.realpathSync(current);
    if (await health(url, 3) && selectedPath === state.activating.path) {
      state.active = state.activating; delete state.activating; delete state.failed; persist();
    } else if (selectedPath === state.activating.previous && await health(url, 3)) {
      // Interrupted before switching; the previous app is still serving safely.
      delete state.activating; persist();
    } else {
      control('stop');
      state.failed = { ...state.activating, recovery: true, error: 'Interrupted activation. Check the current release/database before starting Squirl or publishing a replacement.' };
      delete state.activating; persist(); throw new Error(state.failed.error);
    }
  }
  const backendRepo = path.join(root, 'repos/backend.git'), frontendRepo = path.join(root, 'repos/frontend.git');
  fetchRepo(backendRepo, config.backendUrl);
  const marker = t.git(backendRepo, ['ls-remote', 'origin', `refs/heads/${t.BRANCH}`]).split(/\s/)[0];
  if (!marker) { console.log('No release has been published yet.'); return { status: 'none' }; }
  if (!t.SHA.test(marker)) throw new Error('Invalid remote release reference');
  if (state.active?.commit === marker && !state.failed) { console.log(`Release ${marker.slice(0, 12)} is current.`); return { status: 'current' }; }
  if (state.failed?.commit === marker) { console.log(`Release ${marker.slice(0, 12)} needs attention: ${state.failed.error}`); return { status: 'failed' }; }
  t.git(backendRepo, ['fetch', '--no-tags', 'origin', `+refs/heads/${t.BRANCH}:refs/heads/${t.BRANCH}`]);
  // Fetch once, then use the exact fetched object, even if another publish happens mid-deploy.
  const commit = t.git(backendRepo, ['rev-parse', `refs/heads/${t.BRANCH}`]);
  const release = t.manifest(JSON.parse(t.git(backendRepo, ['show', `${commit}:release.json`])));
  fetchRepo(frontendRepo, config.frontendUrl);
  for (const [repo, sha] of [[backendRepo, release.backend], [frontendRepo, release.frontend]]) {
    t.git(repo, ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/heads/main']);
    t.git(repo, ['merge-base', '--is-ancestor', sha, 'refs/heads/main']);
  }
  const destination = path.join(root, 'releases', `${commit.slice(0, 12)}-${randomUUID()}`);
  const backend = path.join(destination, 'squirl_backend');
  let touched = false, selected = false, beforeVersion, backup;
  const previous = fs.realpathSync(current);
  try {
    console.log(`Preparing release ${commit.slice(0, 12)}.`);
    t.extract(backendRepo, release.backend, backend);
    t.extract(frontendRepo, release.frontend, path.join(destination, 'squirl_frontend'));
    await check(destination);
    if (!state.failed?.recovery && !await health(url, 3)) throw new Error('The current app is not healthy; no deployment switch was attempted.');
    schema(config, backend, env.DB_PATH, env); // Reject a wrong key/journal mode before stopping the app.
    state.activating = { ...release, commit, path: destination, previous };
    persist();
    touched = true; control('stop');
    beforeVersion = schema(config, backend, env.DB_PATH, env);
    backup = path.join(root, 'backups', `${path.basename(destination)}.db`);
    copyDatabase(env.DB_PATH, backup);
    const probe = path.join(destination, 'migration-probe.db');
    copyDatabase(backup, probe);
    try { schema(config, backend, probe, env, true); } finally { fs.rmSync(probe, { force: true }); }
    // Write only release metadata; production credentials remain outside every release.
    t.writeJson(path.join(destination, 'release.json'), { ...release, commit });
    Object.assign(state.activating, { backup, beforeVersion }); persist();
    t.switchCurrent(root, destination); selected = true;
    control('start');
    if (!await health(url, 40)) throw new Error('New release failed its database/session health check.');
    state.active = { ...release, commit, path: destination, backup };
    delete state.activating; delete state.failed; persist();
    trimReleases(root, [destination, previous]);
    console.log(`Deployed ${commit.slice(0, 12)}. Encrypted database backup retained.`);
    return { status: 'deployed', commit, path: destination };
  } catch (error) {
    if (!touched) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
    control('stop');
    let recovery = false;
    try {
      const actual = schema(config, backend, env.DB_PATH, env);
      if (beforeVersion === undefined || actual !== beforeVersion) recovery = true;
      else {
        if (selected) t.switchCurrent(root, previous);
        control('start');
        if (!await health(url, 20)) recovery = true;
      }
    } catch { recovery = true; }
    if (recovery) control('stop');
    state.failed = { ...release, commit, path: destination, backup, recovery, error: recovery
      ? 'Activation failed and safe code rollback was not possible. Database was preserved; inspect logs/backup and publish a compatible fix.'
      : 'Activation failed; previous app restored without reverting database contents.' };
    delete state.activating; persist();
    if (!recovery) fs.rmSync(destination, { recursive: true, force: true });
    throw new Error(`${error.message} ${state.failed.error}`);
  }
}

if (require.main === module) {
  if (process.platform !== 'linux') { console.error('Run the deployment controller on the Linux home server.'); process.exitCode = 1; }
  else {
    const root = t.defaultRoot();
    if (!process.argv.includes('--locked')) {
      const result = require('node:child_process').spawnSync('flock', ['-n', path.join(root, 'deploy.lock'), process.execPath, __filename, '--locked'], { stdio: 'inherit', env: t.gitEnv() });
      process.exitCode = result.status ?? 1;
    } else deploy(t.readJson(path.join(root, 'config.json'))).then((result) => {
      if (result.status === 'failed') process.exitCode = 1;
    }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
module.exports = { deploy, production };
