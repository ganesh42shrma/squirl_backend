// Keeps each goal's written plan check current. Nudged when a goal or its contributions change and
// after every statement import; waits a few seconds so a burst of changes costs one model call per
// goal. A goal is re-analysed only when its facts actually changed (see goal.analysis), so a
// cloud API key isn't charged for answers that would be the same.
const { getDb } = require('../../config/db');
const logger = require('../../core/logger');
const llm = require('../insights/llm.client');

const DEBOUNCE_MS = 4000;

const queue = new Set();
let running = null; // userId being worked on
let timer = null;

async function run() {
  if (running) return;
  for (const userId of queue) {
    queue.delete(userId);
    running = userId;
    try {
      // eslint-disable-next-line no-await-in-loop
      const model = await llm.status(userId);
      if (!model.available || model.loaded === false) continue; // the page offers "Ask now" instead
      const goals = getDb().prepare("SELECT id FROM active_goals WHERE user_id = ? AND status = 'active'").pluck().all(userId);
      const { generateAnalysis } = require('./goal.analysis');
      for (const goalId of goals) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await generateAnalysis(userId, goalId);
        } catch (err) {
          logger.warn('Goal analysis failed', { userId, goalId, error: err.message, code: err.code });
          if (['LLM_UNAVAILABLE', 'AI_KEY_INVALID', 'AI_RATE_LIMITED'].includes(err.code)) break;
        }
      }
    } catch (err) {
      logger.warn('Goal analysis run failed', { userId, error: err.message });
    } finally {
      running = null;
    }
  }
  // Set iteration already picks up users nudged mid-run; this catches a nudge that raced the end.
  if (queue.size) nudge([...queue][0]);
}

function nudge(userId) {
  queue.add(userId);
  clearTimeout(timer);
  timer = setTimeout(run, DEBOUNCE_MS);
  timer.unref?.();
}

const isPending = (userId) => queue.has(userId) || running === userId;

module.exports = { nudge, isPending };
