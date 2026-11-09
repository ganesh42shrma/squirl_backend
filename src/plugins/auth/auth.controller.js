const { createHash, randomBytes } = require('crypto');
const config = require('../../config');
const { getDb } = require('../../config/db');
const { redis } = require('../../config/redis');
const { nowIso, updateRow } = require('../../core/sql');
const { hashPassword } = require('../../core/password');
const mailer = require('../../core/mailer');
const AppError = require('../../core/AppError');
const logger = require('../../core/logger');
const rateLimit = require('../../core/rateLimit');
const { verifyPassword, verifyDummy } = require('../../core/password');
const { sendSuccess } = require('../../core/response');
const users = require('../users/user.service');
const { toUser } = require('../users/user.model');

// A fresh session id at sign-in (prevents session fixation), then who's signed in.
function signIn(req, user) {
  return new Promise((resolve, reject) =>
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.passwordChangedAt = user.password_changed_at;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    }),
  );
}

async function register(req, res) {
  if (!config.allowRegistration) throw new AppError('New accounts are turned off on this server', 403, 'REGISTRATION_CLOSED');
  await rateLimit.hit(`register:${req.ip}`, { limit: 10, windowSec: 3600 });
  const user = await users.createUser(req.body);
  await signIn(req, user);
  sendSuccess(res, toUser(user), { status: 201, message: 'Account created' });
}

async function login(req, res) {
  const { email, password } = req.body;
  // Per email+IP (guessing one account) and per IP (spraying many).
  await rateLimit.hit(`login:${req.ip}:${email}`, { limit: 10, windowSec: 15 * 60 });
  await rateLimit.hit(`login-ip:${req.ip}`, { limit: 50, windowSec: 15 * 60 });

  const user = users.findByEmail(email);
  const valid = user ? await verifyPassword(password, user.password_hash) : await verifyDummy(password);
  if (!valid) {
    logger.warn('Sign-in failed', { requestId: req.id });
    // Same answer whether the email exists or not.
    throw new AppError('Email or password is incorrect', 401, 'INVALID_CREDENTIALS');
  }

  await rateLimit.reset(`login:${req.ip}:${email}`);
  await signIn(req, user);
  logger.info('Signed in', { userId: user.id });
  sendSuccess(res, toUser(user), { message: 'Signed in' });
}

// --- Password reset -------------------------------------------------------------------------

const RESET_TTL_SEC = 30 * 60;
const resetKey = (token) => `squirl:reset:${createHash('sha256').update(token).digest('hex')}`;

/**
 * Starts a reset: a random one-time token, stored only as a hash in Redis for 30 minutes, sent as
 * a link. The answer is identical whether or not the email has an account.
 */
async function forgotPassword(req, res) {
  const { email } = req.body;
  await rateLimit.hit(`forgot:${req.ip}`, { limit: 5, windowSec: 15 * 60 });
  await rateLimit.hit(`forgot:${email}`, { limit: 3, windowSec: 60 * 60 });

  const user = users.findByEmail(email);
  if (user) {
    const token = randomBytes(32).toString('hex');
    await redis.set(resetKey(token), user.id, { EX: RESET_TTL_SEC });
    await mailer.send({
      to: user.email,
      subject: 'Reset your Squirl password',
      text: `Someone asked to reset the password for this account. If it was you, open this link within 30 minutes:\n\n${config.appUrl}/reset-password?token=${token}\n\nIf it wasn't you, ignore this email; your password hasn't changed.`,
    });
    logger.info('Password reset requested', { userId: user.id });
  }
  sendSuccess(res, null, { message: 'If that email has an account, a reset link is on its way' });
}

/** Finishes a reset: one use only; every existing session is signed out, then this one signs in. */
async function resetPassword(req, res) {
  const { token, password } = req.body;
  await rateLimit.hit(`reset:${req.ip}`, { limit: 10, windowSec: 15 * 60 });

  // GETDEL: the token works once, even if two requests race.
  const userId = await redis.getDel(resetKey(token));
  if (!userId) throw new AppError('This reset link is invalid or has expired. Ask for a new one', 400, 'INVALID_RESET_TOKEN');

  const db = getDb();
  const now = nowIso();
  updateRow(db, 'users', userId, { password_hash: await hashPassword(password), password_changed_at: now, updated_at: now });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new AppError('This reset link is invalid or has expired. Ask for a new one', 400, 'INVALID_RESET_TOKEN');

  await signIn(req, user);
  logger.info('Password reset', { userId });
  sendSuccess(res, toUser(user), { message: 'Password updated' });
}

function logout(req, res) {
  req.session.destroy(() => {
    res.clearCookie('squirl.sid');
    sendSuccess(res, null, { message: 'Signed out' });
  });
}

// Who's signed in, for the frontend's first request. 401 when nobody is.
function me(req, res) {
  sendSuccess(res, req.user);
}

module.exports = { register, login, logout, me, forgotPassword, resetPassword };
