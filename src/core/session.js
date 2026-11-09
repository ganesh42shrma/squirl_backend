// Server-side sessions in Redis. The browser only holds an opaque, httpOnly session id;
// who you are lives in Redis and can be revoked there. No tokens to steal from JS.
const { createHmac } = require('crypto');
const session = require('express-session');
const { RedisStore } = require('connect-redis');
const config = require('../config');
const { redis } = require('../config/redis');
const { getDbKey } = require('../config/dbKey');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Derived from the database key, so there's no second secret to store (and none on the drive).
const secret = config.session.secret || createHmac('sha256', getDbKey()).update('squirl-session-v1').digest('hex');

const sessionMiddleware = session({
  name: 'squirl.sid',
  store: new RedisStore({ client: redis, prefix: 'squirl:sess:' }),
  secret,
  resave: false,
  saveUninitialized: false, // no session (and no cookie) until someone signs in
  rolling: true, // each request extends the week
  cookie: {
    httpOnly: true, // not readable from JavaScript
    sameSite: 'strict', // never sent on requests from other sites
    secure: config.session.cookieSecure,
    maxAge: WEEK_MS,
  },
});

module.exports = { sessionMiddleware };
