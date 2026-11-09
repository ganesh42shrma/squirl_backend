# Squirl — Backend

A lightweight personal finance tracker API. You log expenses and income like rows in a spreadsheet, give them a category and tags, and import SBI or Kotak bank statements through a separate Python parser service.

**Stack:** Node 22+, Express 5, SQLite encrypted with SQLCipher (`better-sqlite3-multiple-ciphers`), Zod, Winston, Multer. Plain JavaScript (CommonJS).

## Getting started

```bash
cp .env.example .env        # adjust DB_PATH / PARSER_SERVICE_URL if needed
npm install
npm run db:key              # once: creates the database key in your macOS Keychain
npm run db:key -- --show    # print it and save a copy in your password manager
npm run llm                 # optional, own terminal: local model for summaries and category suggestions
npm run dev                 # node --watch, restarts on file changes
```

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `DB_PATH` | `/Volumes/mushroom/squirl/squirl.db` | Encrypted SQLite file (the "mushroom" pendrive) |
| `DB_KEY` | — | Database key. Leave unset to read it from the macOS Keychain (service `squirl-db`) |
| `NODE_ENV` | `development` | `development` gives pretty logs and stacks for unexpected errors |
| `LOG_LEVEL` | `debug` in dev, `info` otherwise | Winston level |
| `CORS_ORIGIN` | `http://localhost:5173` | The frontend's exact origin (cookies are only sent to it) |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Sessions and sign-in rate limits |
| `COOKIE_SECURE` | `false` | `true` when served over HTTPS |
| `SESSION_SECRET` | derived from the DB key | Signs the session cookie |
| `ALLOW_REGISTRATION` | `true` | Turn off once everyone who should have an account has one |
| `APP_URL` | `http://localhost:5173` | Used in password-reset links |
| `PARSER_SERVICE_URL` | `http://127.0.0.1:8000` | Python statement parser |
| `PARSER_TIMEOUT_MS` | `60000` | Timeout for a parse request |

## Folder structure

```
src/
├── server.js        # process lifecycle: open DB, listen, graceful shutdown
├── app.js           # express app: middleware, routes, 404, error handler
├── config/          # env config, DB connection (db.js), key lookup (dbKey.js), schema (migrations.js)
├── core/            # shared building blocks (no feature logic)
│   ├── AppError.js       # operational error with statusCode + code
│   ├── errorHandler.js   # global error → { success:false, error:{…} }
│   ├── notFound.js       # unmatched routes → 404
│   ├── validate.js       # validate(zodSchema) middleware
│   ├── schemas.js        # reusable Zod pieces (entityId, pagination)
│   ├── sql.js            # ids, paise/date conversion, insertRow/updateRow
│   ├── response.js       # sendSuccess(res, data, { status, message, meta })
│   ├── requestLogger.js  # request id + access log line
│   ├── logger.js         # winston → console + logs/app.log + logs/error.log
│   └── upload.js         # multer (PDF, memory, 10MB)
├── plugins/         # one folder per feature
│   ├── index.js          # mounts every plugin under /api
│   └── <feature>/
│       ├── <feature>.model.js       # constants, row → API mapping, insert helpers
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

## Storage

All data lives in one SQLite file, encrypted with SQLCipher (v4 format), on the `mushroom` pendrive.

- **Encryption.** The drive is plain exFAT, so the file itself is encrypted: without the key it is random bytes.
  The key is a random 256-bit value in the macOS Keychain on this laptop, never on the drive.
  **Back it up** (`npm run db:key -- --show` → password manager): losing it means losing the data.
- **Drive not plugged in.** The server refuses to start (`Database location /Volumes/mushroom not found`)
  instead of creating a database on the internal disk. If the drive disappears while running, requests fail
  with `503 DB_UNAVAILABLE`, and `GET /health` shows `db: "unavailable"`.
- **Safe on removable media.** Rollback-journal mode with `synchronous=FULL`: every write is on the drive before
  the request returns, and when idle the database is a single self-contained file. Stop the server
  (Ctrl+C) and eject the drive before unplugging it.
- **Backups.** Copy `squirl.db` while the server is stopped. The copy stays encrypted with the same key.
- **Inspecting it.** Any SQLCipher 4 tool works, e.g. `sqlcipher squirl.db` then `PRAGMA key = '<key>';`.
- **Schema.** `src/config/migrations.js`. Applied migrations are counted in `PRAGMA user_version`; to change the
  schema, append a new migration (never edit a shipped one).
- **Money** is stored as integer paise (`amount_paise`, `balance_paise`) so sums are exact. The API uses rupees.
- **Dates** are stored as `YYYY-MM-DD`. The API returns them as `YYYY-MM-DDT00:00:00.000Z`, as before.
- **Ids** are 24-character hex strings.
- **Atomic writes.** Bulk create, imports, tag renames and import undo each run in one SQLite transaction.
- **Migrations run with foreign keys off**, set explicitly (better-sqlite3 turns them on by default), because a table
  rebuild drops the old table, and with foreign keys on that `DROP` would cascade-delete dependent rows. Every
  reference is checked (`PRAGMA foreign_key_check`) before they're switched back on.

## Accounts and sign-in

Redis must be running (`brew services start redis`). There are no default users: open the app and sign up.
**The first account adopts all data that existed before accounts did**; every account gets its own default
categories and tags (`npm run seed -- you@example.com` re-adds any you deleted).

**Sessions, not tokens.** Signing in stores `{ userId }` in Redis under a random session id; the browser holds only
that id in a cookie that is `HttpOnly` (unreadable from JavaScript), `SameSite=Strict` (never sent from other
sites) and `Secure` when `COOKIE_SECURE=true`. Sessions last a week, extended on use, and can be revoked
server-side at any time: signing out deletes the session; changing or resetting the password ends every
other session (each session remembers the password's `password_changed_at`, and a mismatch signs it out).

| Protection | How |
|---|---|
| Passwords | `scrypt` (N=2¹⁶, r=8, built into Node), salted, constant-time compare; 10+ characters |
| Guessing | Redis counters: 10 tries per email+IP and 50 per IP per 15 min (`429 TOO_MANY_ATTEMPTS`) |
| Account discovery | Same message and same timing whether or not an email exists (sign-in and reset) |
| Session fixation | A new session id at every sign-in |
| CSRF | Every write needs `X-Requested-With: squirl` (a cross-site page can't add it), on top of SameSite=Strict |
| Password reset | One-time 256-bit token, only its SHA-256 stored in Redis, 30 min, used once (`GETDEL`) |

**Password reset email:** no mail server is configured yet. In development the reset link is printed in the
backend's terminal (never in the log files); `src/core/mailer.js` is the one function to replace with real SMTP.

| Method | Path | |
|---|---|---|
| POST | `/auth/register` | `{ name, email, password }` → signs in |
| POST | `/auth/login` | `{ email, password }` |
| POST | `/auth/logout` | |
| GET | `/auth/me` | the signed-in user, or 401 |
| POST | `/auth/password/forgot` | `{ email }` → always 200 |
| POST | `/auth/password/reset` | `{ token, password }` → signs in, ends other sessions |
| GET / PATCH / DELETE | `/users/me` | profile with stats / `{ name?, email? }` / `{ password }` deletes the account and all its data |
| POST | `/users/me/password` | `{ currentPassword, newPassword }` |

Everything else requires a session (`401 AUTH_REQUIRED` otherwise).

### Multi-tenancy

Every table has a `user_id`, and uniqueness is per account: two people can import the same statement (duplicate
detection is per account) or both have a "Food" category. Isolation is enforced in the services:

- every query filters on `user_id`, and the shared transaction filter (`buildFilter`) can't be built without one;
- ids from another account behave as if they don't exist (404), including as a category on your own rows;
- joins to categories and tags also match on `user_id`.

All accounts share one SQLCipher file and key, so the isolation is enforced by the app, not by separate
encryption per person. A scratch-database test signs up two accounts and tries every endpoint across them.

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
| GET | `/health` | `{ status, db: "connected" \| "unavailable" \| "disconnected", uptimeSeconds }` |

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
- `page` (default 1), `limit` (default 30, max 200). The ledger offers 30, 50, 100 and 200 rows per page.

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
| POST | `/imports` | multipart: `file` (PDF), `bank?` (`auto` (default)\|`sbi`\|`kotak`), `password?` |
| GET | `/imports` | import history (`page`, `limit`) |
| GET | `/imports/:id` | one import with its stats |
| DELETE | `/imports/:id` | **undo**: deletes the import and every transaction it created |

```bash
curl -X POST localhost:4000/api/imports -F "file=@statement.pdf;type=application/pdf" -F bank=sbi -F password=XXXX
```

How an import works:
1. An import row is created with status `processing` (its `bank` stays `null` until known when `bank=auto`).
2. The PDF is sent to the parser service. With `bank=auto` the parser works out SBI or Kotak from the first page.
3. Each row is mapped to a transaction (`source: "import"`, `account: <detected bank>`, no category).
4. Every row gets a fingerprint (`hash` of bank, date, amount, type, refNo, description and running balance). Rows already in the DB are skipped, so re-importing a statement, or one whose period overlaps an earlier one, is safe. Including the running balance means two genuinely identical payments on the same day are both kept.
5. New rows are inserted in a single SQLite transaction (all or none). The batch ends as `completed` with `stats: { parsed, inserted, duplicates, skipped }` and `newFrom`/`newTo` (the date range of the rows it actually added), or as `failed` with an `error`.

So overlapping statements just work: import Jul–Sep today and Aug–Oct tomorrow, and the second import adds only
October's rows (`inserted` = October, `duplicates` = Aug–Sep). Undoing an import removes only the rows it added.

Afterwards you can find the new rows with `GET /transactions?importId=<id>&category=none` and categorise them all at once with `PATCH /transactions/bulk`.

Import errors:
| Status | Code | When |
|---|---|---|
| 503 | `PARSER_UNAVAILABLE` | parser unreachable or timed out |
| 422 | `STATEMENT_PARSE_FAILED` | parser rejected the file (e.g. wrong password); its `error` message is passed through |
| 502 | `PARSER_BAD_RESPONSE` | parser replied with a shape that doesn't match the contract |

### Insights
| Method | Path | |
|---|---|---|
| GET | `/insights/balances` | per-account and combined balance history (`from`, `to` trim the points) |
| GET | `/insights/history` | month-by-month figures, highlights, top categories, largest rows (`from`, `to`; default: all data) |
| POST | `/insights/history/summary` | `{ from?, to? }` → a few sentences written by the local model, with `check` (see below) |
| POST | `/insights/suggest-categories` | `{ ids?, limit? }` → suggested categories for unsorted rows, grouped by merchant (nothing is saved) |
| GET | `/insights/llm` | `{ available, model }`: is a local model reachable |

**Balances** come from the running balance printed on imported statement rows (manual rows have none).
Each account's rows are walked in statement order. Day-end balances become the points, and wherever
`previous balance ± amount ≠ printed balance` there is a **gap**: rows missing between two dates, i.e. a statement
period that was never imported. Gaps are returned per account (`gaps: [{ from, to, days }]`) and shown on the dashboard.
The **combined** series sums each account's last known balance and starts only when every account has data
(`total.since`), so an account appearing later doesn't look like money arriving.

**History figures** follow the frontend's month figures: spent = expense debits (net of refunds) plus unsorted debits,
earned = income credits plus unsorted credits; transfers between your own accounts count as neither.
Sums are done in paise, so they're exact. `highlights` are finished sentences (kept, average month, best and
heaviest months, biggest category, balance change, largest single spend).

### Local model (optional): grounded analysis with local reasoning

The summary uses a senior financial analyst brief: interpret patterns, explain trade-offs and suggest prioritized actions from recorded activity. Reasoning is enabled with an extra token allowance; only the final answer is shown. Every balance,
total, average and percentage is computed by this backend (in paise, exactly). The model gets two jobs it is
good at, and the code checks its work:

| Job | What the model gets | What the code checks |
|---|---|---|
| **Write a period up** (`POST /insights/history/summary`) | Aggregates only: monthly totals, category totals, balances and highlights, already formatted as ₹ strings. Never individual transactions. | Every ₹ amount and % in the text must appear in those facts (`numbers.js`; "₹4.2 lakh" passes if a fact rounds to it). If one doesn't, the model is told which numbers are wrong and rewrites once. If it still invents one, the summary comes back with `check: { ok: false, unverified: [...] }` and the UI flags those numbers. Only verified summaries are cached. |
| **Suggest categories** (`POST /insights/suggest-categories`) | Descriptions of up to 25 unsorted merchants (repeats such as different UPI refs to the same shop are asked once) and your numbered category list. No amounts. | The answer must be JSON naming real category numbers; anything else is dropped. Money out is never filed as income; money in filed as an expense becomes a low-confidence guess (only a refund fits). Nothing is saved: the person reviews and applies through `PATCH /transactions/bulk`. |

Without a model, both return `503 LLM_UNAVAILABLE` and the rest of the app is unaffected.

**Running it.** Squirl runs its *own* Ollama server, separate from the Ollama app, with the model on the pendrive:

```bash
npm run llm     # starts it on 127.0.0.1:11435, models in /Volumes/mushroom/models; pulls qwen3.5:9b the first time (~6.5 GB)
```

Keep it running in its own terminal next to `npm run dev`; Ctrl+C stops it. Your regular Ollama (port 11434) and its
models are untouched. On start it loads the model into memory, **about 3 minutes from the USB stick** (6.6 GB at
~35 MB/s), and keeps it there (~7 GB of RAM) until you stop the server; `GET /insights/llm` reports `loaded`, and a
request sent while it's loading waits (timeout 5 minutes) instead of failing. Once loaded, a summary takes ~6–9 s
and a batch of category suggestions ~12 s on an M-series Mac.
Thinking mode is switched off (`reasoning_effort: none`): rephrasing and labelling don't benefit from it, and it would
add minutes per answer on a laptop.

| Env var | Default | |
|---|---|---|
| `LLM_URL` | `http://127.0.0.1:11435` | any OpenAI-compatible server (Ollama, llama-server, LM Studio) |
| `LLM_MODEL` | `qwen3.5:9b` | model name; `npm run llm` pulls this one |
| `LLM_TIMEOUT_MS` | `300000` | covers a cold start while the model loads |
| `SQUIRL_MODELS_DIR` | `/Volumes/mushroom/models` | where `npm run llm` keeps models |

## Parser service contract

The parser lives in `../squirl_parser` (FastAPI). Start it with
`cd ../squirl_parser && uv run uvicorn app.main:app --port 8000`. It implements:

```
POST /parse
Content-Type: multipart/form-data
  file      the statement PDF
  bank      "sbi" | "kotak" | "auto"
  password  optional PDF password
```

Success, `200`:
```json
{
  "bank": "sbi",
  "periodFrom": "2026-09-01",
  "periodTo": "2026-09-30",
  "transactions": [
    { "date": "2026-09-03", "description": "WDL TFR UPI/DR/123/SWIGGY", "refNo": "123",
      "debit": 250.0, "credit": null, "balance": 9750.0 }
  ],
  "summary": { "opening": 10000.0, "closing": 9750.0, "count": 1,
               "totalDebits": 250.0, "totalCredits": 0.0, "parserVersion": "sbi-1" }
}
```
- `date` must be `YYYY-MM-DD`.
- Each row fills exactly one of `debit` / `credit` (the other is `0` or `null`).
- `refNo`, `balance`, `periodFrom` and `periodTo` are optional, but `balance` is strongly recommended because it improves duplicate detection.
- `summary` is informational. The backend ignores it.
- The parser only returns `200` when every running balance, the opening/closing balance and any printed totals reconcile. It never returns partial data.

Failure, `4xx`/`5xx`:
```json
{ "error": "Incorrect PDF password", "code": "WRONG_PASSWORD" }
```
`error` is shown to the user. `code` is passed to the frontend as `details.parserCode` on a
`422 STATEMENT_PARSE_FAILED`. Codes: `INVALID_FILE`, `UNSUPPORTED_BANK`, `INVALID_REQUEST` (400);
`PASSWORD_REQUIRED`, `WRONG_PASSWORD` (401); `BANK_MISMATCH`, `BANK_UNKNOWN`, `NO_TEXT_LAYER`, `UNSUPPORTED_LAYOUT`,
`RECONCILIATION_FAILED` (422). A parser `5xx` becomes `502 PARSER_ERROR`.

**The way the parser builds `description` is frozen.** `makeHash` includes it, so changing it
would stop re-imported statements from being recognised as duplicates.

## Logging
- **Console:** colourised and readable in development, JSON otherwise.
- **`logs/app.log`:** everything at `LOG_LEVEL` and above, as JSON.
- **`logs/error.log`:** errors only.

Every request is logged as `METHOD url status durationMs` with its `requestId`. 4xx responses log at `warn` and 5xx at `error`, with the stack.
