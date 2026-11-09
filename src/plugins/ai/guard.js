// Prompt guard: before any model call, Groq's Llama Prompt Guard 2 (a tiny classifier) scores the
// text that didn't come from Squirl's own code (goal names, notes, transaction descriptions) for
// prompt-injection and jailbreak attempts. On when the person turns it on in Profile → AI and has
// a Groq key saved; it guards the cloud engines (Claude, OpenAI, Gemini, Groq). The local model is
// never guarded: nothing leaves the computer there, and a Groq check would add an outside call.
//
// If the guard itself can't be reached, the call goes ahead and the miss is logged ("fail open"),
// so a Groq outage doesn't switch off every AI feature.
const { createHash } = require('crypto');
const AppError = require('../../core/AppError');
const logger = require('../../core/logger');
const groq = require('./providers/groq');

const GUARD_MODELS = ['meta-llama/llama-prompt-guard-2-22m', 'meta-llama/llama-prompt-guard-2-86m'];
const THRESHOLD = 0.9; // probability of an attack at which text is blocked
const CHUNK = 1800; // characters per check: Prompt Guard reads up to 512 tokens
const CONCURRENCY = 4;

const cache = new Map(); // hash(model + text) → score
const remember = (key, score) => {
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
  cache.set(key, score);
};

/** Splits text on line breaks into pieces the guard can read whole. */
function chunks(text) {
  const out = [];
  let current = '';
  for (const line of String(text || '').split('\n')) {
    for (let i = 0; i < Math.max(line.length, 1); i += CHUNK) {
      const piece = line.slice(i, i + CHUNK);
      if (current && current.length + piece.length + 1 > CHUNK) {
        out.push(current);
        current = '';
      }
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

function settingsFor(userId) {
  const { getSettings, activeEngine } = require('./ai.service');
  const s = getSettings(userId);
  if (!s.guard?.enabled || !s.keys.groq || activeEngine(userId).mode !== 'api') return null;
  return { apiKey: s.keys.groq, model: s.guard.model };
}

async function scoreAll(guard, texts) {
  const scores = new Array(texts.length);
  let next = 0;
  const worker = async () => {
    while (next < texts.length) {
      const i = next;
      next += 1;
      const key = createHash('sha256').update(guard.model).update(texts[i]).digest('hex');
      if (!cache.has(key)) remember(key, await groq.classify(guard, texts[i]));
      scores[i] = cache.get(key);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker));
  return scores;
}

/**
 * Scores each item's text; returns { safe, flagged } lists of the original items. When the guard
 * is off or unreachable, every item is safe.
 */
async function partition(userId, items, textOf) {
  const guard = settingsFor(userId);
  if (!guard || !items.length) return { safe: items, flagged: [], checked: false };
  try {
    const perItem = items.map((item) => chunks(textOf(item)));
    const scores = await scoreAll(guard, perItem.flat());
    let k = 0;
    const safe = [];
    const flagged = [];
    perItem.forEach((list, i) => {
      const worst = Math.max(0, ...scores.slice(k, k + list.length));
      k += list.length;
      (worst >= THRESHOLD ? flagged : safe).push(items[i]);
    });
    if (flagged.length) logger.warn('Prompt guard flagged input', { userId, flagged: flagged.length, of: items.length });
    return { safe, flagged, checked: true };
  } catch (err) {
    logger.warn('Prompt guard unavailable; continuing unchecked', { userId, code: err.code, error: err.message });
    return { safe: items, flagged: [], checked: false };
  }
}

/** Throws AI_BLOCKED if any user-written part of the conversation looks like an attack. */
async function assertSafe(userId, messages) {
  const texts = messages.filter((m) => m.role === 'user').map((m) => m.content);
  const { flagged } = await partition(userId, texts, (t) => t);
  if (flagged.length) {
    throw AppError.badRequest('This request looked like an attempt to manipulate the AI, so Squirl didn’t send it. Reword it and try again.', 'AI_BLOCKED');
  }
}

module.exports = { GUARD_MODELS, THRESHOLD, chunks, partition, assertSafe };
