// OpenAI (GPT / Codex models) through the official OpenAI SDK's Responses API, which serves
// every current OpenAI model, Codex ones included. Used only when a person picks it in Profile → AI.
const OpenAI = require('openai');
const AppError = require('../../../core/AppError');

const DEFAULT_MODEL = null; // no guess: the person picks from their key's own model list

// Reasoning models accept an effort; older chat models reject the field.
const isReasoningModel = (model) => /^(o\d|gpt-5|codex)/i.test(model);
const EFFORT = { none: 'low', low: 'low', medium: 'medium', high: 'high' };

const clientFor = (apiKey, timeout = 120_000) => new OpenAI({ apiKey, timeout, maxRetries: 2 });

function toAppError(err) {
  if (err instanceof AppError) return err;
  if (err instanceof OpenAI.AuthenticationError) return AppError.badRequest('OpenAI rejected the saved API key. Check it in Profile → AI.', 'AI_KEY_INVALID');
  if (err instanceof OpenAI.PermissionDeniedError) return AppError.badRequest('This OpenAI API key can’t use the selected model.', 'AI_MODEL_DENIED');
  if (err instanceof OpenAI.NotFoundError) return AppError.badRequest('OpenAI doesn’t know the selected model. Pick another in Profile → AI.', 'AI_MODEL_UNKNOWN');
  if (err instanceof OpenAI.RateLimitError) return new AppError('OpenAI is rate-limiting this key. Try again in a minute.', 429, 'AI_RATE_LIMITED');
  if (err instanceof OpenAI.APIConnectionError) return AppError.serviceUnavailable('Couldn’t reach the OpenAI API', 'LLM_UNAVAILABLE');
  if (err instanceof OpenAI.APIError) return new AppError('The OpenAI API returned an error', 502, 'LLM_ERROR');
  return err;
}

async function chat({ apiKey, model }, messages, { json = false, reasoning = 'medium', maxTokens = 450, timeoutMs } = {}) {
  if (!model) throw AppError.badRequest('Pick an OpenAI model in Profile → AI', 'AI_MODEL_MISSING');
  const instructions = messages.filter((m) => m.role === 'system').map((m) => m.content);
  // JSON mode requires the word "JSON" in the prompt.
  if (json) instructions.push('Reply with a single JSON object and nothing else.');
  const reasoningModel = isReasoningModel(model);

  let response;
  try {
    response = await clientFor(apiKey, timeoutMs).responses.create({
      model,
      instructions: instructions.join('\n\n') || undefined,
      input: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
      max_output_tokens: reasoningModel ? maxTokens + 8000 : maxTokens + 500,
      ...(reasoningModel && { reasoning: { effort: EFFORT[reasoning] || 'medium' } }),
      ...(json && { text: { format: { type: 'json_object' } } }),
      store: false, // don't keep the conversation on OpenAI's side
    });
  } catch (err) {
    throw toAppError(err);
  }

  if (response.status === 'incomplete') {
    throw new AppError('OpenAI reached its response limit before finishing. Try again.', 502, 'LLM_TRUNCATED');
  }
  const text = (response.output_text || '').trim();
  if (!text) throw new AppError('OpenAI returned an empty answer', 502, 'LLM_BAD_RESPONSE');
  return { text, model: response.model || model };
}

/**
 * One answer that matches `schema`, optionally after a web search. With `strict`, the Responses
 * API constrains the output to the JSON schema; otherwise it's JSON mode, validated by the caller.
 */
async function structured({ apiKey, model }, { system, prompt, schema, name, webSearch, strict, reasoning = 'low', maxTokens = 1200 }) {
  if (!model) throw AppError.badRequest('Pick an OpenAI model in Profile → AI', 'AI_MODEL_MISSING');
  const reasoningModel = isReasoningModel(model);
  let response;
  try {
    response = await clientFor(apiKey).responses.create({
      model,
      instructions: strict ? system : `${system}\n\nReply with one JSON object matching this JSON schema:\n${JSON.stringify(schema)}`,
      input: [{ role: 'user', content: prompt }],
      ...(webSearch && { tools: [{ type: 'web_search', user_location: { type: 'approximate', country: 'IN' } }] }),
      text: { format: strict ? { type: 'json_schema', name, schema, strict: true } : { type: 'json_object' } },
      max_output_tokens: reasoningModel ? maxTokens + 8000 : maxTokens + 500,
      ...(reasoningModel && { reasoning: { effort: EFFORT[reasoning] || 'low' } }),
      store: false,
    });
  } catch (err) {
    throw toAppError(err);
  }
  if (response.status === 'incomplete') throw new AppError('OpenAI reached its response limit before finishing. Try again.', 502, 'LLM_TRUNCATED');
  const sources = new Map();
  let searched = false;
  for (const item of response.output || []) {
    if (item.type === 'web_search_call') searched = true;
    if (item.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part.type === 'refusal') throw new AppError('OpenAI declined to answer this request', 502, 'LLM_REFUSED');
      for (const a of part.annotations || []) if (a.type === 'url_citation' && a.url && !sources.has(a.url)) sources.set(a.url, { title: a.title || a.url, url: a.url });
    }
  }
  const text = (response.output_text || '').trim();
  if (!text) throw new AppError('OpenAI returned an empty answer', 502, 'LLM_BAD_RESPONSE');
  return { text, sources: [...sources.values()], searched, strict: Boolean(strict), model: response.model || model };
}

// Text models only: embeddings, audio, image and moderation models can't write these answers.
const usable = (id) => /^(gpt|o\d|codex|chatgpt)/i.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding|moderation)/i.test(id);

async function listModels(apiKey) {
  try {
    const ids = [];
    for await (const m of clientFor(apiKey).models.list()) if (usable(m.id)) ids.push(m.id);
    return ids.sort().reverse();
  } catch (err) {
    throw toAppError(err);
  }
}

module.exports = { DEFAULT_MODEL, chat, structured, listModels };
