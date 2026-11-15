# Squirl on Android, served privately from your Linux desktop

The desktop runs the built React app, Express API, Redis sessions, parser, and reminder worker.
The encrypted SQLite database stays on your drive. Tailscale Serve gives your devices a private
HTTPS address. The phone uses an installed PWA; no cloud database or public web hosting is required.

## Prepared in the application

- Manifest, Android icons, a production service worker, and a reconnect screen.
- Public interface files are cached. API responses, records, account details, and uploaded statements are not cached by the service worker. API responses also use `Cache-Control: no-store`.
- `SERVE_FRONTEND=true` serves the frontend build and `/api` from one backend port.
- Profile → This device provides enable/disable, a test notification, category switches, and reminder times.
- Date-only/overdue tasks get a daily reminder; tasks with a due time also get a due reminder. Unfinished habits get a daily check-in reminder. Bills reuse the existing due-soon/missed-payment calculation, which depends on the statements you have imported.
- Task/habit timing follows Tasks settings, including timezone and the configured day boundary. Bills use the calendar day in that timezone.
- The worker checks every minute, persists successful delivery receipts, retries temporary failures with backoff, and removes expired subscriptions. Receipts are kept for 35 days. A crash between push acceptance and saving a receipt can repeat a message; stable notification tags reduce visible duplicates.
- All device preferences and receipts stay in the encrypted SQLite database. Names, amounts, and record IDs are excluded from push payloads.
- Sign-out removes this session's subscriptions. Session expiry and password changes revoke delivery during the next worker scan. Sign in and enable notifications again if needed. Existing sessions last a week of inactivity; Redis must retain its session data across restarts to keep devices signed in.

Offline financial viewing/editing and phone-to-desktop database synchronization are not implemented.
Notifications depend on the desktop and internet being available, browser permission, and Android delivery policies.

## Tonight: 1. Prepare the Linux computer

Install a current Node LTS version (Node 22.12 or newer), npm, Redis, and Tailscale using your
distribution's instructions. Install uv if you want statement importing on this machine.

Keep the three source directories side by side: `squirl_backend`, `squirl_frontend`, `squirl_parser`.
Transfer the current working source, including new uncommitted files; a fresh clone alone will
not contain changes that have not been committed/pushed. Reinstall dependencies on Linux rather
than copying macOS `node_modules` or the parser `.venv`.

The desktop must stay awake. Screen lock is fine; suspend is not. Configure the database drive to
mount at a stable path at boot, with read/write access for the account running Squirl. A drive
mounted only after graphical login will delay the service until it is mounted.

Stop Squirl on the Mac before moving the USB database. Keep a backup of the encrypted database.
Only one machine should open/write that database. Do not share its file over a network filesystem.

Linux cannot read your Mac's Keychain. Transfer the **existing database key** privately using your
password manager, and put it in the desktop backend's ignored `.env` as `DB_KEY`. Do not generate
a replacement key, commit it, paste it into chat, or put it on the database drive. Keep the backend
source and `.env` on the desktop's internal disk, separate from the USB database.

Inside each JS directory run `npm ci`. Inside `squirl_frontend`, run `npm run build`.
Inside `squirl_parser`, run `uv sync --no-dev` if using statement importing.
Ensure Redis runs locally and starts at boot. Retain its on-disk session persistence if you want
sign-ins/subscriptions to survive a Redis restart. Keep Redis and the parser on loopback.

## Tonight: 2. Set up private HTTPS

Sign the desktop and phone into your Tailscale network. On Linux, run:

```sh
sudo tailscale up
sudo tailscale serve --bg http://127.0.0.1:4000
tailscale serve status
```

Follow the HTTPS enablement link if prompted. Keep this as **Serve**, which shares within your
tailnet. Restrict access to the intended users/devices in Tailscale. Use the HTTPS hostname shown
by `serve status` for Squirl. No router port-forwarding is needed.

In `squirl_backend/.env`, preserve existing values and set:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4000
SERVE_FRONTEND=true
TRUST_PROXY_LOOPBACK=true
COOKIE_SECURE=true
APP_URL=https://YOUR-DESKTOP.YOUR-TAILNET.ts.net
CORS_ORIGIN=https://YOUR-DESKTOP.YOUR-TAILNET.ts.net
DB_PATH=/YOUR/STABLE/MOUNT/squirl/squirl.db
DB_MUST_EXIST=true
REDIS_URL=redis://127.0.0.1:6379
ALLOW_REGISTRATION=false
```

Use the actual hostname (no trailing slash), drive path, and existing DB key. `DB_MUST_EXIST=true`
prevents a missing USB database from silently creating a new database on the internal disk.
Remove any `VITE_API_URL` override before building: phone requests should use `/api` on the same
private origin. The backend trusts HTTPS forwarding only from the loopback proxy.

## Tonight: 3. Configure push and start Squirl

In `squirl_backend`:

```sh
chmod 600 .env
npm run push:keys -- mailto:YOUR-EMAIL@example.com
npm start
```

The key command saves VAPID keys straight to `.env`, restricts its permissions, and refuses to
replace existing keys. Keep the keys on this desktop and back them up privately. Do not run the
command again when deploying an update. The contact email is used by the push service; use yours.

On first start, Squirl adds the push-device/receipt tables to the existing database through the
normal migration mechanism. Existing financial records are preserved. All migrations, including
any pending earlier local changes such as the Tasks module, run together at startup.

Check `http://127.0.0.1:4000/api/health` locally for `db: connected` and `sessions: connected`.
Sign in using the **HTTPS Tailscale address**, because production cookies require HTTPS.

Push messages travel encrypted through the browser vendor's push service (normally Google for
Chrome on Android). The desktop makes an outbound HTTPS request; the push service doesn't need
public access to Squirl. Only a generic reminder and a notification tag leave the desktop. Your
financial database is not uploaded. Tailscale must be connected to open Squirl and fetch details;
delivery of an already-sent push uses the phone's ordinary internet connection.

## Tonight: 4. Enable automatic startup

After the manual start works, stop it with Ctrl+C so there is only one backend process.
Copy `deployment/linux/squirl.service.example` to `~/.config/systemd/user/squirl.service`.
Replace the two placeholder paths with the actual backend directory and `command -v node` result.
The working directory matters: dotenv loads the backend's `.env` from there.

If using the parser, copy `squirl-parser.service.example` to the same directory without `.example`
and replace its paths too. The parser is optional for browsing existing data and receiving reminders.

```sh
mkdir -p ~/.config/systemd/user
# Copy/edit the unit files as described above before enabling them.
systemctl --user daemon-reload
systemctl --user enable --now squirl.service
# If the parser unit was installed:
systemctl --user enable --now squirl-parser.service
sudo loginctl enable-linger "$USER"
journalctl --user -u squirl.service -n 50 --no-pager
```

Lingering runs your user services at boot and after logout. Tailscale Serve's `--bg` configuration
also resumes after reboot. Redis must be enabled separately as a system service. Configure a
separate local Ollama service only if you want the AI features; the Mac-specific LLM launch script
and Mac model paths are not portable. Neither Ollama nor the parser is needed for reminder delivery.

## Tonight: 5. Test on Android

1. Connect Tailscale and open the private HTTPS address in Chrome.
2. Sign in. Open Profile → This device. If the worker is still preparing, reload once.
3. Choose Install app / Add to Home screen in Chrome's menu.
4. Enable notifications in Profile, choose reminder categories/times, and press Send test.
5. Close Squirl and send another test from a window signed into that same device/session, or
   create a synthetic task due a few minutes ahead, then close the app and wait for its reminder.
6. Tap the notification; check it opens the right Squirl page.
7. Test using mobile data, not just home Wi-Fi. Reboot the desktop and verify access again.

If notifications are blocked, change Chrome's permission for this site and check Android's
notification settings for Chrome/the installed app. A Send test success means the push service
accepted the message; seeing it on the phone is the delivery check. Android can delay delivery.

## Local validation

From `squirl_frontend`: `npm run build` then `npm run test:pwa`.
From `squirl_backend`: `npm run test:notifications` then `npm run test:private-serving`.
Tests use synthetic in-memory data, mocked push delivery, and mocked Redis. The private-serving
test binds an ephemeral loopback port. They do not open your personal database or send real pushes.

References: [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve),
[Linux installation](https://tailscale.com/docs/install/linux),
[systemd user lingering](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html),
[Web Push](https://web.dev/articles/push-notifications-overview).
