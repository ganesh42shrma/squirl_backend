// Decides, once, whether photo attachments are switched on, and builds the store (and the optional S3 copy).
//
// The feature is on only when MEDIA_DIR and a valid MEDIA_KEY exist. Anything wrong leaves it OFF with one
// log line; it never stops the server from starting (the auto-deploy health check must keep passing), and
// the key itself is never logged.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../../config');
const logger = require('../../core/logger');
const { parseKey } = require('./media.crypto');
const { createLocalStore } = require('./media.store');
const { createS3Client, isLoopback } = require('./media.s3');

const OFF = Object.freeze({ configured: false, store: null, s3: null });

// The real path of the closest folder that exists, so a symlink can't hide that a folder is inside another.
function realish(target) {
  let current = path.resolve(target);
  const tail = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  let real = current;
  try { real = fs.realpathSync(current); } catch { /* keep as is */ }
  return path.join(real, ...tail);
}

const isInside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

function s3Settings(raw) {
  const s3 = raw.s3 || {};
  const present = [s3.endpoint, s3.bucket, s3.accessKeyId, s3.secretAccessKey].filter(Boolean).length;
  if (present === 0) return { client: null };
  if (present < 4) return { client: null, warning: 'S3 replica is off: S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must all be set' };
  let url;
  try { url = new URL(s3.endpoint); } catch { return { client: null, warning: 'S3 replica is off: S3_ENDPOINT is not a valid URL' }; }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    return { client: null, warning: 'S3 replica is off: S3_ENDPOINT must start with https://' };
  }
  if (url.search || url.hash || url.username || url.password) return { client: null, warning: 'S3 replica is off: S3_ENDPOINT must be a plain address' };
  return { client: createS3Client({ ...s3, region: s3.region || 'auto', pathStyle: s3.pathStyle !== false }) };
}

/** Pure-ish: turns raw settings into a runtime. `dbPath` is where the database file lives. */
function build(raw, dbPath, log = logger) {
  const anySet = Boolean(raw.dir || raw.key);
  if (!raw.dir || !raw.key) {
    if (anySet) log.warn('Photo attachments are off: set both MEDIA_DIR and MEDIA_KEY to turn them on');
    else log.info('Photo attachments are off (MEDIA_DIR and MEDIA_KEY are not set)');
    return OFF;
  }
  const key = parseKey(raw.key);
  if (!key) {
    log.warn('Photo attachments are off: MEDIA_KEY must be 32 random bytes, as base64 (openssl rand -base64 32) or 64 hex characters');
    return OFF;
  }
  if (!path.isAbsolute(raw.dir)) {
    log.warn('Photo attachments are off: MEDIA_DIR must be an absolute path');
    return OFF;
  }
  // The database drive must not hold the images, so a folder inside the database's own folder is refused.
  if (dbPath && isInside(realish(raw.dir), realish(path.dirname(dbPath)))) {
    log.warn('Photo attachments are off: MEDIA_DIR is inside the database folder. Use a folder on the computer’s internal disk');
    return OFF;
  }
  try {
    fs.mkdirSync(raw.dir, { recursive: true, mode: 0o700 });
    fs.accessSync(raw.dir, fs.constants.R_OK | fs.constants.W_OK);
  } catch (err) {
    log.warn(`Photo attachments are off: MEDIA_DIR cannot be used (${err.code || 'error'})`);
    return OFF;
  }
  const { client, warning } = s3Settings(raw);
  if (warning) log.warn(warning);
  return Object.freeze({
    configured: true,
    store: createLocalStore({ dir: raw.dir, key }),
    s3: client,
    maxBytes: raw.maxBytes,
    userQuotaBytes: raw.userQuotaBytes,
    maxPerOwner: raw.maxPerOwner,
  });
}

let current = null;

/** The settings in force; built on first use, then reused. */
function get() {
  if (!current) current = build(config.media || {}, config.db?.path);
  return current;
}

// Tests build their own (temp folder, fake S3) and put it in place.
function use(runtime) { current = runtime; }
function reset() { current = null; }

module.exports = { get, build, use, reset };
