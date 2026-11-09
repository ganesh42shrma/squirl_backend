// Which model writes Squirl's words: the local model (default) or a cloud API (Claude / OpenAI)
// with the person's own key. Stored per user in users.ai_settings (JSON) inside the encrypted
// database. Keys are write-only through the API: responses only say whether one is saved.
const { getDb } = require('../../config/db');
const config = require('../../config');
const AppError = require('../../core/AppError');
const { nowIso, updateRow } = require('../../core/sql');
const anthropic = require('./providers/anthropic');
const openai = require('./providers/openai');
const google = require('./providers/google');
const groq = require('./providers/groq');

const PROVIDERS = { anthropic, openai, google, groq };
const PROVIDER_NAMES = Object.keys(PROVIDERS);
const MODES = ['local', 'api'];

const DEFAULTS = Object.freeze({
  mode: 'local',
  provider: 'anthropic',
  models: { anthropic: anthropic.DEFAULT_MODEL, openai: openai.DEFAULT_MODEL, google: google.DEFAULT_MODEL, groq: groq.DEFAULT_MODEL },
  keys: { anthropic: null, openai: null, google: null, groq: null },
  webSearch: true, // cloud models may search the web (live prices for goals)
  strict: true, //    ask cloud models for schema-constrained structured output
  // Groq's Prompt Guard checks what Squirl sends to any model (needs a Groq key).
  guard: { enabled: false, model: 'meta-llama/llama-prompt-guard-2-22m' },
});

/** Full settings, keys included. Never send this to a client. */
function getSettings(userId) {
  const raw = getDb().prepare('SELECT ai_settings FROM users WHERE id = ?').pluck().get(userId);
  const saved = raw ? JSON.parse(raw) : {};
  return {
    mode: MODES.includes(saved.mode) ? saved.mode : DEFAULTS.mode,
    provider: PROVIDER_NAMES.includes(saved.provider) ? saved.provider : DEFAULTS.provider,
    models: { ...DEFAULTS.models, ...saved.models },
    keys: { ...DEFAULTS.keys, ...saved.keys },
    webSearch: typeof saved.webSearch === 'boolean' ? saved.webSearch : DEFAULTS.webSearch,
    strict: typeof saved.strict === 'boolean' ? saved.strict : DEFAULTS.strict,
    guard: { ...DEFAULTS.guard, ...saved.guard },
  };
}

const hint = (key) => (key ? { saved: true, last4: key.slice(-4) } : { saved: false });

function toPublic(s) {
  return {
    mode: s.mode,
    provider: s.provider,
    models: s.models,
    keys: Object.fromEntries(PROVIDER_NAMES.map((p) => [p, hint(s.keys[p])])),
    webSearch: s.webSearch,
    strict: s.strict,
    guard: s.guard,
    local: { model: config.llm.model },
  };
}

/**
 * What the next model call will use: { mode: 'local' } or { mode: 'api', provider, model, apiKey }.
 * Falls back to local if API mode is on but the chosen provider has no key (it can't be used).
 */
function activeEngine(userId) {
  const s = getSettings(userId);
  if (s.mode !== 'api' || !s.keys[s.provider]) return { mode: 'local' };
  return { mode: 'api', provider: s.provider, model: s.models[s.provider], apiKey: s.keys[s.provider], webSearch: s.webSearch, strict: s.strict };
}

async function getPublicSettings(userId) {
  return toPublic(getSettings(userId));
}

async function updateSettings(userId, { mode, provider, models = {}, keys = {}, webSearch, strict, guard }) {
  const s = getSettings(userId);
  const next = {
    mode: mode ?? s.mode,
    provider: provider ?? s.provider,
    models: { ...s.models, ...models },
    keys: { ...s.keys },
    webSearch: webSearch ?? s.webSearch,
    strict: strict ?? s.strict,
    guard: { ...s.guard, ...guard },
  };
  // A key is replaced when given, removed with null, kept when left out.
  for (const [p, key] of Object.entries(keys)) if (key !== undefined) next.keys[p] = key;

  if (next.guard.enabled && !next.keys.groq) throw AppError.badRequest('Save a Groq API key to use the prompt guard', 'AI_KEY_MISSING');
  if (next.mode === 'api') {
    if (!next.keys[next.provider]) throw AppError.badRequest('Save an API key for this provider before switching to API', 'AI_KEY_MISSING');
    if (!next.models[next.provider]) throw AppError.badRequest('Pick a model for this provider', 'AI_MODEL_MISSING');
  }
  updateRow(getDb(), 'users', userId, { ai_settings: JSON.stringify(next), updated_at: nowIso() });
  return toPublic(next);
}

/** Model ids the saved key can use, straight from the provider. */
async function listModels(userId, provider) {
  const key = getSettings(userId).keys[provider];
  if (!key) throw AppError.badRequest('Save an API key for this provider first', 'AI_KEY_MISSING');
  return { provider, models: await PROVIDERS[provider].listModels(key) };
}

/** A tiny round trip so the person knows the key and model work before relying on them. */
async function testProvider(userId, provider) {
  const s = getSettings(userId);
  const p = provider || s.provider;
  if (!s.keys[p]) throw AppError.badRequest('Save an API key for this provider first', 'AI_KEY_MISSING');
  const started = Date.now();
  const { model } = await PROVIDERS[p].chat({ apiKey: s.keys[p], model: s.models[p] }, [{ role: 'user', content: 'Reply with the single word: ready' }], { reasoning: 'none', maxTokens: 20, timeoutMs: 30_000 }); // a quick check should fail fast
  return { ok: true, provider: p, model, ms: Date.now() - started };
}

module.exports = { PROVIDERS, PROVIDER_NAMES, MODES, getSettings, activeEngine, getPublicSettings, updateSettings, listModels, testProvider };
