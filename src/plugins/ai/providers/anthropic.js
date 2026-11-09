// Claude through the official Anthropic SDK. Used only when a person switches Profile → AI to
// "API" and picks Claude; the local model stays the default.
const Anthropic = require('@anthropic-ai/sdk');
const AppError = require('../../../core/AppError');

const DEFAULT_MODEL = 'claude-opus-5-5';

// Models that accept server-side refusal fallbacks ("default" routing picks the fallback model).
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

// Squirl's reasoning levels → Claude effort. Current Claude models always think; effort is the dial.
const EFFORT = { none: 'low', low: 'low', medium: 'medium', high: 'high' };

const clientFor = (apiKey, timeout = 120_000) => new Anthropic({ apiKey, timeout, maxRetries: 2 });

function toAppError(err) {
  if (err instanceof AppError) return err;
  if (err instanceof Anthropic.AuthenticationError) return AppError.badRequest('Claude rejected the saved API key. Check it in Profile → AI.', 'AI_KEY_INVALID');
  if (err instanceof Anthropic.PermissionDeniedError) return AppError.badRequest('This Claude API key can’t use the selected model.', 'AI_MODEL_DENIED');
  if (err instanceof Anthropic.NotFoundError) return AppError.badRequest('Claude doesn’t know the selected model. Pick another in Profile → AI.', 'AI_MODEL_UNKNOWN');
  if (err instanceof Anthropic.RateLimitError) return new AppError('Claude is rate-limiting this key. Try again in a minute.', 429, 'AI_RATE_LIMITED');
  if (err instanceof Anthropic.APIConnectionError) return AppError.serviceUnavailable('Couldn’t reach the Claude API', 'LLM_UNAVAILABLE');
  if (err instanceof Anthropic.APIError) return new AppError('The Claude API returned an error', 502, 'LLM_ERROR');
  return err;
}

/** One reply. `messages` use the shared {role: system|user|assistant, content} shape. */
async function chat({ apiKey, model = DEFAULT_MODEL }, messages, { json = false, reasoning = 'medium', timeoutMs } = {}) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
  if (json) system.push('Reply with a single JSON object and nothing else.');
  const params = {
    model,
    max_tokens: 16000, // thinking counts toward this; only tokens actually used are billed
    output_config: { effort: EFFORT[reasoning] || 'medium' },
    system: system.join('\n\n') || undefined,
    messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
  };

  let response;
  try {
    const client = clientFor(apiKey, timeoutMs);
    response = FALLBACK_MODELS.has(model)
      ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await client.messages.create(params);
  } catch (err) {
    throw toAppError(err);
  }

  if (response.stop_reason === 'refusal') throw new AppError('Claude declined to answer this request', 502, 'LLM_REFUSED');
  if (response.stop_reason === 'max_tokens') throw new AppError('Claude reached its response limit before finishing. Try again.', 502, 'LLM_TRUNCATED');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new AppError('Claude returned an empty answer', 502, 'LLM_BAD_RESPONSE');
  return { text, model: response.model || model };
}

// Haiku-class models use the basic web search tool; the rest get dynamic filtering.
const webSearchTool = (model) => ({
  type: /haiku/i.test(model) ? 'web_search_20250305' : 'web_search_20260209',
  name: 'web_search',
  max_uses: 3,
  user_location: { type: 'approximate', country: 'IN' },
});

/**
 * One answer that matches `schema`, optionally after searching the web. The answer comes back as
 * a call to a `strict` tool (schema-guaranteed arguments) instead of JSON output, because
 * structured JSON output can't be combined with the citations web search adds. Forced tool use
 * isn't available on current models, so the prompt asks for the call and a missing one is
 * re-requested once. A paused server-side search loop (`pause_turn`) is resumed as documented.
 */
async function structured({ apiKey, model = DEFAULT_MODEL }, { system, prompt, schema, name, webSearch, strict, reasoning = 'low' }) {
  const client = clientFor(apiKey);
  const tools = [
    ...(webSearch ? [webSearchTool(model)] : []),
    { name, description: 'Return your final answer. Call this exactly once, after any searching.', input_schema: schema, ...(strict && { strict: true }) },
  ];
  const messages = [{ role: 'user', content: prompt }];
  const sources = new Map();
  let searched = false;

  for (let turn = 0; turn < 4; turn += 1) {
    let response;
    try {
      // eslint-disable-next-line no-await-in-loop
      response = await client.messages.create({
        model,
        max_tokens: 16000,
        output_config: { effort: EFFORT[reasoning] || 'low' },
        system: `${system}

When you are done, call the ${name} tool with your answer.`,
        tools,
        messages,
      });
    } catch (err) {
      throw toAppError(err);
    }
    for (const block of response.content) {
      if (block.type === 'server_tool_use') searched = true;
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) if (r.url && !sources.has(r.url)) sources.set(r.url, { title: r.title || r.url, url: r.url });
      }
    }
    if (response.stop_reason === 'refusal') throw new AppError('Claude declined to answer this request', 502, 'LLM_REFUSED');
    if (response.stop_reason === 'max_tokens') throw new AppError('Claude reached its response limit before finishing. Try again.', 502, 'LLM_TRUNCATED');
    const call = response.content.find((b) => b.type === 'tool_use' && b.name === name);
    if (call) return { data: call.input, sources: [...sources.values()], searched, strict: Boolean(strict), model: response.model || model };

    messages.push({ role: 'assistant', content: response.content });
    // pause_turn: send the conversation back as it is and the server carries on searching.
    if (response.stop_reason !== 'pause_turn') messages.push({ role: 'user', content: `Call the ${name} tool with your answer now.` });
  }
  throw new AppError('Claude didn’t return an answer in the expected shape', 502, 'LLM_BAD_RESPONSE');
}

async function listModels(apiKey) {
  try {
    const ids = [];
    for await (const m of clientFor(apiKey).models.list()) ids.push(m.id);
    return ids;
  } catch (err) {
    throw toAppError(err);
  }
}

module.exports = { DEFAULT_MODEL, chat, structured, listModels };
