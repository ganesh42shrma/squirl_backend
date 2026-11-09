// Request guards: CSRF check for writes, and "must be signed in" for the API.
const AppError = require('./AppError');
const { getDb } = require('../config/db');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Writes must carry `X-Requested-With: squirl`. A page on another site can't add custom headers
 * to a cross-origin request without a CORS preflight, which CORS (locked to our origin) refuses.
 * Together with SameSite=Strict cookies this stops cross-site request forgery.
 */
function csrfGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method) || req.get('X-Requested-With') === 'squirl') return next();
  next(new AppError('Missing request header', 403, 'CSRF_CHECK_FAILED'));
}

/**
 * Loads the signed-in user onto req.user, or answers 401. A session made before the password
 * last changed is no longer valid: changing your password signs out every other session.
 */
function requireAuth(req, res, next) {
  const { userId, passwordChangedAt } = req.session || {};
  if (!userId) return next(new AppError('Please sign in', 401, 'AUTH_REQUIRED'));

  const user = getDb().prepare('SELECT id, email, name, password_changed_at FROM users WHERE id = ?').get(userId);
  if (!user || user.password_changed_at !== passwordChangedAt) {
    return req.session.destroy(() => next(new AppError('Your session has ended. Please sign in again', 401, 'AUTH_REQUIRED')));
  }
  req.user = { id: user.id, email: user.email, name: user.name };
  next();
}

module.exports = { csrfGuard, requireAuth };
