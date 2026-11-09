// Groq (fast open models: Llama, GPT-OSS, Qwen, Kimi and Groq's own "compound" systems) through
// the official Groq SDK. Used only when a person picks it in Profile → AI.
const Groq = require('groq-sdk');
const AppError = require('../../../core/AppError');

const DEFAULT_MODEL = null; // no guess: the person picks from their key's own model list

// Groq's compound systems search the web on their own; the GPT-OSS models can when given Groq's
// built-in browser_search tool; other Groq models can't search.
const isCompound = (model) => /^groq\/compound/i.test(model);
const hasBrowserSearch = (model) => /^openai\/gpt-oss/i.test(model);
// Reasoning models accept an effort; others reject the field.
const isReasoning = (model) => /gpt-oss|qwen3/i.test(model);
const EFFORT = { none: 'low', low: 'low', medium: 'medium', high: 'high' };

const clientFor = (apiKey, timeout = 120_000) => new Groq({ apiKey, timeout, maxRetries: 2 });

function toAppError(err) {
  if (err instanceof AppError) return err;
  if (err instanceof Groq.AuthenticationError) return AppError.badRequest('Groq rejected the saved API key. Check it in Profile → AI.', 'AI_KEY_INVALID');
  if (err instanceof Groq.PermissionDeniedError) return AppError.badRequest('This Groq API key can’t use the selected model.', 'AI_MODEL_DENIED');
  if (err instanceof Groq.NotFoundError) return AppError.badRequest('Groq doesn’t know the selected model. Pick another in Profile → AI.', 'AI_MODEL_UNKNOWN');
  if (err instanceof Groq.RateLimitError) return new AppError('Groq is rate-limiting this key, or its quota is used up. Try again in a minute.', 429, 'AI_RATE_LIMITED');
  if (err instanceof Groq.APIConnectionError) return AppError.serviceUnavailable('Couldn’t reach the Groq API, or it took too long', 'LLM_UNAVAILABLE');
  if (err instanceof Groq.APIError) return new AppError(`Groq API: ${String(err.message || 'error').slice(0, 200)}`, 502, 'LLM_ERROR');
  return err;
}

// Reasoning models may prefix their answer with <think>…</think>; only the answer is wanted.
const stripThinking = (text) => String(text || '').replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();

function readText(completion, label = 'Groq') {
  const choice = completion.choices?.[0];
  if (choice?.finish_reason === 'length') throw new AppError(`${label} reached its response limit before finishing. Try again.`, 502, 'LLM_TRUNCATED');
  const text = stripThinking(choice?.message?.content);
  if (!text) throw new AppError(`${label} returned an empty answer`, 502, 'LLM_BAD_RESPONSE');
  return text;
}

async function chat({ apiKey, model }, messages, { json = false, reasoning = 'medium', maxTokens = 450, timeoutMs } = {}) {
  if (!model) throw AppError.badRequest('Pick a Groq model in Profile → AI', 'AI_MODEL_MISSING');
  const list = messages.map((m) => ({ role: m.role, content: m.content }));
  // JSON mode needs the word "JSON" in the conversation.
  if (json) list.unshift({ role: 'system', content: 'Reply with a single JSON object.' });
  let completion;
  try {
    completion = await clientFor(apiKey, timeoutMs).chat.completions.create({
      model,
      messages: list,
      max_completion_tokens: isReasoning(model) ? maxTokens + 4000 : maxTokens + 500,
      ...(isReasoning(model) && { reasoning_effort: EFFORT[reasoning] || 'medium' }),
      ...(json && !isCompound(model) && { response_format: { type: 'json_object' } }),
    });
  } catch (err) {
    throw toAppError(err);
  }
  return { text: readText(completion), model: completion.model || model };
}

/**
 * One answer that matches `schema`. Compound models search the web themselves; GPT-OSS models
 * search with the browser_search tool. Either way the pages visited come back in `executed_tools`.
 * With `strict`, the answer is constrained to the JSON schema where Groq allows it; if a model or
 * tool combination rejects that, it falls back to JSON mode, then to JSON asked for in the prompt
 * (always validated by the caller).
 */
async function structured({ apiKey, model }, { system, prompt, schema, name, webSearch, strict, reasoning = 'low', maxTokens = 1200 }) {
  if (!model) throw AppError.badRequest('Pick a Groq model in Profile → AI', 'AI_MODEL_MISSING');
  const client = clientFor(apiKey);
  const compound = isCompound(model);
  const browser = webSearch && hasBrowserSearch(model);
  const inPrompt = `${system}\n\nReply with one JSON object matching this JSON schema:\n${JSON.stringify(schema)}`;
  const base = {
    model,
    max_completion_tokens: isReasoning(model) ? maxTokens + 4000 : maxTokens + 500,
    ...(isReasoning(model) && { reasoning_effort: EFFORT[reasoning] || 'low' }),
  };
  const run = (format) =>
    client.chat.completions.create({
      ...base,
      messages: [
        { role: 'system', content: format === 'json_schema' ? system : inPrompt },
        { role: 'user', content: compound && !webSearch ? `${prompt}\n\nDo not search the web.` : prompt },
      ],
      ...(compound && webSearch && { search_settings: { country: 'india' } }),
      ...(browser && { tools: [{ type: 'browser_search' }] }),
      ...(format === 'json_schema' && { response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } } }),
      ...(format === 'json_object' && { response_format: { type: 'json_object' } }),
    });

  // Compound systems take no response_format. For the rest: strict schema first, then JSON mode,
  // then (only alongside browser search) JSON asked for in the prompt.
  const formats = compound ? ['prompt'] : [...(strict ? ['json_schema'] : []), 'json_object', ...(browser ? ['prompt'] : [])];
  let completion;
  let format;
  for (const [i, next] of formats.entries()) {
    format = next;
    try {
      // eslint-disable-next-line no-await-in-loop
      completion = await run(format);
      break;
    } catch (err) {
      if (i === formats.length - 1 || !(err instanceof Groq.BadRequestError)) throw toAppError(err);
    }
  }

  const tools = completion.choices?.[0]?.message?.executed_tools || [];
  const sources = new Map();
  for (const t of tools) {
    for (const r of [...(t.search_results?.results || []), ...(t.browser_results || [])]) {
      if (r.url && !sources.has(r.url)) sources.set(r.url, { title: r.title || r.url, url: r.url });
    }
  }
  return {
    text: readText(completion),
    sources: [...sources.values()],
    searched: tools.some((t) => /search|browser/i.test(t.type || '')),
    strict: format === 'json_schema',
    // Only compound and GPT-OSS models can look things up; tell the form why there's no live price.
    ...(webSearch && !compound && !browser && { searchUnavailable: 'model' }),
    model: completion.model || model,
  };
}

/**
 * Prompt Guard: the probability (0 to 1) that `text` is a prompt-injection or jailbreak attempt.
 * Groq returns the score as the message text; a label is mapped to 0 or 1 just in case.
 */
async function classify({ apiKey, model }, text) {
  let completion;
  try {
    completion = await clientFor(apiKey, 15_000).chat.completions.create({ model, messages: [{ role: 'user', content: text }] });
  } catch (err) {
    throw toAppError(err);
  }
  const out = String(completion.choices?.[0]?.message?.content ?? '').trim();
  const score = Number(out);
  if (Number.isFinite(score)) return Math.min(Math.max(score, 0), 1);
  if (/malicious|injection|jailbreak|unsafe/i.test(out)) return 1;
  if (/benign|safe/i.test(out)) return 0;
  throw new AppError('The prompt guard gave an answer that couldn’t be read', 502, 'LLM_BAD_RESPONSE');
}

// Text models only: speech (whisper), voice (tts/playai), safety classifiers (guard) can't write answers.
const usable = (id) => !/(whisper|tts|playai|guard|embed|distil)/i.test(id);

async function listModels(apiKey) {
  try {
    const { data } = await clientFor(apiKey, 30_000).models.list();
    return (data || []).map((m) => m.id).filter(usable).sort();
  } catch (err) {
    throw toAppError(err);
  }
}

module.exports = { DEFAULT_MODEL, chat, structured, classify, listModels };
