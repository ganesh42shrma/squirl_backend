const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const t = require('./release-tools');
const { production } = require('./deploy');

function unitPath(value, quoted = true) {
  if (/[\r\n\0%$]/.test(value)) throw new Error('Deployment paths cannot contain newline, %, or $ characters.');
  if (!quoted) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function units(config) {
  const cwd = path.join(config.root, 'current/squirl_backend');
  // WorkingDirectory parses a literal path; ExecStart and Environment parse quoted arguments.
  return {
    app: `[Service]\nWorkingDirectory=${unitPath(cwd, false)}\nExecStart=\nExecStart=${unitPath(config.node)} src/server.js\nEnvironment=${unitPath(`DOTENV_CONFIG_PATH=${config.envFile}`)}\n`,
    service: `[Unit]\nDescription=Deploy published Squirl releases\n\n[Service]\nType=oneshot\nWorkingDirectory=${unitPath(config.root, false)}\nExecStart=${unitPath(config.node)} ${unitPath(path.join(config.root, 'runtime/deploy.js'))}\nEnvironment=${unitPath(`PATH=${path.dirname(config.node)}:/usr/local/bin:/usr/bin:/bin`)}\nUMask=0077\nTimeoutStartSec=30min\n`,
    timer: '[Unit]\nDescription=Check for a published Squirl release\n\n[Timer]\nOnActiveSec=30s\nOnUnitInactiveSec=60s\nAccuracySec=5s\nUnit=squirl-deploy.service\n\n[Install]\nWantedBy=timers.target\n',
  };
}
async function install({ source = path.resolve(__dirname, '..'), root = t.defaultRoot(), node = process.execPath, home = os.homedir(), execute = t.run, health = t.healthy } = {}) {
  const frontend = path.resolve(source, '../squirl_frontend');
  const config = { root, node, envFile: path.join(source, '.env'),
    backendUrl: process.env.SQUIRL_DEPLOY_BACKEND_URL || t.git(source, ['remote', 'get-url', 'origin']),
    frontendUrl: process.env.SQUIRL_DEPLOY_FRONTEND_URL || t.git(frontend, ['remote', 'get-url', 'origin']) };
  if (root.startsWith(path.dirname(source) + path.sep)) throw new Error('Keep deployment files outside the source checkout.');
  const { url } = production(config);
  if (execute('systemctl', ['--user', 'show', 'squirl.service', '--property=ActiveState', '--value']) !== 'active') throw new Error('Start and verify squirl.service before installing auto-deploy.');
  if (!await health(url, 3)) throw new Error('The current Squirl app/database/Redis must be healthy first.');
  // Boot-time deployment must not depend on a terminal prompt or an unlocked SSH agent.
  for (const url of [config.backendUrl, config.frontendUrl]) execute('git', ['ls-remote', url, 'refs/heads/main']);
  const userUnits = path.join(home, '.config/systemd/user');
  t.mkdir(userUnits);
  const timerFile = path.join(userUnits, 'squirl-deploy.timer');
  if (fs.existsSync(timerFile)) execute('systemctl', ['--user', 'stop', 'squirl-deploy.timer']);
  for (const name of ['runtime', 'repos', 'releases', 'backups']) t.mkdir(path.join(root, name));
  const current = path.join(root, 'current');
  if (fs.existsSync(current)) {
    if (!fs.lstatSync(current).isSymbolicLink()) throw new Error('Existing deployment current is not a symlink.');
  } else fs.symlinkSync(path.dirname(source), current, 'dir');
  for (const file of ['deploy.js', 'release-tools.js', 'db-tool.js']) fs.copyFileSync(path.join(__dirname, file), path.join(root, 'runtime', file));
  fs.writeFileSync(path.join(root, 'empty.env'), '', { mode: 0o600 });
  t.writeJson(path.join(root, 'config.json'), config);
  const text = units(config);
  const dropin = path.join(userUnits, 'squirl.service.d'); t.mkdir(dropin);
  const dropinFile = path.join(dropin, 'release.conf');
  if (fs.existsSync(dropinFile) && !fs.existsSync(path.join(root, 'original-release.conf'))) fs.copyFileSync(dropinFile, path.join(root, 'original-release.conf'));
  fs.writeFileSync(dropinFile, text.app);
  const serviceFile = path.join(userUnits, 'squirl-deploy.service');
  fs.writeFileSync(serviceFile, text.service);
  fs.writeFileSync(timerFile, text.timer);
  execute('systemd-analyze', ['--user', 'verify', serviceFile, timerFile]);
  execute('systemctl', ['--user', 'daemon-reload']);
  for (const unit of ['squirl.service', 'squirl-deploy.service', 'squirl-deploy.timer']) {
    if (execute('systemctl', ['--user', 'show', unit, '--property=LoadState', '--value']) !== 'loaded') throw new Error(`${unit} did not load. Check journalctl --user -n 80 --no-pager before retrying installation.`);
  }
  execute('systemctl', ['--user', 'enable', '--now', 'squirl-deploy.timer']);
  if (execute('systemctl', ['--user', 'show', 'squirl-deploy.timer', '--property=ActiveState', '--value']) !== 'active') throw new Error('squirl-deploy.timer did not become active. Check systemctl --user status squirl-deploy.timer --no-pager -l.');
  console.log('Auto-deploy installed. The existing app stays running; publish a release from the Mac when ready.');
  console.log('Status: systemctl --user status squirl-deploy.timer\nLogs: journalctl --user -u squirl-deploy.service -n 80 --no-pager');
  return config;
}
if (require.main === module) {
  if (process.platform !== 'linux' || process.getuid?.() === 0) { console.error('Run this once on Linux as your normal Squirl user, without sudo.'); process.exitCode = 1; }
  else {
    const root = t.defaultRoot(); t.mkdir(root);
    if (!process.argv.includes('--locked')) {
      const result = require('node:child_process').spawnSync('flock', ['-n', path.join(root, 'deploy.lock'), process.execPath, __filename, '--locked'], { stdio: 'inherit', env: t.gitEnv() });
      process.exitCode = result.status ?? 1;
    } else install().catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
module.exports = { install, units };
