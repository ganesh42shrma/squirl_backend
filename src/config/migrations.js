// Schema migrations, applied in order. PRAGMA user_version records how many have run.
// Each is SQL, or a function (conn) => void for data changes that need code.
// Never edit a migration that has shipped: add a new one to the end instead.
const { counterparty, isUsableKey } = require('../plugins/rules/rules.helper');

module.exports = [
  // v1: initial schema
  `
  CREATE TABLE categories (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'expense'
                CHECK (type IN ('expense', 'income', 'investment', 'transfer', 'lending')),
    parent_id   TEXT REFERENCES categories(id) ON DELETE RESTRICT,  -- NULL for a top-level category
    color       TEXT NOT NULL DEFAULT '#9ca3af',
    icon        TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  -- Names are unique among siblings. ifnull() because UNIQUE treats NULL parents as all different.
  CREATE UNIQUE INDEX categories_parent_slug ON categories (ifnull(parent_id, ''), slug);

  CREATE TABLE tags (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    group_name  TEXT NOT NULL DEFAULT 'custom',
    color       TEXT NOT NULL DEFAULT '#9ca3af',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX tags_group_name ON tags (group_name, name);

  CREATE TABLE imports (
    id          TEXT PRIMARY KEY,
    bank        TEXT NOT NULL CHECK (bank IN ('sbi', 'kotak')),
    file_name   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
    parsed      INTEGER NOT NULL DEFAULT 0,
    inserted    INTEGER NOT NULL DEFAULT 0,
    duplicates  INTEGER NOT NULL DEFAULT 0,
    skipped     INTEGER NOT NULL DEFAULT 0,
    period_from TEXT,
    period_to   TEXT,
    error       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX imports_created_at ON imports (created_at DESC);

  CREATE TABLE transactions (
    id            TEXT PRIMARY KEY,
    date          TEXT NOT NULL,                                -- YYYY-MM-DD
    description   TEXT NOT NULL,
    amount_paise  INTEGER NOT NULL CHECK (amount_paise >= 0),
    type          TEXT NOT NULL CHECK (type IN ('debit', 'credit')),
    category_id   TEXT REFERENCES categories(id) ON DELETE RESTRICT,
    notes         TEXT,
    account       TEXT NOT NULL DEFAULT 'cash',
    payment_mode  TEXT,
    source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import')),
    import_id     TEXT REFERENCES imports(id) ON DELETE CASCADE,
    ref_no        TEXT,
    balance_paise INTEGER,
    hash          TEXT UNIQUE,                                  -- imported rows only; NULLs don't collide
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX transactions_date ON transactions (date DESC);
  CREATE INDEX transactions_category_date ON transactions (category_id, date DESC);
  CREATE INDEX transactions_import ON transactions (import_id);

  -- Tag names on a transaction (rowid keeps the order they were added in).
  CREATE TABLE transaction_tags (
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    tag            TEXT NOT NULL,
    PRIMARY KEY (transaction_id, tag)
  );
  CREATE INDEX transaction_tags_tag ON transaction_tags (tag);
  `,

  // v2: bank can be unknown until the parser detects it (bank=auto); record the date range of the
  // rows an import actually added. SQLite can't alter a CHECK, so the table is rebuilt.
  // Runs with foreign keys off (see db.js), so dropping the old table doesn't cascade to transactions.
  `
  CREATE TABLE imports_v2 (
    id          TEXT PRIMARY KEY,
    bank        TEXT CHECK (bank IS NULL OR bank IN ('sbi', 'kotak')),
    file_name   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
    parsed      INTEGER NOT NULL DEFAULT 0,
    inserted    INTEGER NOT NULL DEFAULT 0,
    duplicates  INTEGER NOT NULL DEFAULT 0,
    skipped     INTEGER NOT NULL DEFAULT 0,
    period_from TEXT,
    period_to   TEXT,
    new_from    TEXT,                                           -- first / last date among the rows added
    new_to      TEXT,
    error       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  INSERT INTO imports_v2 (id, bank, file_name, status, parsed, inserted, duplicates, skipped,
                          period_from, period_to, error, created_at, updated_at)
    SELECT id, bank, file_name, status, parsed, inserted, duplicates, skipped,
           period_from, period_to, error, created_at, updated_at FROM imports;
  DROP TABLE imports;
  ALTER TABLE imports_v2 RENAME TO imports;
  CREATE INDEX imports_created_at ON imports (created_at DESC);

  -- Balance history reads every account's rows in statement order.
  CREATE INDEX transactions_account_date ON transactions (account, date) WHERE balance_paise IS NOT NULL;
  `,

  // v3: merchant memory. Categorising an imported row teaches "this merchant → this category";
  // later imports from that merchant arrive already sorted, flagged as automatic until confirmed.
  `
  CREATE TABLE merchant_rules (
    id            TEXT PRIMARY KEY,
    direction     TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),  -- money out and in are learned separately
    merchant_key  TEXT NOT NULL,                                          -- description without refs, handles, digits
    example       TEXT NOT NULL,                                          -- a description it was learned from
    category_id   TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    hits          INTEGER NOT NULL DEFAULT 0,                             -- rows it has sorted automatically
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (direction, merchant_key)
  );
  CREATE INDEX merchant_rules_category ON merchant_rules (category_id);

  ALTER TABLE transactions ADD COLUMN auto_categorized INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE imports ADD COLUMN auto_categorized INTEGER NOT NULL DEFAULT 0;
  `,

  // v4: accounts and multi-tenancy. Every row belongs to a user; uniqueness is per user
  // (two people can import the same statement or both have a "Food" category).
  // Rows from before this migration have user_id NULL until the first account adopts them.
  // Tables whose UNIQUE constraints change are rebuilt (foreign keys are off during migrations).
  `
  CREATE TABLE users (
    id                  TEXT PRIMARY KEY,
    email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name                TEXT NOT NULL,
    password_hash       TEXT NOT NULL,
    password_changed_at TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  );

  -- categories: unique (user, parent, slug)
  DROP INDEX categories_parent_slug;
  ALTER TABLE categories ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
  CREATE UNIQUE INDEX categories_user_parent_slug ON categories (user_id, ifnull(parent_id, ''), slug);
  CREATE INDEX categories_user ON categories (user_id, type);

  -- tags: unique (user, name)
  CREATE TABLE tags_v4 (
    id          TEXT PRIMARY KEY,
    user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    group_name  TEXT NOT NULL DEFAULT 'custom',
    color       TEXT NOT NULL DEFAULT '#9ca3af',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (user_id, name)
  );
  INSERT INTO tags_v4 (id, name, group_name, color, created_at, updated_at)
    SELECT id, name, group_name, color, created_at, updated_at FROM tags;
  DROP TABLE tags;
  ALTER TABLE tags_v4 RENAME TO tags;
  CREATE INDEX tags_user_group ON tags (user_id, group_name, name);

  -- imports
  ALTER TABLE imports ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
  DROP INDEX imports_created_at;
  CREATE INDEX imports_user_created ON imports (user_id, created_at DESC);

  -- transactions: hash unique per user
  CREATE TABLE transactions_v4 (
    id               TEXT PRIMARY KEY,
    user_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
    date             TEXT NOT NULL,
    description      TEXT NOT NULL,
    amount_paise     INTEGER NOT NULL CHECK (amount_paise >= 0),
    type             TEXT NOT NULL CHECK (type IN ('debit', 'credit')),
    category_id      TEXT REFERENCES categories(id) ON DELETE RESTRICT,
    notes            TEXT,
    account          TEXT NOT NULL DEFAULT 'cash',
    payment_mode     TEXT,
    source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import')),
    import_id        TEXT REFERENCES imports(id) ON DELETE CASCADE,
    ref_no           TEXT,
    balance_paise    INTEGER,
    hash             TEXT,
    auto_categorized INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE (user_id, hash)
  );
  INSERT INTO transactions_v4 (id, date, description, amount_paise, type, category_id, notes, account, payment_mode,
                               source, import_id, ref_no, balance_paise, hash, auto_categorized, created_at, updated_at)
    SELECT id, date, description, amount_paise, type, category_id, notes, account, payment_mode,
           source, import_id, ref_no, balance_paise, hash, auto_categorized, created_at, updated_at
    FROM transactions ORDER BY rowid;  -- keeps insertion order, which balance history relies on
  DROP TABLE transactions;
  ALTER TABLE transactions_v4 RENAME TO transactions;
  CREATE INDEX transactions_user_date ON transactions (user_id, date DESC);
  CREATE INDEX transactions_user_category_date ON transactions (user_id, category_id, date DESC);
  CREATE INDEX transactions_import ON transactions (import_id);
  CREATE INDEX transactions_user_account_date ON transactions (user_id, account, date) WHERE balance_paise IS NOT NULL;

  -- transaction_tags: carry user_id so every tag query can be scoped without a join
  ALTER TABLE transaction_tags ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
  DROP INDEX transaction_tags_tag;
  CREATE INDEX transaction_tags_user_tag ON transaction_tags (user_id, tag);

  -- merchant_rules: unique (user, direction, merchant)
  CREATE TABLE merchant_rules_v4 (
    id            TEXT PRIMARY KEY,
    user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
    direction     TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
    merchant_key  TEXT NOT NULL,
    example       TEXT NOT NULL,
    category_id   TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    hits          INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (user_id, direction, merchant_key)
  );
  INSERT INTO merchant_rules_v4 (id, direction, merchant_key, example, category_id, hits, created_at, updated_at)
    SELECT id, direction, merchant_key, example, category_id, hits, created_at, updated_at FROM merchant_rules;
  DROP TABLE merchant_rules;
  ALTER TABLE merchant_rules_v4 RENAME TO merchant_rules;
  CREATE INDEX merchant_rules_category ON merchant_rules (category_id);
  `,

  // v5: model category suggestions, saved per merchant so the same merchant always gets the same
  // answer (the model is asked once). category_id NULL + confidence 'none' = the model had no answer,
  // remembered so it isn't asked again. status: pending → applied (rows sorted) or dismissed.
  `
  CREATE TABLE merchant_suggestions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    direction     TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
    merchant_key  TEXT NOT NULL,
    merchant      TEXT NOT NULL,                                -- display name
    example       TEXT NOT NULL,                                -- one description, for context
    category_id   TEXT REFERENCES categories(id) ON DELETE CASCADE,
    confidence    TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low', 'none')),
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
    model         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (user_id, direction, merchant_key)
  );
  CREATE INDEX merchant_suggestions_user_status ON merchant_suggestions (user_id, status);
  `,

  // v6: merchant keys now come from the counterparty (name + UPI handle) instead of the whole
  // description, so remarks like "Payment from" vs "NA" no longer split one merchant. Re-key the
  // learned rules from their stored example; if two rules collapse into one key, the newest wins.
  (conn) => {
    const rules = conn.prepare('SELECT id, user_id, direction, example, updated_at FROM merchant_rules ORDER BY updated_at DESC').all();
    const seen = new Set();
    const update = conn.prepare('UPDATE merchant_rules SET merchant_key = ? WHERE id = ?');
    const remove = conn.prepare('DELETE FROM merchant_rules WHERE id = ?');
    // Two passes avoid tripping UNIQUE while keys are being swapped.
    for (const r of rules) update.run(`__rekey__${r.id}`, r.id);
    for (const r of rules) {
      const key = counterparty(r.example).key;
      const slot = `${r.user_id}|${r.direction}|${key}`;
      if (!isUsableKey(key) || seen.has(slot)) remove.run(r.id);
      else {
        seen.add(slot);
        update.run(key, r.id);
      }
    }
  },

  // v7: loans, EMIs, subscriptions and other auto-debits ("commitments"). Money in paise; the rate
  // is an annual percentage. The paid/outstanding figures are the person's own, as of balance_as_of.
  // match_key links it to a statement merchant, so each due date can be checked against real payments.
  `
  CREATE TABLE commitments (
    id                    TEXT PRIMARY KEY,
    user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind                  TEXT NOT NULL CHECK (kind IN ('loan', 'subscription', 'auto_debit')),
    name                  TEXT NOT NULL,
    lender                TEXT,
    amount_paise          INTEGER CHECK (amount_paise IS NULL OR amount_paise > 0),    -- EMI / charge per period
    frequency             TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
    due_day               INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
    start_date            TEXT NOT NULL,
    end_date              TEXT,
    principal_paise       INTEGER CHECK (principal_paise IS NULL OR principal_paise > 0),
    interest_rate         REAL CHECK (interest_rate IS NULL OR interest_rate >= 0),
    tenure_months         INTEGER CHECK (tenure_months IS NULL OR tenure_months > 0),
    paid_principal_paise  INTEGER CHECK (paid_principal_paise IS NULL OR paid_principal_paise >= 0),
    outstanding_paise     INTEGER CHECK (outstanding_paise IS NULL OR outstanding_paise >= 0),
    balance_as_of         TEXT,
    account               TEXT,
    category_id           TEXT REFERENCES categories(id) ON DELETE SET NULL,
    match_key             TEXT,
    remind_days           INTEGER NOT NULL DEFAULT 3 CHECK (remind_days BETWEEN 0 AND 30),
    active                INTEGER NOT NULL DEFAULT 1,
    notes                 TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  );
  CREATE INDEX commitments_user ON commitments (user_id, active);
  `,
  // v8: explicitly known family/friends; model-identified people are never inferred as family.
  `ALTER TABLE users ADD COLUMN family_contacts TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE merchant_suggestions ADD COLUMN is_person INTEGER NOT NULL DEFAULT 0;
   -- Revisit unconfirmed guesses using the new person/Other policy; confirmed rows are untouched.
   DELETE FROM merchant_suggestions WHERE status = 'pending' AND confidence = 'low';`,
  // v9: archived transactions remain in storage; hashes are unique only among active rows.
  `
  CREATE TABLE transactions_v9 (
    id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL, description TEXT NOT NULL,
    amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
    type TEXT NOT NULL CHECK (type IN ('debit', 'credit')),
    category_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
    notes TEXT, account TEXT NOT NULL DEFAULT 'cash', payment_mode TEXT,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import')),
    import_id TEXT REFERENCES imports(id) ON DELETE CASCADE,
    ref_no TEXT, balance_paise INTEGER, hash TEXT,
    auto_categorized INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
  );
  INSERT INTO transactions_v9 SELECT *, NULL FROM transactions ORDER BY rowid;
  DROP TABLE transactions;
  ALTER TABLE transactions_v9 RENAME TO transactions;
  CREATE UNIQUE INDEX transactions_active_hash ON transactions(user_id, hash) WHERE deleted_at IS NULL;
  CREATE INDEX transactions_user_date ON transactions(user_id, date DESC);
  CREATE INDEX transactions_user_category_date ON transactions(user_id, category_id, date DESC);
  CREATE INDEX transactions_import ON transactions(import_id);
  CREATE INDEX transactions_user_account_date ON transactions(user_id, account, date) WHERE balance_paise IS NOT NULL;
  -- Expose rowid explicitly: statement ordering and stable pagination depend on it.
  CREATE VIEW active_transactions AS SELECT rowid AS rowid, * FROM transactions WHERE deleted_at IS NULL;
  ALTER TABLE imports ADD COLUMN deleted_at TEXT;
  CREATE VIEW active_imports AS SELECT rowid AS rowid, * FROM imports WHERE deleted_at IS NULL;
  ALTER TABLE users ADD COLUMN transactions_reset_at TEXT;
  `,
  // v10: a complete financial reset archives configuration and categorization as well as history.
  (conn) => {
    // These tables had table-level UNIQUE constraints. Rebuild with uniqueness for active rows
    // so an archived rule/tag/suggestion never blocks creating a fresh one after reset.
    for (const table of ['tags', 'merchant_rules', 'merchant_suggestions']) {
      const original = conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql;
      const create = original.replace(new RegExp(`CREATE TABLE ["\\x60]?${table}["\\x60]?`, 'i'), `CREATE TABLE ${table}_v10`)
        .replace(/,\s*UNIQUE\s*\([^)]*\)/gi, '')
        .replace(/\)\s*$/, ', deleted_at TEXT)');
      conn.exec(create);
      conn.exec(`INSERT INTO ${table}_v10 SELECT *, NULL FROM ${table} ORDER BY rowid;
        DROP TABLE ${table}; ALTER TABLE ${table}_v10 RENAME TO ${table};`);
    }
    conn.exec(`
      ALTER TABLE categories ADD COLUMN deleted_at TEXT;
      DROP INDEX categories_user_parent_slug;
      CREATE UNIQUE INDEX categories_user_parent_slug ON categories(user_id, ifnull(parent_id, ''), slug) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX tags_active_name ON tags(user_id, name) WHERE deleted_at IS NULL;
      CREATE INDEX tags_user_group ON tags(user_id, group_name, name);
      CREATE UNIQUE INDEX merchant_rules_active_key ON merchant_rules(user_id, direction, merchant_key) WHERE deleted_at IS NULL;
      CREATE INDEX merchant_rules_category ON merchant_rules(category_id);
      CREATE UNIQUE INDEX merchant_suggestions_active_key ON merchant_suggestions(user_id, direction, merchant_key) WHERE deleted_at IS NULL;
      CREATE INDEX merchant_suggestions_user_status ON merchant_suggestions(user_id, status);
      ALTER TABLE commitments ADD COLUMN deleted_at TEXT;
      ALTER TABLE users ADD COLUMN financial_generation INTEGER NOT NULL DEFAULT 0;
      CREATE VIEW active_categories AS SELECT rowid AS rowid, * FROM categories WHERE deleted_at IS NULL;
      CREATE VIEW active_tags AS SELECT rowid AS rowid, * FROM tags WHERE deleted_at IS NULL;
      CREATE VIEW active_merchant_rules AS SELECT rowid AS rowid, * FROM merchant_rules WHERE deleted_at IS NULL;
      CREATE VIEW active_merchant_suggestions AS SELECT rowid AS rowid, * FROM merchant_suggestions WHERE deleted_at IS NULL;
      CREATE VIEW active_commitments AS SELECT rowid AS rowid, * FROM commitments WHERE deleted_at IS NULL;
    `);
  },
  // v11: resumable background recategorization when family/friends change.
  `CREATE TABLE family_sync_jobs (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'cancelled')),
    cursor INTEGER NOT NULL DEFAULT 0, through_rowid INTEGER NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL
  );`,
  // v12: repair installations that applied v10 before the generation guard was added.
  (conn) => {
    if (!conn.pragma('table_info(users)').some((c) => c.name === 'financial_generation')) {
      conn.exec('ALTER TABLE users ADD COLUMN financial_generation INTEGER NOT NULL DEFAULT 0');
    }
  },
  // v13: existing contacts predate the queue; enqueue their first historical scan once.
  (conn) => {
    const enqueue = conn.prepare(`INSERT INTO family_sync_jobs(user_id, generation, status, through_rowid, updated_at)
      SELECT ?, ?, 'pending', ifnull(max(rowid), 0), ? FROM active_transactions WHERE user_id = ?
      ON CONFLICT(user_id) DO NOTHING`);
    for (const user of conn.prepare('SELECT id, family_contacts, financial_generation FROM users').all()) {
      if (JSON.parse(user.family_contacts || '[]').length) enqueue.run(user.id, user.financial_generation, new Date().toISOString(), user.id);
    }
  },
  // v14: dashboard preferences belong to Profile and survive financial resets.
  'ALTER TABLE users ADD COLUMN dashboard_config TEXT;',
  // v15: which model writes Squirl's words (local or a cloud API with the person's own key), and
  // savings goals. A goal is a price today plus a plan; money saved comes from a linked auto-debit,
  // a watched account, transactions the person links, and manual entries (negative = withdrawal).
  // An 'excluded' contribution row keeps one auto-detected transaction out of a goal.
  `
  ALTER TABLE users ADD COLUMN ai_settings TEXT;
  CREATE TABLE goals (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    kind             TEXT NOT NULL DEFAULT 'other',
    price_paise      INTEGER NOT NULL CHECK (price_paise > 0),               -- what it costs today
    price_as_of      TEXT NOT NULL,
    plan             TEXT NOT NULL CHECK (plan IN ('by_date', 'by_amount')),
    target_date      TEXT,                                                   -- by_date
    monthly_paise    INTEGER CHECK (monthly_paise IS NULL OR monthly_paise > 0), -- planned monthly saving
    opening_paise    INTEGER NOT NULL DEFAULT 0 CHECK (opening_paise >= 0),  -- saved before the start date
    inflation_rate   REAL NOT NULL DEFAULT 6 CHECK (inflation_rate BETWEEN 0 AND 50),
    saving_in        TEXT NOT NULL DEFAULT 'savings',
    return_rate      REAL NOT NULL DEFAULT 0 CHECK (return_rate BETWEEN 0 AND 50),
    start_date       TEXT NOT NULL,
    watch_account    TEXT,
    commitment_id    TEXT REFERENCES commitments(id) ON DELETE SET NULL,
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'achieved')),
    notes            TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    deleted_at       TEXT
  );
  CREATE INDEX goals_user ON goals (user_id, status);
  CREATE UNIQUE INDEX goals_active_commitment ON goals (commitment_id) WHERE commitment_id IS NOT NULL AND deleted_at IS NULL;
  CREATE VIEW active_goals AS SELECT rowid AS rowid, * FROM goals WHERE deleted_at IS NULL;
  CREATE TABLE goal_contributions (
    id              TEXT PRIMARY KEY,
    goal_id         TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source          TEXT NOT NULL CHECK (source IN ('manual', 'transaction', 'excluded')),
    amount_paise    INTEGER NOT NULL,
    date            TEXT NOT NULL,
    transaction_id  TEXT REFERENCES transactions(id) ON DELETE CASCADE,
    note            TEXT,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX goal_contributions_goal ON goal_contributions (goal_id, date);
  CREATE UNIQUE INDEX goal_contributions_txn ON goal_contributions (goal_id, transaction_id) WHERE transaction_id IS NOT NULL;
  CREATE TABLE goal_analyses (
    goal_id       TEXT PRIMARY KEY REFERENCES goals(id) ON DELETE CASCADE,
    fingerprint   TEXT NOT NULL,
    body          TEXT NOT NULL,       -- JSON: { text, check, facts }
    engine        TEXT NOT NULL,
    model         TEXT,
    generated_at  TEXT NOT NULL
  );
  `,
  // v16: live data from free public APIs (weather, inflation, exchange rates, fund NAVs, crypto,
  // news). users.feeds holds the person's city, watchlists, holdings and optional keys (JSON);
  // feed_cache keeps the last good answer per request so a dead API only makes a card stale.
  `
  ALTER TABLE users ADD COLUMN feeds TEXT;
  CREATE TABLE feed_cache (
    key         TEXT PRIMARY KEY,
    body        TEXT NOT NULL,
    fetched_at  TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  `,
  // v17: a personal watchlist of movies, shows and anime (from TMDB): starred, and/or on the
  // "must watch" or "watch later" list. Not financial data, so a financial reset leaves it alone.
  `
  CREATE TABLE watchlist (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_type  TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
    tmdb_id     INTEGER NOT NULL,
    title       TEXT NOT NULL,
    poster      TEXT,
    overview    TEXT,
    year        INTEGER,
    rating      REAL,
    anime       INTEGER NOT NULL DEFAULT 0,
    starred     INTEGER NOT NULL DEFAULT 0,
    list        TEXT CHECK (list IS NULL OR list IN ('must_watch', 'watch_later')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (user_id, media_type, tmdb_id)
  );
  `,
];
