// Google Gemini through the official Google Gen AI SDK (@google/genai). Used only when a person
// picks it in Profile → AI; the local model stays the default.
const { GoogleGenAI, ApiError } = require('@google/genai');
const AppError = require('../../../core/AppError');
const logger = require('../../../core/logger');

const DEFAULT_MODEL = null; // no guess: the person picks from their key's own model list

const clientFor = (apiKey, timeout = 120_000) =>
  new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout, // per attempt
      // "Busy" (503) is usually brief: try twice more, waiting ~1 s then ~2 s. Not 429: on Gemini it's
      // mostly a used-up quota, where retrying only wastes time (and the search fallback handles it).
      retryOptions: { attempts: 3, initialDelay: 1, maxDelay: 4, httpStatusCodes: [503] },
      ...(process.env.GOOGLE_GEMINI_BASE_URL && { baseUrl: process.env.GOOGLE_GEMINI_BASE_URL }),
    },
  });

// The SDK puts Google's JSON error body in err.message: {"error":{"code":503,"status":"UNAVAILABLE","message":"…"}}
function googleDetail(err) {
  try {
    const body = JSON.parse(err.message);
    // Which quota ran out, from Google's QuotaFailure details (e.g. a per-day or search quota).
    const quota = (body.error?.details || []).flatMap((d) => d.violations || []).map((v) => v.quotaId || v.quotaMetric).filter(Boolean);
    return { status: body.error?.status, message: String(body.error?.message || '').trim(), quota };
  } catch {
    return { message: String(err.message || '').trim(), quota: [] };
  }
}

// "You exceeded your current quota" is a used-up allowance, not a brief burst: retrying won't help.
const isQuotaExhausted = (err) => err instanceof ApiError && err.status === 429 && /exceeded your current quota|quota/i.test(googleDetail(err).message);

function toAppError(err) {
  if (err instanceof AppError) return err;
  if (err instanceof ApiError) {
    const detail = googleDetail(err);
    logger.warn('Google AI API error', { status: err.status, googleStatus: detail.status, quota: detail.quota, message: detail.message.slice(0, 300) });
    const keyProblem = /api key/i.test(detail.message);
    if (err.status === 401 || (err.status === 400 && keyProblem)) return AppError.badRequest('Google rejected the saved API key. Check it in Profile → AI.', 'AI_KEY_INVALID');
    if (err.status === 403) return AppError.badRequest(`Google refused this request: ${detail.message || 'permission denied'}`, 'AI_MODEL_DENIED');
    if (err.status === 404) return AppError.badRequest('Google doesn’t know the selected model. Pick another in Profile → AI.', 'AI_MODEL_UNKNOWN');
    if (err.status === 429) {
      return isQuotaExhausted(err)
        ? new AppError('Your Google key’s quota for this is used up. Check its plan and billing at ai.dev/rate-limit.', 429, 'AI_QUOTA_EXHAUSTED')
        : new AppError('Google is rate-limiting this key. Try again in a minute.', 429, 'AI_RATE_LIMITED');
    }
    if (err.status === 503) {
      return new AppError('This Gemini model is busy right now (high demand on Google’s side). Try again in a few minutes, or pick another model.', 503, 'AI_BUSY');
    }
    if (err.status === 500 || err.status === 504) {
      return new AppError(`Gemini didn’t answer in time (${detail.status || err.status}). Try again, or pick another model.`, 504, 'AI_TIMEOUT');
    }
    return new AppError(`Google AI API: ${detail.message || 'unknown error'} (${err.status})`, 502, 'LLM_ERROR');
  }
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return new AppError('Gemini took too long to answer. Try again, or pick another model.', 504, 'AI_TIMEOUT');
  if (err?.name === 'TypeError') return AppError.serviceUnavailable('Couldn’t reach the Google AI API', 'LLM_UNAVAILABLE');
  return err;
}

// Gemini calls the assistant role "model" and takes the system prompt separately.
const toContents = (messages) =>
  messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

function readText(response) {
  const candidate = response.candidates?.[0];
  if (candidate?.finishReason === 'MAX_TOKENS') throw new AppError('Gemini reached its response limit before finishing. Try again.', 502, 'LLM_TRUNCATED');
  if (candidate?.finishReason === 'SAFETY' || response.promptFeedback?.blockReason) throw new AppError('Gemini declined to answer this request', 502, 'LLM_REFUSED');
  const text = (response.text || '').trim();
  if (!text) throw new AppError('Gemini returned an empty answer', 502, 'LLM_BAD_RESPONSE');
  return text;
}

async function chat({ apiKey, model }, messages, { json = false, maxTokens = 450, timeoutMs } = {}) {
  if (!model) throw AppError.badRequest('Pick a Google model in Profile → AI', 'AI_MODEL_MISSING');
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
  let response;
  try {
    response = await clientFor(apiKey, timeoutMs).models.generateContent({
      model,
      contents: toContents(messages),
      config: {
        systemInstruction: system.join('\n\n') || undefined,
        maxOutputTokens: maxTokens + 8000, // thinking models spend part of this before answering
        ...(json && { responseMimeType: 'application/json' }),
      },
    });
  } catch (err) {
    throw toAppError(err);
  }
  return { text: readText(response), model: response.modelVersion || model };
}

/**
 * One answer that matches `schema`, optionally after a Google Search. With `strict`, Gemini is
 * constrained to the JSON schema. Some models can't combine search grounding with a response
 * schema; then the same request runs again with the schema in the prompt and is validated here.
 */
async function structured({ apiKey, model }, { system, prompt, schema, webSearch, strict, maxTokens = 1200 }) {
  if (!model) throw AppError.badRequest('Pick a Google model in Profile → AI', 'AI_MODEL_MISSING');
  const client = clientFor(apiKey);
  const run = (withSchema) =>
    client.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: withSchema ? prompt : `${prompt}\n\nReply with one JSON object matching this JSON schema:\n${JSON.stringify(schema)}` }] }],
      config: {
        systemInstruction: system,
        maxOutputTokens: maxTokens + 8000,
        ...(webSearch && { tools: [{ googleSearch: {} }] }),
        responseMimeType: 'application/json',
        ...(withSchema && { responseJsonSchema: schema }),
      },
    });

  let response;
  let usedSchema = Boolean(strict);
  try {
    response = await run(usedSchema);
  } catch (err) {
    // Search (grounding) has its own, smaller quota. Out of it: answer without searching, and say so.
    if (webSearch && err instanceof ApiError && err.status === 429) {
      const detail = googleDetail(err);
      logger.warn('Gemini search quota used up; answering without search', { quota: detail.quota });
      const plain = await structured({ apiKey, model }, { system, prompt, schema, webSearch: false, strict, maxTokens });
      return { ...plain, searchUnavailable: 'quota' };
    }
    if (!(usedSchema && webSearch && err instanceof ApiError && err.status === 400)) throw toAppError(err);
    usedSchema = false;
    try {
      response = await run(false);
    } catch (retryErr) {
      throw toAppError(retryErr);
    }
  }
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  return {
    text: readText(response),
    sources: chunks.map((c) => c.web).filter((w) => w?.uri).map((w) => ({ title: w.title || w.uri, url: w.uri })),
    searched: chunks.length > 0 || Boolean(response.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length),
    strict: usedSchema,
    model: response.modelVersion || model,
  };
}

async function listModels(apiKey) {
  try {
    const ids = [];
    for await (const m of await clientFor(apiKey, 30_000).models.list()) {
      const id = String(m.name || '').replace(/^models\//, '');
      // Text models only: image ("Nano Banana"), embedding, speech and live-audio models can't write these answers.
      const textModel = !/(embedding|image|banana|tts|audio|live|veo|imagen)/i.test(`${id} ${m.displayName || ''}`);
      if (/^gemini/i.test(id) && textModel && (!m.supportedActions || m.supportedActions.includes('generateContent'))) ids.push(id);
    }
    return ids.sort().reverse();
  } catch (err) {
    throw toAppError(err);
  }
}

module.exports = { DEFAULT_MODEL, chat, structured, listModels };
