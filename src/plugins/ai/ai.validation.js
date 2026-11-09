const { z } = require('zod');
const { MODES, PROVIDER_NAMES } = require('./ai.service');
const { GUARD_MODELS } = require('./guard');

const provider = z.enum(PROVIDER_NAMES);
const modelId = z.string().trim().min(1).max(100).regex(/^[\w.:/-]+$/, 'Invalid model id');
// Gemini IDs are lowercase letters, digits, dots and dashes (gemini-3.5-flash), never display names.
const googleModelId = z.string().trim().regex(/^[a-z0-9][a-z0-9.-]*$/, 'Use the model ID shown in the list, e.g. gemini-3.5-flash');
const apiKey = z.string().trim().min(10).max(400).regex(/^\S+$/, 'An API key has no spaces');

const update = z.object({
  body: z
    .object({
      mode: z.enum(MODES).optional(),
      provider: provider.optional(),
      models: z.object({ anthropic: modelId.optional(), openai: modelId.optional(), google: googleModelId.optional(), groq: modelId.optional() }).optional(),
      keys: z.object({ anthropic: apiKey.nullable().optional(), openai: apiKey.nullable().optional(), google: apiKey.nullable().optional(), groq: apiKey.nullable().optional() }).optional(),
      webSearch: z.boolean().optional(),
      strict: z.boolean().optional(),
      guard: z.object({ enabled: z.boolean().optional(), model: z.enum(GUARD_MODELS).optional() }).optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
});

const models = z.object({ query: z.object({ provider }) });
const test = z.object({ body: z.object({ provider: provider.optional() }).default({}) });

module.exports = { update, models, test };
