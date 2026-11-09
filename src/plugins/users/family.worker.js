const { getDb } = require('../../config/db');
const { nowIso } = require('../../core/sql');
const logger = require('../../core/logger');
const { familyPolicy } = require('./family');

const BATCH = 250;
let timer = null;
let scheduled = null;

// Called inside the profile-save transaction. A newer save restarts the scan with the latest list.
function enqueue(db, userId) {
  const generation = db.prepare('SELECT financial_generation FROM users WHERE id = ?').pluck().get(userId);
  const through = db.prepare('SELECT ifnull(max(rowid), 0) FROM active_transactions WHERE user_id = ?').pluck().get(userId);
  db.prepare(`INSERT INTO family_sync_jobs(user_id, generation, status, through_rowid, updated_at)
    VALUES (?, ?, 'pending', ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET generation = excluded.generation, revision = revision + 1,
      status = 'pending', cursor = 0, through_rowid = excluded.through_rowid,
      processed = 0, changed = 0, retry_at = 0, error = NULL, updated_at = excluded.updated_at`).run(userId, generation, through, nowIso());
}

function statusFor(userId) {
  const row = getDb().prepare('SELECT * FROM family_sync_jobs WHERE user_id = ?').get(userId);
  return row ? { status: row.status, revision: row.revision, processed: row.processed, changed: row.changed, error: row.error }
    : { status: 'idle', revision: 0, processed: 0, changed: 0, error: null };
}

// Each batch and its checkpoint commit together; a restart safely resumes the next batch.
function runBatch(db, userId, limit = BATCH) {
  return db.transaction(() => {
    const job = db.prepare("SELECT * FROM family_sync_jobs WHERE user_id = ? AND status IN ('pending', 'running')").get(userId);
    if (!job) return false;
    const generation = db.prepare('SELECT financial_generation FROM users WHERE id = ?').pluck().get(userId);
    if (generation !== job.generation) {
      db.prepare("UPDATE family_sync_jobs SET status = 'cancelled', updated_at = ? WHERE user_id = ?").run(nowIso(), userId);
      return false;
    }
    const policy = familyPolicy(db, userId);
    if (!policy.familyId) throw new Error('Family category is missing');
    const rows = db.prepare(`SELECT rowid, id, description, category_id, auto_categorized FROM active_transactions
      WHERE user_id = ? AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`).all(userId, job.cursor, job.through_rowid, limit);
    const update = db.prepare('UPDATE transactions SET category_id = ?, auto_categorized = 1, updated_at = ? WHERE user_id = ? AND id = ? AND deleted_at IS NULL');
    let changed = 0;
    for (const row of rows) {
      const category = policy.matches(row.description) ? policy.familyId
        : row.auto_categorized && policy.familyIds.has(row.category_id) ? policy.otherId : null;
      if (category && category !== row.category_id) changed += update.run(category, nowIso(), userId, row.id).changes;
    }
    const cursor = rows.length ? rows[rows.length - 1].rowid : job.through_rowid;
    const done = rows.length < limit || cursor >= job.through_rowid;
    db.prepare(`UPDATE family_sync_jobs SET cursor = ?, processed = processed + ?, changed = changed + ?,
      status = ?, error = NULL, retry_at = 0, updated_at = ? WHERE user_id = ?`).run(cursor, rows.length, changed, done ? 'completed' : 'running', nowIso(), userId);
    return !done;
  })();
}

function tick() {
  let db;
  try { db = getDb(); } catch { return; }
  let job;
  try {
    job = db.prepare("SELECT user_id FROM family_sync_jobs WHERE status IN ('pending', 'running') AND retry_at <= ? ORDER BY updated_at LIMIT 1").get(Date.now());
    if (!job) return;
    runBatch(db, job.user_id);
  } catch (err) {
    if (job) {
      try {
        db.prepare('UPDATE family_sync_jobs SET error = ?, retry_at = ?, updated_at = ? WHERE user_id = ?').run(err.message, Date.now() + 30_000, nowIso(), job.user_id);
      } catch { /* Database unavailable: the durable checkpoint will resume when it returns. */ }
    }
    logger.warn('Family payment scan will retry', { userId: job?.user_id, error: err.message });
    return;
  }
  nudge();
}

function nudge() {
  if (scheduled) return;
  scheduled = setImmediate(() => { scheduled = null; tick(); });
  scheduled.unref();
}
function startFamilyWorker() {
  if (timer) return;
  timer = setInterval(tick, 5000);
  timer.unref();
  nudge();
}
function stopFamilyWorker() {
  clearInterval(timer); timer = null;
  clearImmediate(scheduled); scheduled = null;
}

module.exports = { enqueue, statusFor, runBatch, nudge, startFamilyWorker, stopFamilyWorker };
