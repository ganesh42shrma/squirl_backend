# Squirl — Backend

A lightweight personal finance tracker API. You log expenses and income like rows in a spreadsheet, give them a category and tags, and import SBI or Kotak bank statements through a separate Python parser service.

**Stack:** Node 22, Express 5, MongoDB (Mongoose), Zod, Winston, Multer. Plain JavaScript (CommonJS).

## Getting started

```bash
cp .env.example .env        # adjust MONGO_URI / PARSER_SERVICE_URL if needed
npm install
npm run seed                # default categories + tags (safe to re-run)
npm run dev                 # node --watch, restarts on file changes
```

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `MONGO_URI` | — (required) | MongoDB connection string |
| `NODE_ENV` | `development` | `development` gives pretty logs and stacks for unexpected errors |
| `LOG_LEVEL` | `debug` in dev, `info` otherwise | Winston level |
| `CORS_ORIGIN` | `*` | Allowed origin for the future frontend |
| `PARSER_SERVICE_URL` | `http://127.0.0.1:8000` | Python statement parser |
| `PARSER_TIMEOUT_MS` | `60000` | Timeout for a parse request |

## Folder structure

```
src/
├── server.js        # process lifecycle: connect DB, listen, graceful shutdown
├── app.js           # express app: middleware, routes, 404, error handler
├── config/          # env config + DB connection
├── core/            # shared building blocks (no feature logic)
│   ├── AppError.js       # operational error with statusCode + code
│   ├── errorHandler.js   # global error → { success:false, error:{…} }
│   ├── notFound.js       # unmatched routes → 404
│   ├── validate.js       # validate(zodSchema) middleware
│   ├── schemas.js        # reusable Zod pieces (objectId, pagination)
│   ├── response.js       # sendSuccess(res, data, { status, message, meta })
│   ├── requestLogger.js  # request id + access log line
│   ├── logger.js         # winston → console + logs/app.log + logs/error.log
│   └── upload.js         # multer (PDF, memory, 10MB)
├── plugins/         # one folder per feature
│   ├── index.js          # mounts every plugin under /api
│   └── <feature>/
│       ├── <feature>.model.js       # mongoose schema
│       ├── <feature>.validation.js  # zod request schemas
│       ├── <feature>.service.js     # business logic + DB; throws AppError
│       ├── <feature>.controller.js  # thin: req → service → sendSuccess
│       ├── <feature>.routes.js      # path + validate + controller
│       └── <feature>.helper.js      # pure helper functions
└── scripts/         # one-off scripts; data/ holds the default categories and tags
```

Express 5 forwards rejected promises to the error handler on its own, so controllers are plain `async` functions with no try/catch and no asyncHandler wrapper.

### Adding a feature
Create `src/plugins/<feature>/` with the files above, then add one line to `src/plugins/index.js`:
```js
router.use('/<feature>', require('./<feature>/<feature>.routes'));
```

## Response format

```jsonc
// success
{ "success": true, "message": "Transaction created", "data": { … }, "meta": { "page": 1, "limit": 50, "total": 120, "pages": 3 } }

// error
{ "success": false, "error": { "message": "Validation failed", "code": "VALIDATION_ERROR", "details": [ { "path": "body.amount", "message": "…" } ], "requestId": "…" } }
```

Every response carries an `X-Request-Id` header. The same id appears in the logs.

## API

All routes are prefixed with `/api`.

### Health
| Method | Path | |
|---|---|---|
| GET | `/health` | `{ status, db, uptimeSeconds }` |

### Categories
Categories go two levels deep: a top-level category (e.g. **Food & Drinks**) with subcategories (e.g. **Food Delivery**, **Cafes & Coffee**). Every category has a **type**:

| Type | Meaning | Examples |
|---|---|---|
| `expense` | money spent | Food & Drinks, Rent, Subscriptions, Travel |
| `income` | money earned | Salary, Freelancing, Cashback, Interest |
| `investment` | money put to work | SIP, Stocks, FD, PPF, Gold, Emergency Fund |
| `transfer` | moving your own money (not spending) | Credit card bill, account to account, ATM withdrawal |
| `lending` | money with people | Lent to someone, Got paid back, Split bills |

`npm run seed` adds 34 top-level categories with 133 subcategories (see `src/scripts/data/categories.js`).

| Method | Path | |
|---|---|---|
| GET | `/categories` | `?type=` to filter, `?view=tree` (default, parents with `children`) or `?view=flat` |
| POST | `/categories` | `{ name, type?, parent?, color?: "#rrggbb", icon? }` |
| PATCH | `/categories/:id` | any of the above |
| DELETE | `/categories/:id` | 409 `CATEGORY_HAS_CHILDREN` / `CATEGORY_IN_USE` while it has subcategories or transactions |

Rules:
- A subcategory's parent must be top-level. There is no third level.
- A subcategory always takes its parent's type, and its colour too unless you give one. Changing a parent's type updates all its subcategories.
- Names are unique among siblings, so "Other" can exist under Food and under Shopping (409 `CATEGORY_EXISTS` otherwise).
- On transactions, `category` is populated with its parent, so a row can show "Food & Drinks › Food Delivery".

### Tags
Tags cut across categories: a **Dates** expense can also be tagged `splurge` and `weekend`. Transactions store tag names as strings, normalised to lowercase with hyphens (`"Late Night"` becomes `late-night`). The tag catalog adds a **group** and a **colour** to each name.

`npm run seed` adds 34 tags in these groups:
- **nature**: need, want, impulse, splurge, planned
- **people**: solo, friends, family, partner, colleagues, roommates
- **occasion**: birthday, festival, date-night, anniversary, wedding, trip, party, weekend
- **payment**: split, reimbursable, cashback, no-cost-emi, recurring, one-time, refund-pending
- **goals**: self-care, upskilling, health-goal, saving-goal, side-project
- **lifestyle**: late-night, office-day, wfh

| Method | Path | |
|---|---|---|
| GET | `/tags` | `[{ _id, name, group, color, count }]`, optional `?group=`. Tags used on transactions but missing from the catalog appear under `custom` with `_id: null` |
| POST | `/tags` | `{ name, group?, color? }`. Posting a tag that's already in use adds it to the catalog |
| PATCH | `/tags/:id` | rename / regroup / recolour. **A rename also renames the tag on every transaction** |
| DELETE | `/tags/:id` | removes it from the catalog **and from every transaction** |

### Transactions
| Method | Path | |
|---|---|---|
| GET | `/transactions` | list with filters (below) |
| GET | `/transactions/summary` | debit/credit totals per group (see below) |
| POST | `/transactions` | create one row |
| POST | `/transactions/bulk` | `{ transactions: [row, …] }`, up to 1000 |
| PATCH | `/transactions/bulk` | `{ ids: [...], set: { category?, tags?, addTags?, removeTags? } }` |
| GET / PATCH / DELETE | `/transactions/:id` | |

Row body:
```json
{ "date": "2026-10-10", "description": "Dinner", "amount": 450.5, "type": "debit",
  "category": "<categoryId>", "tags": ["friends"], "notes": "…", "account": "upi", "paymentMode": "card" }
```
`type` defaults to `debit`. `amount` is always positive and rounded to 2 decimal places. `account` defaults to `cash`.

List filters (all optional):
- `from` and `to` (`YYYY-MM-DD`, both inclusive)
- `type`
- `category` (an id, or `none` for uncategorized rows). A top-level id also matches its subcategories
- `tag`, `account`, `source` (`manual`|`import`), `importId`
- `search` (matches description, notes and refNo)
- `minAmount`, `maxAmount`
- `sort` (`date`, `-date`, `amount`, `-amount`, `description`, `createdAt`; default `-date`)
- `page`, `limit` (max 500)

Summary query: `from`, `to`, `type`, `account`, `category`, `tag`, `groupBy`. It returns `{ totals: { debit, credit, net, count }, groups: [{ key, label, debit, credit, net, count }] }`.

| `groupBy` | One row per | Example label |
|---|---|---|
| `category` (default) | exact category | `Food & Drinks › Food Delivery` |
| `topCategory` | top-level category, with subcategories rolled up | `Food & Drinks` |
| `categoryType` | expense / income / investment / transfer / lending | `investment` |
| `month` | `YYYY-MM` | `2026-10` |
| `tag` | tag (a row with 2 tags counts in both) | `weekend` |
| `account` | account | `sbi` |

Category groupings also include `categoryType` on each row. Some examples:
- `groupBy=categoryType` shows what you spent, invested and transferred, without a credit card bill being counted as spending.
- `groupBy=category&category=<Food id>` breaks one category down by its subcategories.

### Statement imports
| Method | Path | |
|---|---|---|
| POST | `/imports` | multipart: `file` (PDF), `bank` (`sbi`\|`kotak`), `password?` |
| GET | `/imports` | import history (`page`, `limit`) |
| GET | `/imports/:id` | one import with its stats |
| DELETE | `/imports/:id` | **undo**: deletes the import and every transaction it created |

```bash
curl -X POST localhost:4000/api/imports -F "file=@statement.pdf;type=application/pdf" -F bank=sbi -F password=XXXX
```

How an import works:
1. An `ImportBatch` is created with status `processing`.
2. The PDF is sent to the parser service.
3. Each row is mapped to a transaction (`source: "import"`, `account: <bank>`, no category).
4. Every row gets a fingerprint (`hash` of bank, date, amount, type, refNo, description and running balance). Rows already in the DB are skipped, so re-importing a statement, or one whose period overlaps an earlier one, is safe. Including the running balance means two genuinely identical payments on the same day are both kept.
5. The batch ends as `completed` with `stats: { parsed, inserted, duplicates, skipped }`, or as `failed` with an `error`.

Afterwards you can find the new rows with `GET /transactions?importId=<id>&category=none` and categorise them all at once with `PATCH /transactions/bulk`.

Import errors:
| Status | Code | When |
|---|---|---|
| 503 | `PARSER_UNAVAILABLE` | parser unreachable or timed out |
| 422 | `STATEMENT_PARSE_FAILED` | parser rejected the file (e.g. wrong password); its `error` message is passed through |
| 502 | `PARSER_BAD_RESPONSE` | parser replied with a shape that doesn't match the contract |

## Parser service contract

The Python service has to implement one endpoint:

```
POST /parse
Content-Type: multipart/form-data
  file      the statement PDF
  bank      "sbi" | "kotak"
  password  optional PDF password
```

Success, `200`:
```json
{
  "bank": "sbi",
  "periodFrom": "2026-09-01",
  "periodTo": "2026-09-30",
  "transactions": [
    { "date": "2026-09-03", "description": "UPI/DR/123/SWIGGY", "refNo": "U1",
      "debit": 250.0, "credit": 0, "balance": 9750.0 }
  ]
}
```
- `date` must be `YYYY-MM-DD`.
- Each row fills exactly one of `debit` / `credit` (the other is `0` or `null`).
- `refNo`, `balance`, `periodFrom` and `periodTo` are optional, but `balance` is strongly recommended because it improves duplicate detection.

Failure, any `4xx`/`5xx`:
```json
{ "error": "Incorrect PDF password" }
```

## Logging
- **Console:** colourised and readable in development, JSON otherwise.
- **`logs/app.log`:** everything at `LOG_LEVEL` and above, as JSON.
- **`logs/error.log`:** errors only.

Every request is logged as `METHOD url status durationMs` with its `requestId`. 4xx responses log at `warn` and 5xx at `error`, with the stack.
