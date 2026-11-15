const { z } = require('zod');
const { idParams } = require('../../core/schemas');

// Never allow a saved push endpoint to become an arbitrary server-side HTTP request.
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
const endpoint = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password
      && !url.hash && PUSH_HOSTS.has(url.hostname) && url.pathname.length > 1;
  } catch { return false; }
}, 'Unsupported push service');
const key = (bytes) => z.string().regex(/^[A-Za-z0-9_-]+$/).refine((s) => Buffer.from(s, 'base64url').length === bytes, 'Invalid subscription key');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const preferences = z.object({
  tasks: z.boolean().default(true),
  habits: z.boolean().default(true),
  bills: z.boolean().default(true),
  smsPayments: z.boolean().default(true),
  dailyTime: time.default('09:00'),
  habitTime: time.default('20:00'),
});
const device = z.object({ body: z.object({ endpoint: endpoint.nullable().optional() }) });
const subscribe = z.object({ body: z.object({
  subscription: z.object({ endpoint, keys: z.object({ p256dh: key(65), auth: key(16) }) }),
  preferences,
}) });
const byEndpoint = z.object({ body: z.object({ endpoint }) });
const payment = z.object({ params: idParams });
const paymentReply = z.object({ params: idParams, body: z.object({ note: z.string().trim().min(1).max(500) }).strict() });
module.exports = { device, subscribe, byEndpoint, payment, paymentReply };
