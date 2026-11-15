const { getDb } = require('../../config/db');
const { redis } = require('../../config/redis');
const logger = require('../../core/logger');
const { readSettings } = require('../tasks/settings');
const { remindersFor } = require('./reminders');
const service = require('./notification.service');
const payments = require('./payment-prompts');

let timer = null;
let running = null;
let nudged = false;

async function runOnce(now = new Date()) {
  if (!service.ready()) return;
  const db = getDb();
  const rows = db.prepare(`SELECT p.*, u.password_changed_at AS current_password_changed_at
    FROM push_subscriptions p JOIN users u ON u.id = p.user_id`).all();
  db.prepare('DELETE FROM push_deliveries WHERE created_at < ?').run(new Date(now.getTime() - 35 * 86400_000).toISOString());
  for (const row of rows) {
    try {
      // Logging out, an expired session, and a password change revoke delivery as well as API access.
      const session = JSON.parse(await redis.get(`squirl:sess:${row.session_id}`) || 'null');
      if (row.password_changed_at !== row.current_password_changed_at || session?.userId !== row.user_id
        || session?.passwordChangedAt !== row.current_password_changed_at) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
        continue;
      }
      const messages = await remindersFor(db, row.user_id, JSON.parse(row.preferences), readSettings(db, row.user_id), now);
      if (JSON.parse(row.preferences).smsPayments !== false) messages.push(...payments.pending(db, row, now));
      for (const { key, ...message } of messages) {
        // A user can disable this device while a push request is in flight.
        if (!db.prepare('SELECT 1 FROM push_subscriptions WHERE id = ?').get(row.id)) break;
        const receipt = db.prepare('SELECT * FROM push_deliveries WHERE subscription_id = ? AND reminder_key = ?').get(row.id, key);
        if (receipt?.sent_at || receipt?.retry_at > now.getTime()) continue;
        try {
          await service.send(row, message);
          db.prepare(`INSERT INTO push_deliveries (subscription_id, reminder_key, sent_at, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(subscription_id, reminder_key) DO UPDATE SET sent_at = excluded.sent_at`).run(row.id, key, now.toISOString(), now.toISOString());
        } catch (err) {
          if ([404, 410].includes(err.statusCode)) {
            db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
            break;
          }
          if (!db.prepare('SELECT 1 FROM push_subscriptions WHERE id = ?').get(row.id)) break;
          const attempts = (receipt?.attempts || 0) + 1;
          const retryAt = now.getTime() + Math.min(3600_000, 60_000 * 2 ** Math.min(attempts, 6));
          db.prepare(`INSERT INTO push_deliveries (subscription_id, reminder_key, attempts, retry_at, created_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(subscription_id, reminder_key) DO UPDATE SET attempts = excluded.attempts, retry_at = excluded.retry_at`)
            .run(row.id, key, attempts, retryAt, now.toISOString());
          logger.warn('Notification delivery will retry', { status: err.statusCode || 'network' });
        }
      }
    } catch (err) {
      logger.warn('Notification scan could not finish for a device', { error: err.code || err.name });
    }
  }
}

function tick() {
  if (!running) running = runOnce().catch(() => logger.warn('Notification scan will retry')).finally(() => {
    running = null;
    if (nudged && timer) { nudged = false; tick(); }
  });
}
function nudge() { if (timer) { if (running) nudged = true; else tick(); } }
function startNotificationWorker() {
  if (timer || !service.ready()) return;
  timer = setInterval(tick, 60_000);
  timer.unref();
  tick();
}
async function stopNotificationWorker() {
  clearInterval(timer); timer = null; nudged = false;
  await running;
}
module.exports = { runOnce, nudge, startNotificationWorker, stopNotificationWorker };
