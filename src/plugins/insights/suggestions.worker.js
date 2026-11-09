// Background job that works through every unsorted merchant, a batch at a time, whenever the
// local model is loaded. Starts on boot, re-checks every 20 s, and is nudged after each import.
// State lives in the database (saved suggestions), so a restart simply carries on where it stopped.
const { getDb } = require('../../config/db');
const logger = require('../../core/logger');
const llm = require('./llm.client');
const { BATCH, pendingGroups, suggestBatch, usersWithUnsorted, autoCategorize } = require('./suggestions.service');

const TICK_MS = 20_000;
const BACKOFF_MS = 2 * 60_000; // after a model error, wait before trying again

const progress = new Map(); // userId → { running, total, done, error, lastRunAt }
let busy = false;
let backoffUntil = 0;
let timer = null;

async function runForUser(db, userId, { allowModel = true } = {}) {
  const state = { running: true, total: 0, done: 0, autoApplied: 0, waitingForModel: false, error: null, startedAt: new Date().toISOString() };
  progress.set(userId, state);
  try {
    const generation = db.prepare('SELECT financial_generation FROM users WHERE id = ?').get(userId)?.financial_generation;
    state.autoApplied += autoCategorize(db, userId);
    const groups = pendingGroups(db, userId);
    state.total = groups.length;
    if (!groups.length) return;
    if (!allowModel) { state.waitingForModel = true; return; }
    logger.info('Category suggestions: started', { userId, merchants: groups.length });
    for (let i = 0; i < groups.length; i += BATCH) {
      await suggestBatch(db, userId, groups.slice(i, i + BATCH));
      if (db.prepare('SELECT financial_generation FROM users WHERE id = ?').get(userId)?.financial_generation !== generation) break;
      state.autoApplied += autoCategorize(db, userId);
      state.done = Math.min(groups.length, i + BATCH);
    }
    logger.info('Category suggestions: finished', { userId, merchants: groups.length });
  } catch (err) {
    state.error = err.message;
    backoffUntil = Date.now() + BACKOFF_MS;
    logger.warn('Category suggestions: paused after an error', { userId, error: err.message });
  } finally {
    state.running = false;
    state.lastRunAt = new Date().toISOString();
  }
}

async function tick() {
  if (busy || Date.now() < backoffUntil) return;
  busy = true;
  try {
    let db;
    try {
      db = getDb();
    } catch {
      return; // database not open (starting up or shutting down)
    }
    const users = usersWithUnsorted(db);
    if (!users.length) return;
    const model = await llm.status();
    for (const userId of users) {
      // eslint-disable-next-line no-await-in-loop
      await runForUser(db, userId, { allowModel: Boolean(model.available && model.loaded !== false) });
      if (Date.now() < backoffUntil) break;
    }
  } catch (err) {
    logger.warn('Category suggestions: tick failed', { error: err.message });
  } finally {
    busy = false;
  }
}

function startSuggestionWorker() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  setTimeout(tick, 3000).unref();
}

function stopSuggestionWorker() {
  clearInterval(timer);
  timer = null;
}

// Run soon (e.g. right after an import), and clear any back-off: the person just asked for it.
function nudge() {
  backoffUntil = 0;
  setImmediate(tick);
}

const progressFor = (userId) => progress.get(userId) || null;

const resetForUser = (userId) => progress.delete(userId);

module.exports = { startSuggestionWorker, stopSuggestionWorker, nudge, progressFor, resetForUser, runForUser };
