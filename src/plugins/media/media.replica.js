// Keeps the optional encrypted copy in S3-compatible storage up to date. It only ever moves the encrypted
// bytes exactly as they sit on disk, so the bucket holds nothing readable.
//
// Nothing here may fail a user's request: uploads happen in the background, one at a time, and a failure
// just records an attempt and tries again later with a growing pause.
const { getDb } = require('../../config/db');
const logger = require('../../core/logger');
const { nowIso } = require('../../core/sql');
const runtime = require('./media.runtime');

const MAX_ATTEMPTS = 8;
const BATCH = 25;
const DEBOUNCE_MS = 2000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

const objectKey = (id) => `media/${id}.sqm`;

// 1 min, 2, 4 ... capped at 6 hours, counted from the last attempt (updated_at).
const waitMs = (attempts) => (attempts <= 0 ? 0 : Math.min(60_000 * 2 ** (attempts - 1), MAX_BACKOFF_MS));
const due = (row, now) => Date.parse(row.updated_at) + waitMs(row.replica_attempts) <= now;

const reason = (err) => (err && err.message ? String(err.message).slice(0, 200) : 'error');

async function removePending(db, s3, now) {
  const rows = db.prepare("SELECT id, replica_attempts, updated_at FROM media WHERE replica_state = 'pending_delete' ORDER BY updated_at LIMIT 200").all()
    .filter((r) => due(r, now)).slice(0, BATCH);
  for (const row of rows) {
    try {
      await s3.remove(objectKey(row.id));
      db.prepare("UPDATE media SET replica_state = 'none', replica_attempts = 0, updated_at = ? WHERE id = ? AND replica_state = 'pending_delete'").run(nowIso(), row.id);
    } catch (err) {
      db.prepare("UPDATE media SET replica_attempts = replica_attempts + 1, updated_at = ? WHERE id = ? AND replica_state = 'pending_delete'").run(nowIso(), row.id);
      logger.warn('Could not delete a photo copy from S3; will retry', { error: reason(err) });
    }
  }
}

async function uploadPending(db, rt, now) {
  // Pictures saved before the replica was switched on get copied too.
  db.prepare("UPDATE media SET replica_state = 'pending', updated_at = ? WHERE replica_state = 'none' AND deleted_at IS NULL").run(nowIso());
  const rows = db.prepare(`SELECT id, replica_attempts, updated_at FROM media
    WHERE deleted_at IS NULL AND replica_state IN ('pending', 'failed') AND replica_attempts < ? ORDER BY created_at LIMIT 200`).all(MAX_ATTEMPTS)
    .filter((r) => due(r, now)).slice(0, BATCH);
  for (const row of rows) {
    const fail = (err) => {
      db.prepare("UPDATE media SET replica_state = 'failed', replica_attempts = replica_attempts + 1, updated_at = ? WHERE id = ? AND replica_state IN ('pending', 'failed')").run(nowIso(), row.id);
      logger.warn('Could not copy a photo to S3; will retry', { error: reason(err) });
    };
    let bytes;
    try { bytes = rt.store.readRaw(row.id); } catch (err) { fail(err); continue; }
    try {
      await rt.s3.put(objectKey(row.id), bytes);
    } catch (err) { fail(err); continue; }
    // If the picture was removed while uploading, its state is now pending_delete and this changes nothing:
    // the delete pass removes the copy we just made.
    db.prepare("UPDATE media SET replica_state = 'done', replica_attempts = 0, updated_at = ? WHERE id = ? AND replica_state IN ('pending', 'failed')").run(nowIso(), row.id);
  }
}

let running = null;
let again = false;
let timer = null;

/** One pass: deletes first, then uploads. Returns quietly when S3 isn't configured. */
async function runPass({ now = Date.now() } = {}) {
  const rt = runtime.get();
  if (!rt.configured || !rt.s3) return;
  const db = getDb();
  await removePending(db, rt.s3, now);
  await uploadPending(db, rt, now);
  await removePending(db, rt.s3, now); // a removal that happened mid-upload
}

// Single flight: a request for a pass while one runs makes it run once more afterwards.
function pass(options) {
  if (running) { again = true; return running; }
  running = runPass(options)
    .catch((err) => logger.warn('Photo copy pass failed; will retry', { error: reason(err) }))
    .finally(() => {
      running = null;
      if (again) { again = false; nudge(); }
    });
  return running;
}

/** Asks for a pass soon (debounced) without waiting for it. Safe to call from a request. */
function nudge() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; pass(); }, DEBOUNCE_MS);
  timer.unref();
}

/** Deletes remote copies for rows that no longer exist (account deletion). Best effort, in the background. */
function removeRemote(ids) {
  const rt = runtime.get();
  if (!rt.s3 || !ids.length) return Promise.resolve();
  const task = (async () => {
    for (const id of ids) {
      try { await rt.s3.remove(objectKey(id)); } catch (err) { logger.warn('Could not delete a photo copy from S3', { error: reason(err) }); }
    }
  })();
  inflight.add(task);
  task.finally(() => inflight.delete(task));
  return task;
}
const inflight = new Set();

// Waits for background work, for shutdown and tests.
async function idle() {
  clearTimeout(timer); timer = null;
  while (running || inflight.size) await Promise.allSettled([running, ...inflight]);
  clearTimeout(timer); timer = null; // a rerun requested while finishing
}

module.exports = { objectKey, runPass, pass, nudge, removeRemote, idle, MAX_ATTEMPTS, waitMs };
