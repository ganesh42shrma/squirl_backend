// Background upkeep for photo attachments: the orphan sweep and the S3 copy pass. Both are optional and
// non-fatal; with media not configured this does nothing.
const logger = require('../../core/logger');
const service = require('./media.service');
const replica = require('./media.replica');

const SIX_HOURS = 6 * 60 * 60 * 1000;
let timer = null;
let boot = null;

function tick() {
  try {
    service.purgeUnreferenced();
  } catch (err) {
    logger.warn('Photo sweep failed; will retry', { error: err.code || err.name });
  }
  replica.pass();
}

function startMediaWorker() {
  if (timer) return;
  timer = setInterval(tick, SIX_HOURS);
  timer.unref();
  // Once at boot, after migrations, off the startup path so it can never delay or break /api/health.
  boot = setImmediate(tick);
  boot.unref();
}

async function stopMediaWorker() {
  clearInterval(timer); timer = null;
  clearImmediate(boot); boot = null;
  await replica.idle();
}

module.exports = { startMediaWorker, stopMediaWorker, tick };
