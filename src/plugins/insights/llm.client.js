const config = require('../../config');
const AppError = require('../../core/AppError');
const logger = require('../../core/logger');
const { activeEngine, PROVIDERS } = require('../ai/ai.service');
const guard = require('../ai/guard');

/**
 * Every model call goes through here. By default it talks to a local LLM server through the
 * OpenAI-compatible chat API (llama.cpp's llama-server, Ollama, LM Studio all speak it), and
 * nothing leaves this machine. When a person switches Profile → AI to "API", calls that carry
 * their `userId` go to Claude or OpenAI with their own key instead (see plugins/ai).
 */
async function request(path, { body, timeoutMs }) {
  try {
    return await fetch(`${config.llm.url}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'took too long to answer' : 'isn’t running';
    throw AppError.serviceUnavailable(`The local model ${reason}`, 'LLM_UNAVAILABLE');
  }
}

// Reasoning models (e.g. Qwen3) prefix their answer with <think>…</think>; only the answer is wanted.
const stripThinking = (text) => text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();

/**
 * One chat completion. `json: true` asks the server to constrain the answer to a JSON object
 * (Ollama, llama-server and LM Studio all support response_format json_object).
 * Reasoning is enabled by default. Reserve extra tokens for it so the final answer is not
 * crowded out. Return only final content; separate reasoning fields never leave this client.
 */
async function chat(messages, { userId, guarded = false, ...options } = {}) {
  // Prompt guard (Profile → AI): checks the user-written parts before any engine sees them.
  if (userId && !guarded) await guard.assertSafe(userId, messages);
  const engine = userId ? activeEngine(userId) : { mode: 'local' };
  if (engine.mode === 'api') {
    const result = await PROVIDERS[engine.provider].chat(engine, messages, options);
    return { ...result, provider: engine.provider };
  }
  return { ...(await localChat(messages, options)), provider: 'local' };
}

async function localChat(messages, { maxTokens = 450, json = false, temperature = 0.2, reasoning = 'medium' } = {}) {
  const response = await request('/v1/chat/completions', {
    body: {
      model: config.llm.model,
      messages,
      temperature,
      max_tokens: maxTokens + (reasoning === 'none' ? 0 : 2048),
      stream: false,
      reasoning_effort: reasoning,
      seed: 7, // with temperature 0: the same prompt gives the same answer
      ...(json && { response_format: { type: 'json_object' } }),
    },
    timeoutMs: config.llm.timeoutMs,
  });
  if (!response.ok) {
    logger.warn('Local model returned an error', { status: response.status });
    throw new AppError('The local model returned an error', 502, 'LLM_ERROR');
  }
  const body = await response.json().catch(() => null);
  if (body?.choices?.[0]?.finish_reason === 'length') throw new AppError('The local model reached its response limit before finishing. Try again.', 502, 'LLM_TRUNCATED');
  const text = stripThinking(body?.choices?.[0]?.message?.content || '');
  if (!text) throw new AppError('The local model returned an empty answer', 502, 'LLM_BAD_RESPONSE');
  return { text, model: body.model || config.llm.model };
}

// The first {...} block in a model answer, parsed. Models sometimes wrap JSON in prose or ``` fences.
function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Quick check for the UI. Never throws. `loaded` says whether the model is already in memory
 * (Ollama's /api/ps); a cold model takes minutes to load from the drive. Other servers
 * don't have that endpoint, so `loaded` is then left out.
 */
async function status(userId) {
  const engine = userId ? activeEngine(userId) : { mode: 'local' };
  // A cloud API has no "loading" state; whether the key works shows on the first real call.
  if (engine.mode === 'api') return { available: true, mode: 'api', provider: engine.provider, model: engine.model, loaded: true };
  return { mode: 'local', ...(await localStatus()) };
}

/** Identifies the engine in cache keys, so switching model or provider never reuses an old answer. */
function engineKey(userId) {
  const engine = userId ? activeEngine(userId) : { mode: 'local' };
  return engine.mode === 'api' ? `${engine.provider}:${engine.model}` : `local:${config.llm.model}`;
}

async function localStatus() {
  try {
    const response = await request('/v1/models', { timeoutMs: 1500 });
    if (!response.ok) return { available: false };
    const body = await response.json().catch(() => ({}));
    const models = (body?.data || []).map((m) => m.id);
    const model = models.includes(config.llm.model) ? config.llm.model : models[0] || config.llm.model;

    let loaded;
    try {
      const ps = await fetch(`${config.llm.url}/api/ps`, { signal: AbortSignal.timeout(1500) });
      if (ps.ok) loaded = ((await ps.json())?.models || []).some((m) => m.name === config.llm.model || m.model === config.llm.model);
    } catch (err) {
      // Ollama holds /api/ps while it loads a model, so a server that answered /v1/models but
      // stalls here is busy loading. Any other failure means it isn't Ollama: leave `loaded` out.
      if (err.name === 'TimeoutError') loaded = false;
    }
    return { available: true, model, ...(loaded !== undefined && { loaded }) };
  } catch {
    return { available: false };
  }
}

/**
 * One answer shaped by a JSON schema, for features that fill in a form (goal setup). Cloud
 * engines can search the web first and, with "strict" on, are constrained to the schema; the
 * local model gets JSON mode and never searches (it's offline). Returns the parsed object plus
 * the sources it read; the caller still validates every field.
 */
async function structured(userId, { system, prompt, schema, name, reasoning = 'low' }) {
  if (userId) await guard.assertSafe(userId, [{ role: 'user', content: prompt }]);
  const engine = userId ? activeEngine(userId) : { mode: 'local' };
  if (engine.mode === 'api') {
    const r = await PROVIDERS[engine.provider].structured(engine, { system, prompt, schema, name, webSearch: engine.webSearch, strict: engine.strict, reasoning });
    const data = r.data ?? parseJson(r.text);
    if (!data) throw new AppError('The model gave an answer that couldn’t be read', 502, 'LLM_BAD_RESPONSE');
    return { data, sources: r.sources || [], searched: Boolean(r.searched), strict: Boolean(r.strict), searchUnavailable: r.searchUnavailable || null, model: r.model, provider: engine.provider };
  }
  const { text, model } = await localChat(
    [
      { role: 'system', content: `${system}\n\nYou cannot browse the web. Reply with one JSON object matching this JSON schema:\n${JSON.stringify(schema)}` },
      { role: 'user', content: prompt },
    ],
    { json: true, maxTokens: 600, temperature: 0, reasoning },
  );
  const data = parseJson(text);
  if (!data) throw new AppError('The local model gave an answer that couldn’t be read', 502, 'LLM_BAD_RESPONSE');
  return { data, sources: [], searched: false, strict: false, model, provider: 'local' };
}

module.exports = { chat, structured, status, parseJson, engineKey };
