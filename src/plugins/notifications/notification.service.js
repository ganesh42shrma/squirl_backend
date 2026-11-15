const webpush = require('web-push');
const config = require('../../config');
const { getDb } = require('../../config/db');
const { newId, nowIso } = require('../../core/sql');
const AppError = require('../../core/AppError');

const DEFAULT_PREFERENCES = { tasks: true, habits: true, bills: true, smsPayments: true, captures: true, details: true, dailyTime: '09:00', habitTime: '20:00' };
const ready = () => Boolean(config.push.publicKey && config.push.privateKey && config.push.subject);

function deviceStatus(userId, sessionId, endpoint) {
  const db = getDb();
  const row = db.prepare(`SELECT p.preferences FROM push_subscriptions p JOIN users u ON u.id = p.user_id
    WHERE p.user_id = ? AND p.session_id = ? AND p.endpoint = ? AND p.password_changed_at = u.password_changed_at`).get(userId, sessionId, endpoint || '');
  return { ready: ready(), publicKey: config.push.publicKey, enabled: Boolean(row), preferences: { ...DEFAULT_PREFERENCES, ...(row && JSON.parse(row.preferences)) } };
}

function subscribe(userId, sessionId, passwordChangedAt, { subscription, preferences }) {
  if (!ready()) throw AppError.serviceUnavailable('Notifications have not been configured on this server yet', 'PUSH_NOT_CONFIGURED');
  // Validate the curve point too; syntactically valid bytes need not be a valid public key.
  try { require('node:crypto').ECDH.convertKey(Buffer.from(subscription.keys.p256dh, 'base64url'), 'prime256v1'); }
  catch { throw AppError.badRequest('Invalid subscription public key'); }
  const db = getDb();
  const existing = db.prepare('SELECT id, user_id, session_id FROM push_subscriptions WHERE endpoint = ?').get(subscription.endpoint);
  if (existing && existing.user_id !== userId) {
    throw AppError.conflict('This browser subscription belongs to another session. Disable notifications on this device and enable them again.', 'PUSH_SESSION_CHANGED');
  }
  if (!existing && db.prepare('SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId).n >= 10) {
    throw AppError.badRequest('This account already has ten notification devices');
  }
  const now = nowIso();
  db.prepare(`INSERT INTO push_subscriptions (id, user_id, session_id, password_changed_at, endpoint, subscription, preferences, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET
    session_id = excluded.session_id, password_changed_at = excluded.password_changed_at, subscription = excluded.subscription,
    preferences = excluded.preferences, updated_at = excluded.updated_at`).run(
    newId(), userId, sessionId, passwordChangedAt, subscription.endpoint, JSON.stringify(subscription), JSON.stringify(preferences), now, now,
  );
  return deviceStatus(userId, sessionId, subscription.endpoint);
}

function remove(userId, sessionId, endpoint) {
  getDb().prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND session_id = ? AND endpoint = ?').run(userId, sessionId, endpoint);
}

function removeSession(sessionId) {
  getDb().prepare('DELETE FROM push_subscriptions WHERE session_id = ?').run(sessionId);
}

async function send(row, message) {
  if (!ready()) throw AppError.serviceUnavailable('Notifications are not configured', 'PUSH_NOT_CONFIGURED');
  await webpush.sendNotification(JSON.parse(row.subscription), JSON.stringify(message), {
    vapidDetails: { subject: config.push.subject, publicKey: config.push.publicKey, privateKey: config.push.privateKey },
    TTL: 3600, timeout: 10_000, urgency: 'normal',
  });
}

async function test(userId, sessionId, endpoint, kind = 'test') {
  const row = getDb().prepare(`SELECT p.* FROM push_subscriptions p JOIN users u ON u.id = p.user_id
    WHERE p.user_id = ? AND p.session_id = ? AND p.endpoint = ? AND p.password_changed_at = u.password_changed_at`).get(userId, sessionId, endpoint);
  if (!row) throw AppError.notFound('Enable notifications on this device first');
  let message = { kind: 'test', tag: 'squirl-test', ...(JSON.parse(row.preferences).details !== false && { detail: {} }) };
  if (kind === 'sms_payment') {
    const prompt = require('./payment-prompts').pending(getDb(), row, new Date()).at(-1);
    if (!prompt) throw AppError.notFound('There is no unanswered SMS payment to test. A new SMS payment will create one.');
    const { key, ...notice } = prompt;
    message = notice;
  }
  try { await send(row, message); }
  catch (err) {
    if ([404, 410].includes(err.statusCode)) {
      remove(userId, sessionId, endpoint);
      throw AppError.badRequest('This device subscription expired. Disable notifications and enable them again.', 'PUSH_EXPIRED');
    }
    // Push service errors can contain the endpoint and keys. Do not expose or log their contents.
    throw AppError.serviceUnavailable('The push service could not accept the test. Try again shortly.', 'PUSH_SEND_FAILED');
  }
}

module.exports = { DEFAULT_PREFERENCES, ready, deviceStatus, subscribe, remove, removeSession, send, test };
