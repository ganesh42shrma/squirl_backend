# Private release deployment

Test on the Mac, commit both repositories, then run one command to publish a matched release.
A user systemd timer on the Linux laptop polls GitHub and deploys it. Source code passes through
GitHub; the production database, DB key, `.env`, and push keys stay at home. No public webhook,
incoming SSH connection, cloud build service, or extra application dependency is required.

## What happens

`npm run release:publish` requires clean `main` branches in both repos. It checks committed snapshots
in a temporary directory using the installed Mac dependencies: builds the frontend and runs every
`test:*` script in both packages. It rechecks that the source did not change, pushes both pinned
commits to their `main` branches, then publishes a manifest on the backend's **squirl-deploy** branch.
That branch contains only `release.json`; you never need to check it out. A concurrent publish is
rejected using a Git reference lease rather than overwriting another release.

The Linux controller fetches that manifest, installs locked dependencies afresh, builds, and runs
the same checks in a new release folder while the existing app continues serving. It then:

1. Stops `squirl.service` briefly and checks the mounted encrypted database.
2. Retains an encrypted file backup under its private deployment folder.
3. Tests the new migrations against an encrypted copy, without starting app workers on that copy.
4. Atomically selects the prepared backend/frontend pair and starts Squirl using its existing `.env`.
5. Requires `/api/health` to report both database and Redis connected.

Failed preparation leaves the running release untouched. A failed activation rolls back code only
when the live schema version is unchanged; data accepted after startup is retained. If the schema
changed, the controller stops the failing app and preserves the database and backup. It never
silently restores an old database over new transactions. Publish a compatible fix or inspect the
backup and schema before recovery. A failed activation is not retried every minute; publishing
again produces a new release marker and permits another attempt.

## First: commit and push the prepared setup from the Mac

Review `git status` / `git diff` in each repo, then commit the intended source changes. Example:

```bash
cd /Users/ganeshsharma/Desktop/me/squirl/squirl_frontend
git add .
git commit -m "Add payment replies and PWA update handling"
git push origin main

cd /Users/ganeshsharma/Desktop/me/squirl/squirl_backend
git add .
git commit -m "Add isolated local development and private release deployment"
git push origin main
```

The demo `.local/` folder is ignored and is not part of a release. Publishing refuses tracked
`.env` files (except `.env.example`), database/key-store files, dependency/build directories, and
symbolic links/submodules in source. It never commits files for you.

## One-time installation at home on Linux

Keep the USB database mounted and the existing Squirl/Redis services healthy. Node 22.12+, npm,
Git, tar, `flock`, and `systemd-analyze` are needed. Use the same Node version as `squirl.service`; your current
`/home/ganesh-sharma/.nvm/versions/node/v22.19.0/bin/node` satisfies this requirement.

```bash
cd /home/ganesh-sharma/Desktop/development/alwaysOn/squirl_frontend
git pull --ff-only origin main

cd /home/ganesh-sharma/Desktop/development/alwaysOn/squirl_backend
git pull --ff-only origin main
command -v node npm git tar flock systemd-analyze
systemctl --user status squirl.service --no-pager
npm run deploy:install
systemctl --user status squirl-deploy.timer --no-pager
```

Run this as **ganesh-sharma**, without sudo. The installer requires the production `.env` to have
`NODE_ENV=production`, an absolute existing `DB_PATH`, its original `DB_KEY`, `DB_MUST_EXIST=true`,
`SERVE_FRONTEND=true`, and a loopback `HOST`. Preserve all existing production values; no new DB
or push key is generated. `loginctl enable-linger` was already configured for this user; retain it
so the user timer and app can run after logout and reboot.

The installer checks noninteractive Git access with the SSH agent disabled. If that succeeds,
no extra credential setup is needed. If it fails, configure dedicated read-only deploy keys below.
It validates the generated deployment units with `systemd-analyze`, checks that the app and
deployment units load, and reports success only after the timer is active.

It installs under `~/.local/share/squirl-deploy/` and adds a managed
`~/.config/systemd/user/squirl.service.d/release.conf`. Your original checkouts, service unit,
production `.env`, database path, Redis service, and Tailscale Serve configuration remain in place.
The first `current` symlink points at your existing backend/frontend pair. Later it points at an
isolated release. After activation, manually pulling the original checkouts does not change the
running release; use the release command for application updates.

### Repair an older install reporting "unit to trigger not loaded"

The initial installer incorrectly quoted `WorkingDirectory` in both the deployment service and
the app override. systemd treats those quotes as part of the path and rejects the units. On Linux,
remove only those surrounding quotes from the two generated files, validate, and start the timer:

```bash
sed -i -E 's|^WorkingDirectory="(.*)"$|WorkingDirectory=\1|' \
  ~/.config/systemd/user/squirl-deploy.service \
  ~/.config/systemd/user/squirl.service.d/release.conf

systemd-analyze --user verify \
  ~/.config/systemd/user/squirl-deploy.service \
  ~/.config/systemd/user/squirl-deploy.timer
systemctl --user daemon-reload
systemctl --user reset-failed squirl-deploy.service squirl-deploy.timer
systemctl --user enable --now squirl-deploy.timer
systemctl --user status squirl-deploy.timer --no-pager -l
```

The expected timer status is **active (waiting)**, or **active (running)** during a poll. This repair
does not restart the app or change the database. Once the fixed installer is pushed and pulled,
rerun `npm run deploy:install` so future installations retain the correction and validation.

## If Git requires an interactive login

The timer cannot use a password prompt or your Mac's SSH agent. GitHub supports a separate
[read-only deploy key for each repository](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys).
On Linux, generate two new dedicated keys (choose fresh filenames; preserve existing SSH keys):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/squirl_backend_deploy -C squirl-backend-deploy -N ''
ssh-keygen -t ed25519 -f ~/.ssh/squirl_frontend_deploy -C squirl-frontend-deploy -N ''
```

Add each **.pub** key in that GitHub repository's **Settings → Deploy keys**. Leave **Allow write
access** unchecked. Keep private key files on Linux. Add these entries to the existing
`~/.ssh/config`, preserving its other entries:

```sshconfig
Host squirl-deploy-backend
    HostName github.com
    User git
    IdentityFile ~/.ssh/squirl_backend_deploy
    IdentitiesOnly yes
    BatchMode yes

Host squirl-deploy-frontend
    HostName github.com
    User git
    IdentityFile ~/.ssh/squirl_frontend_deploy
    IdentitiesOnly yes
    BatchMode yes
```

Verify normal GitHub host-key trust, then rerun the installer with these deployment-only URLs:

```bash
SQUIRL_DEPLOY_BACKEND_URL=git@squirl-deploy-backend:ganesh42shrma/squirl_backend.git \
SQUIRL_DEPLOY_FRONTEND_URL=git@squirl-deploy-frontend:ganesh42shrma/squirl_frontend.git \
npm run deploy:install
```

This does not replace the origin URLs in your original working repositories. Never paste private
keys, production environment contents, or tokens into GitHub issues or chat.

## Every future update from the Mac

Use `npm run dev:local` to preview changes and commit them in each affected repository. Then:

```bash
cd /Users/ganeshsharma/Desktop/me/squirl/squirl_backend
npm run release:plan
npm run release:publish
```

The plan is read-only and reports uncommitted changes. Publishing tests first and pushes the exact
committed pair; it does not include uncommitted edits. Ordinary work-in-progress pushes do not
deploy. The Linux timer checks about a minute after each finished poll; builds/tests take additional
time. If home internet is down it can fetch on a later poll, without your Mac staying online.

The PWA may still have an update waiting on the phone. Use **Settings → Notifications → Update app**
after deployment. Android helper APK updates and Python parser deployments remain separate.

## Status, pause, and recovery

On Linux:

```bash
systemctl --user start squirl-deploy.service
journalctl --user -u squirl-deploy.service -n 100 --no-pager
systemctl --user status squirl.service --no-pager
```

`~/.local/share/squirl-deploy/state.json` records the active/failing manifest, source commits, release
path, and backup path, with no DB key. Successful deploys retain the latest three release folders
plus the currently selected/previous folders. Encrypted DB backups are retained; monitor free disk
space and manage older backups deliberately. The backup method requires Squirl's existing DELETE
journal mode and a stopped backend; other journal modes fail closed.

To pause future polls, run `systemctl --user disable --now squirl-deploy.timer`. Let any already-running
deployment finish before manual maintenance. Resume with `systemctl --user enable --now squirl-deploy.timer`.
If interrupted after switching, a healthy selected release is adopted on the next poll. Other
interrupted activations fail closed for inspection. A new published marker permits a new attempt.
If a schema-changing release fails, use the recorded encrypted backup and logs to decide recovery;
restoring it later can discard newer records, so it is never automated.

The installed controller is copied from `deployment/` at installation. To update deployment tooling
itself, pull the backend checkout at home and rerun `npm run deploy:install`. Do not manually edit
`current` or release directories while a deploy is running.

## Verification

`npm run test:deploy` exercises real disposable local Git remotes, publication races, staged checks,
an encrypted synthetic database, migration-copy failures, healthy/failed activation, data-preserving
code rollback, schema-change recovery, missing-drive protection, literal systemd paths (including
spaces), and rejection of invalid units or an inactive timer during installation.
No GitHub account, real database, or installed Linux service is touched by those tests. Linux/systemd
activation and Git credentials still need their one-time live check on the home laptop.
