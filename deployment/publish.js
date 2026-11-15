const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const t = require('./release-tools');

async function publish({ backend = path.resolve(__dirname, '..'), frontend = path.resolve(backend, '../squirl_frontend'), dryRun = false, check = t.checks } = {}) {
  const repos = [backend, frontend];
  const heads = repos.map((repo) => t.git(repo, ['rev-parse', 'HEAD']));
  const dirty = repos.filter((repo) => t.git(repo, ['status', '--porcelain']));
  for (const repo of repos) if (t.git(repo, ['branch', '--show-current']) !== 'main') throw new Error('Publish from the main branch in both repositories.');
  const release = { schema: 1, backend: heads[0], frontend: heads[1], createdAt: new Date().toISOString() };
  t.manifest(release);
  if (dryRun) {
    console.log(JSON.stringify({ ...release, dirty: dirty.map((repo) => path.basename(repo)), action: 'Test committed snapshots, push both main branches, then publish the release marker.' }, null, 2));
    return release;
  }
  if (dirty.length) throw new Error(`Commit or stash changes before publishing: ${dirty.map((repo) => path.basename(repo)).join(', ')}`);
  // A concurrent publisher must never be overwritten by our release marker.
  const remote = t.git(backend, ['ls-remote', 'origin', `refs/heads/${t.BRANCH}`]).split(/\s/)[0];
  if (remote) t.git(backend, ['fetch', '--no-tags', 'origin', `refs/heads/${t.BRANCH}`]);
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'squirl-release-check-'));
  try {
    repos.forEach((repo, index) => {
      const destination = path.join(snapshot, index ? 'squirl_frontend' : 'squirl_backend');
      t.extract(repo, heads[index], destination);
      const modules = path.join(repo, 'node_modules');
      if (!fs.existsSync(modules)) throw new Error(`Install dependencies in ${path.basename(repo)} before publishing.`);
      fs.symlinkSync(modules, path.join(destination, 'node_modules'), 'dir');
    });
    await check(snapshot, { install: false });
    repos.forEach((repo, index) => {
      if (t.git(repo, ['rev-parse', 'HEAD']) !== heads[index] || t.git(repo, ['status', '--porcelain'])) throw new Error('Source changed during release checks; commit and publish again.');
    });
    t.git(frontend, ['push', 'origin', `${heads[1]}:refs/heads/main`]);
    t.git(backend, ['push', 'origin', `${heads[0]}:refs/heads/main`]);
    const blob = t.git(backend, ['hash-object', '-w', '--stdin'], { input: JSON.stringify(release, null, 2) + '\n' });
    const tree = t.git(backend, ['mktree'], { input: `100644 blob ${blob}\trelease.json\n` });
    const commit = t.git(backend, ['commit-tree', tree, ...(remote ? ['-p', remote] : []), '-m', `Release ${heads[0].slice(0, 12)} / ${heads[1].slice(0, 12)}`]);
    t.git(backend, ['push', `--force-with-lease=refs/heads/${t.BRANCH}:${remote || ''}`, 'origin', `${commit}:refs/heads/${t.BRANCH}`]);
    console.log(`Published release ${commit}. The Linux deploy timer can now pick it up.`);
    return { ...release, commit };
  } finally { fs.rmSync(snapshot, { recursive: true, force: true }); }
}
if (require.main === module) publish({ dryRun: process.argv.includes('--dry-run') }).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { publish };
