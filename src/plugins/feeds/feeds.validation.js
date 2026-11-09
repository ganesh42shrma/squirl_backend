const { z } = require('zod');
const { SECTIONS, TMDB_LISTS } = require('./sources');

const apiKey = z.string().trim().min(8).max(200).regex(/^\S+$/, 'An API key has no spaces');
const search = z.object({ query: z.object({ q: z.string().trim().min(2).max(60) }) });

const update = z.object({
  body: z
    .object({
      enabled: z
        .object({ weather: z.boolean(), rates: z.boolean(), inflation: z.boolean(), funds: z.boolean(), stocks: z.boolean(), crypto: z.boolean(), news: z.boolean(), movies: z.boolean(), cricket: z.boolean() })
        .partial()
        .optional(),
      location: z
        .object({
          name: z.string().trim().min(1).max(80),
          region: z.string().trim().max(120).default(''),
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
        })
        .nullable()
        .optional(),
      currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).max(8).optional(),
      funds: z
        .array(z.object({ code: z.string().regex(/^\d{3,8}$/), name: z.string().trim().min(1).max(200), units: z.number().min(0).max(1e9).nullable().default(null) }))
        .max(30)
        .optional(),
      stocks: z
        .object({
          symbols: z
            .array(
              z.object({
                symbol: z.string().trim().regex(/^[A-Za-z0-9.\-^=]{1,24}$/, 'Invalid symbol'),
                name: z.string().trim().max(200).nullable().optional(),
                exchange: z.string().trim().max(40).nullable().optional(),
                currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
                units: z.number().min(0).max(1e9).nullable().optional(),
              }),
            )
            .max(5, 'Up to five symbols: the free plan allows 100 requests a month'),
          budget: z.number().int().min(1).max(1_000_000),
        })
        .partial()
        .optional(),
      coins: z.array(z.string().regex(/^[a-z0-9-]{1,80}$/)).max(12).optional(),
      news: z.object({ section: z.enum(SECTIONS).optional(), query: z.string().trim().max(80).optional() }).optional(),
      keys: z
        .object({
          guardian: apiKey.nullable().optional(),
          coingecko: apiKey.nullable().optional(),
          tmdb: z.string().trim().min(16).max(600).regex(/^\S+$/, 'An API key has no spaces').nullable().optional(), // v3 key or v4 token
          cricket: apiKey.nullable().optional(),
          marketstack: apiKey.nullable().optional(),
        })
        .optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
});

const titles = z.object({
  params: z.object({ list: z.enum(Object.keys(TMDB_LISTS)) }),
  query: z.object({ page: z.coerce.number().int().min(1).max(20).default(1) }),
});

const watch = z.object({
  body: z
    .object({
      tmdbId: z.number().int().positive(),
      mediaType: z.enum(['movie', 'tv']),
      title: z.string().trim().min(1).max(200).optional(),
      poster: z.string().url().startsWith('https://image.tmdb.org/').nullable().optional(),
      overview: z.string().max(600).nullable().optional(),
      year: z.number().int().min(1870).max(2100).nullable().optional(),
      rating: z.number().min(0).max(10).nullable().optional(),
      anime: z.boolean().optional(),
      starred: z.boolean().optional(),
      list: z.enum(['must_watch', 'watch_later']).nullable().optional(),
    })
    .refine((b) => b.starred !== undefined || b.list !== undefined, 'Nothing to change'),
});

module.exports = { update, search, titles, watch };
