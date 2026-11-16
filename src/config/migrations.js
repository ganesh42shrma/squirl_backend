// Schema migrations, applied in order. PRAGMA user_version records how many have run.
// Each is SQL, or a function (conn) => void for data changes that need code.
// Never edit a migration that has shipped: add a new one to the end instead.
const { counterparty, isUsableKey } = require('../plugins/rules/rules.helper');
const { normalizePhone } = require('../plugins/users/contact.helper');
const { newId } = require('../core/sql');

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
  // v18: the Tasks module: lists, tasks (+ subtasks), checklists, habits and their streaks, the Daily
  // Quest, an append-only XP ledger, the hunter profile and achievement unlocks. This is not financial
  // data, so a financial reset leaves it alone; deleting the account removes it through the cascades.
  // users.tasks_settings is JSON (timezone, day start hour, daily XP cap, Daily Quest template, ...).
  `
  ALTER TABLE users ADD COLUMN tasks_settings TEXT;

  CREATE TABLE task_lists (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  );
  CREATE INDEX task_lists_user ON task_lists (user_id, position);
  CREATE VIEW active_task_lists AS SELECT rowid AS rowid, * FROM task_lists WHERE deleted_at IS NULL;

  CREATE TABLE tasks (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    list_id       TEXT REFERENCES task_lists(id) ON DELETE SET NULL,
    parent_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,   -- a subtask; one level deep (enforced in the service)
    title         TEXT NOT NULL,
    notes         TEXT,
    difficulty    TEXT NOT NULL DEFAULT 'normal' CHECK (difficulty IN ('trivial', 'easy', 'normal', 'hard', 'epic', 'boss')),
    stat          TEXT CHECK (stat IS NULL OR stat IN ('str', 'vit', 'agi', 'int', 'per', 'cha')),
    priority      INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    due_date      TEXT,                                          -- the person's own day, YYYY-MM-DD
    due_time      TEXT,
    repeat_rule   TEXT,                                          -- JSON { freq, interval, days, monthDay }; the next one is spawned on completion
    series_id     TEXT,
    position      INTEGER NOT NULL DEFAULT 0,
    completed_at  TEXT,
    completed_on  TEXT,                                          -- the person's day it was completed
    completed_hour INTEGER,                                      -- local hour, for the early/late achievements
    xp_awarded    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    deleted_at    TEXT
  );
  CREATE INDEX tasks_user_status_due ON tasks (user_id, status, due_date);
  CREATE INDEX tasks_parent ON tasks (parent_id);
  CREATE INDEX tasks_list ON tasks (list_id, position);
  CREATE VIEW active_tasks AS SELECT rowid AS rowid, * FROM tasks WHERE deleted_at IS NULL;

  CREATE TABLE task_checklist_items (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    done        INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX task_checklist_task ON task_checklist_items (task_id, position);

  CREATE TABLE habits (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name               TEXT NOT NULL,
    icon               TEXT,
    color              TEXT,
    difficulty         TEXT NOT NULL DEFAULT 'easy' CHECK (difficulty IN ('trivial', 'easy', 'normal', 'hard', 'epic')),
    stat               TEXT CHECK (stat IS NULL OR stat IN ('str', 'vit', 'agi', 'int', 'per', 'cha')),
    cadence            TEXT NOT NULL DEFAULT 'daily' CHECK (cadence IN ('daily', 'weekdays', 'times_per_week', 'every_n_days', 'times_per_month')),
    days_mask          INTEGER NOT NULL DEFAULT 127,             -- bit0 = Monday ... bit6 = Sunday (weekdays cadence)
    target_per_period  INTEGER NOT NULL DEFAULT 1 CHECK (target_per_period BETWEEN 1 AND 31),
    every_n            INTEGER CHECK (every_n IS NULL OR every_n BETWEEN 2 AND 60),
    target_quantity    REAL,                                     -- e.g. 8 'glasses'; NULL = simply done / not done
    unit               TEXT,
    start_date         TEXT NOT NULL,
    freeze_max         INTEGER NOT NULL DEFAULT 2 CHECK (freeze_max BETWEEN 0 AND 5),
    freezes_held       INTEGER NOT NULL DEFAULT 0,
    freezes_used_total INTEGER NOT NULL DEFAULT 0,
    skips_per_week     INTEGER NOT NULL DEFAULT 1 CHECK (skips_per_week BETWEEN 0 AND 7),
    in_daily_quest     INTEGER NOT NULL DEFAULT 0,
    current_streak     INTEGER NOT NULL DEFAULT 0,
    longest_streak     INTEGER NOT NULL DEFAULT 0,
    echo_bound_at      TEXT,
    position           INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    archived_at        TEXT,
    deleted_at         TEXT
  );
  CREATE INDEX habits_user ON habits (user_id, archived_at);
  CREATE VIEW active_habits AS SELECT rowid AS rowid, * FROM habits WHERE deleted_at IS NULL;

  CREATE TABLE habit_checkins (
    id          TEXT PRIMARY KEY,
    habit_id    TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'done' CHECK (kind IN ('done', 'skip')),
    quantity    REAL,
    created_at  TEXT NOT NULL
  );
  CREATE UNIQUE INDEX habit_checkins_day ON habit_checkins (habit_id, date, kind);
  CREATE INDEX habit_checkins_user_date ON habit_checkins (user_id, date);

  CREATE TABLE daily_quests (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date         TEXT NOT NULL,
    items        TEXT NOT NULL,                                  -- JSON snapshot [{ key, type: 'habit' | 'custom', refId, title, done }]
    status       TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open', 'cleared', 'penalty_open', 'penalty_cleared', 'penalty_failed', 'paused')),
    penalty_task TEXT,
    penalty_due  TEXT,
    cleared_at   TEXT,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (user_id, date)
  );

  CREATE TABLE xp_events (                                       -- append-only: the only source of truth for XP
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount      INTEGER NOT NULL,                                -- negative for reversals
    reason      TEXT NOT NULL CHECK (reason IN ('task', 'subtask', 'checklist', 'habit', 'daily_quest', 'penalty_quest',
                                                'streak_milestone', 'achievement', 'rank_trial', 'reversal')),
    source_id   TEXT,
    dedupe_key  TEXT,                                            -- one award per key, so repeating a request can't double-pay
    stat        TEXT,
    tier        TEXT,
    occurred_on TEXT NOT NULL,
    meta        TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE UNIQUE INDEX xp_events_once ON xp_events (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
  CREATE INDEX xp_events_user_day ON xp_events (user_id, occurred_on);

  CREATE TABLE hunter_profiles (                                 -- cached aggregates, rebuildable from xp_events
    user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    total_xp            INTEGER NOT NULL DEFAULT 0,
    level               INTEGER NOT NULL DEFAULT 1,
    peak_level          INTEGER NOT NULL DEFAULT 1,
    rank                TEXT NOT NULL DEFAULT 'E' CHECK (rank IN ('E', 'D', 'C', 'B', 'A', 'S', 'N', 'X')),
    trial               TEXT,                                    -- JSON { rank, openedAt } while a Reassessment is open
    title               TEXT,                                    -- equipped achievement id
    daily_chain         INTEGER NOT NULL DEFAULT 0,
    longest_daily_chain INTEGER NOT NULL DEFAULT 0,
    updated_at          TEXT NOT NULL
  );

  CREATE TABLE user_achievements (
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id  TEXT NOT NULL,                               -- defined in code (achievements.js)
    progress        TEXT,                                        -- JSON { count, target }
    unlocked_at     TEXT,
    PRIMARY KEY (user_id, achievement_id)
  );
  `,
  // v19: opt-in push devices and durable delivery receipts. All remain inside the encrypted DB.
  `
  CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    password_changed_at TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    subscription TEXT NOT NULL,
    preferences TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX push_user ON push_subscriptions (user_id);
  CREATE TABLE push_deliveries (
    subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
    reminder_key TEXT NOT NULL,
    sent_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (subscription_id, reminder_key)
  );
  `,
  // v20: SMS capture provenance, scoped devices, and statement reconciliation.
  (conn) => {
    const original = conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'").pluck().get();
    const indexes = conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transactions' AND sql IS NOT NULL").pluck().all();
    conn.exec('DROP VIEW active_transactions');
    conn.exec(original.replace(/^CREATE TABLE ["`]?transactions["`]?/i, 'CREATE TABLE transactions_sms')
      .replace("source IN ('manual', 'import')", "source IN ('manual', 'import', 'sms')"));
    const columns = conn.pragma('table_info(transactions)').map((c) => c.name).join(', ');
    conn.exec(`INSERT INTO transactions_sms (rowid, ${columns}) SELECT rowid, ${columns} FROM transactions ORDER BY rowid`);
    conn.exec('DROP TABLE transactions; ALTER TABLE transactions_sms RENAME TO transactions;');
    for (const sql of indexes) conn.exec(sql);
    conn.exec(`
      ALTER TABLE transactions ADD COLUMN transfer_id TEXT;
      CREATE VIEW active_transactions AS SELECT rowid AS rowid, * FROM transactions WHERE deleted_at IS NULL;
      ALTER TABLE imports ADD COLUMN reconciled INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE sms_accounts (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bank TEXT NOT NULL CHECK (bank IN ('sbi', 'kotak')), last4 TEXT NOT NULL,
        senders TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE UNIQUE INDEX sms_account_bank ON sms_accounts(user_id, bank) WHERE deleted_at IS NULL;
      CREATE TABLE sms_devices (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, password_changed_at TEXT NOT NULL,
        generation INTEGER NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT
      );
      CREATE INDEX sms_devices_user ON sms_devices(user_id);
      CREATE TABLE sms_events (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES sms_devices(id) ON DELETE CASCADE,
        event_key TEXT NOT NULL, message_hash TEXT NOT NULL, sender TEXT NOT NULL,
        received_at TEXT NOT NULL, bank TEXT, body TEXT, parsed TEXT,
        status TEXT NOT NULL CHECK(status IN ('captured', 'reconciled', 'duplicate', 'review', 'ignored', 'dismissed')),
        reason TEXT, transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
        UNIQUE(device_id, event_key)
      );
      CREATE INDEX sms_events_user_status ON sms_events(user_id, status) WHERE deleted_at IS NULL;
      CREATE INDEX sms_events_transaction ON sms_events(transaction_id) WHERE deleted_at IS NULL;
      CREATE INDEX sms_events_hash ON sms_events(user_id, message_hash) WHERE deleted_at IS NULL;
    `);
  },
  // v21: one durable purpose prompt per newly captured SMS payment.
  `
  CREATE TABLE payment_prompts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    answered_at TEXT,
    answer TEXT
  );
  CREATE INDEX payment_prompts_user ON payment_prompts(user_id, created_at);
  `,
  // v22: Quick Capture log. 'done' rows remember what they created (for undo); 'inbox' rows are
  // notes waiting to be sorted, which the daily reminder counts.
  `
  CREATE TABLE captures (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('done', 'inbox', 'dismissed', 'undone')),
    engine      TEXT NOT NULL DEFAULT 'rules' CHECK (engine IN ('rules', 'ai')),
    result      TEXT,                                            -- JSON [{ type, id, label, ... }] of what was created
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    resolved_at TEXT,
    deleted_at  TEXT
  );
  CREATE INDEX captures_user_status ON captures (user_id, status, created_at) WHERE deleted_at IS NULL;
  `,
  // v23: Quick Capture ↔ SMS de-duplication. `transactions.capture_id` marks a row Quick Capture created
  // (set only by the server, never by the ledger API), so a bank SMS can merge into it without ever
  // touching hand-typed rows. `captures.client_id` is the palette's per-submission key: a retried save
  // finds its first result instead of saving twice. Archived rows keep their key, so it stays unique.
  `
  ALTER TABLE transactions ADD COLUMN capture_id TEXT;
  CREATE INDEX transactions_capture ON transactions (user_id, capture_id) WHERE capture_id IS NOT NULL;
  ALTER TABLE captures ADD COLUMN client_id TEXT;
  CREATE UNIQUE INDEX captures_client ON captures (user_id, client_id) WHERE client_id IS NOT NULL;
  `,
  // v24: two small guards for the v23 columns. `captures.request_hash` fingerprints what a save was for, so a
  // client id re-used with different text is refused instead of silently returning the old save.
  // `transactions.description_kept` marks a row whose description is the person's own words (an SMS merged
  // into their Quick Capture row), as distinct from a bank row they merely annotated: a later statement
  // import (and its undo) keeps the first kind and uses the bank's wording for the second.
  `
  ALTER TABLE captures ADD COLUMN request_hash TEXT;
  ALTER TABLE transactions ADD COLUMN description_kept INTEGER NOT NULL DEFAULT 0;
  `,
  // v25: a disconnected phone can be removed from the list. It is hidden, never deleted: sms_events point at
  // their device (ON DELETE CASCADE), and those events are what recognises a bank text it has already seen,
  // so erasing the phone would let the same payment be added twice.
  `
  ALTER TABLE sms_devices ADD COLUMN deleted_at TEXT;
  `,
  // v26: photo attachments. The images themselves live encrypted on the laptop's internal disk (never in this
  // database, never on the USB drive); these tables only describe them. `media` is one stored image per
  // account (the same picture uploaded twice by one account is stored once; never shared between accounts).
  // `attachments` ties an image to a transaction, task or goal. owner_id is deliberately not a foreign key
  // because it can point at three tables; the service checks the owner exists and belongs to the account.
  // replica_state tracks the optional encrypted copy in S3-compatible storage; 'pending_delete' is a removed
  // image whose remote copy still has to be deleted (the row is kept, soft-deleted, until that works).
  `
  CREATE TABLE media (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sha256           TEXT NOT NULL,                                -- of the image bytes, hex; used only to de-duplicate per account
    mime             TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
    size_bytes       INTEGER NOT NULL CHECK (size_bytes > 0),      -- of the image, before encryption
    width            INTEGER,
    height           INTEGER,
    replica_state    TEXT NOT NULL DEFAULT 'none' CHECK (replica_state IN ('none', 'pending', 'done', 'failed', 'pending_delete')),
    replica_attempts INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    deleted_at       TEXT
  );
  CREATE UNIQUE INDEX media_user_sha ON media (user_id, sha256) WHERE deleted_at IS NULL;
  CREATE INDEX media_replica ON media (replica_state) WHERE replica_state IN ('pending', 'failed', 'pending_delete');
  CREATE VIEW active_media AS SELECT rowid AS rowid, * FROM media WHERE deleted_at IS NULL;

  CREATE TABLE attachments (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id   TEXT NOT NULL REFERENCES media(id),
    owner_type TEXT NOT NULL CHECK (owner_type IN ('transaction', 'task', 'goal')),
    owner_id   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE UNIQUE INDEX attachments_owner_media ON attachments (user_id, owner_type, owner_id, media_id) WHERE deleted_at IS NULL;
  CREATE INDEX attachments_owner ON attachments (user_id, owner_type, owner_id);
  CREATE INDEX attachments_media ON attachments (media_id) WHERE deleted_at IS NULL;
  CREATE VIEW active_attachments AS SELECT rowid AS rowid, * FROM attachments WHERE deleted_at IS NULL;
  `,
  // v27: photos on EMIs & bills ('commitment') and on capture inbox notes ('capture'). SQLite can't change a CHECK
  // in place, so the table is rebuilt with the same rows, indexes and view. `inbox_captures` is the "live owner"
  // view for a capture: only a note still waiting in the inbox can hold photos (sorting it moves them on).
  `
  DROP VIEW active_attachments;
  CREATE TABLE attachments_v27 (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id   TEXT NOT NULL REFERENCES media(id),
    owner_type TEXT NOT NULL CHECK (owner_type IN ('transaction', 'task', 'goal', 'commitment', 'capture')),
    owner_id   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  INSERT INTO attachments_v27 (rowid, id, user_id, media_id, owner_type, owner_id, created_at, deleted_at)
    SELECT rowid, id, user_id, media_id, owner_type, owner_id, created_at, deleted_at FROM attachments ORDER BY rowid;
  DROP TABLE attachments;
  ALTER TABLE attachments_v27 RENAME TO attachments;
  CREATE UNIQUE INDEX attachments_owner_media ON attachments (user_id, owner_type, owner_id, media_id) WHERE deleted_at IS NULL;
  CREATE INDEX attachments_owner ON attachments (user_id, owner_type, owner_id);
  CREATE INDEX attachments_media ON attachments (media_id) WHERE deleted_at IS NULL;
  CREATE VIEW active_attachments AS SELECT rowid AS rowid, * FROM attachments WHERE deleted_at IS NULL;
  CREATE VIEW inbox_captures AS SELECT rowid AS rowid, * FROM captures WHERE deleted_at IS NULL AND status = 'inbox';
  `,
  // v28: "Your circle". Everyone the person knows lives in `people` (names, with their mobile numbers in
  // `person_phones`); `is_family` marks the ones who were on the old Family & friends list, and ONLY those
  // feed the Family category (see users/family.js). `person_identifiers` are UPI ids / payee names the person
  // linked to someone by hand: they only label ledger rows and never touch a category. Each old
  // `users.family_contacts` entry becomes a family person with the same name, aliases, relationship and
  // normalised phone, so the Family rules see exactly the names and numbers they saw before. The old column is
  // left untouched and is no longer read or written: dropping it would gain nothing, and it stays as a record of
  // the list as it was. (An older build cannot open a v28 database at all; a rollback restores the deploy's backup.)
  (conn) => {
    conn.exec(`
    CREATE TABLE people (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      is_family    INTEGER NOT NULL DEFAULT 0 CHECK (is_family IN (0, 1)),
      relationship TEXT NOT NULL DEFAULT '',
      aliases      TEXT NOT NULL DEFAULT '[]',                 -- JSON array of statement names; used for family matching only
      source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import')),
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      deleted_at   TEXT
    );
    CREATE INDEX people_user_name ON people (user_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
    CREATE INDEX people_family ON people (user_id) WHERE deleted_at IS NULL AND is_family = 1;
    CREATE VIEW active_people AS SELECT rowid AS rowid, * FROM people WHERE deleted_at IS NULL;

    -- A removed person's numbers are deleted with them, so a plain unique index frees the number again.
    CREATE TABLE person_phones (
      person_id  TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      phone      TEXT NOT NULL,                                 -- 10-digit Indian mobile (normalizePhone)
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX person_phones_user_phone ON person_phones (user_id, phone);
    CREATE INDEX person_phones_person ON person_phones (person_id);

    -- transaction_id is the payment the link was made from, so clearing that payment removes what it taught.
    CREATE TABLE person_identifiers (
      person_id      TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind           TEXT NOT NULL CHECK (kind IN ('vpa', 'payee')),
      value          TEXT NOT NULL,
      transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
      created_at     TEXT NOT NULL
    );
    CREATE UNIQUE INDEX person_identifiers_value ON person_identifiers (user_id, kind, value);
    CREATE INDEX person_identifiers_person ON person_identifiers (person_id);
    CREATE INDEX person_identifiers_transaction ON person_identifiers (transaction_id) WHERE transaction_id IS NOT NULL;
    `);
    const now = new Date().toISOString();
    const addPerson = conn.prepare(`INSERT INTO people (id, user_id, name, is_family, relationship, aliases, source, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, 'manual', ?, ?)`);
    // OR IGNORE: two old entries sharing a number keep it on the first; the set of family numbers is unchanged.
    const addPhone = conn.prepare('INSERT OR IGNORE INTO person_phones (person_id, user_id, phone, created_at) VALUES (?, ?, ?, ?)');
    for (const user of conn.prepare('SELECT id, family_contacts FROM users').all()) {
      let contacts = [];
      try { contacts = JSON.parse(user.family_contacts || '[]'); } catch { /* unreadable list: nothing to carry over */ }
      for (const c of Array.isArray(contacts) ? contacts : []) {
        if (!c || typeof c !== 'object') continue; // a stray null or string in the list must not stop the upgrade
        const id = newId();
        const aliases = Array.isArray(c.aliases) ? c.aliases.map((a) => String(a ?? '')) : [];
        addPerson.run(id, user.id, String(c.name ?? ''), String(c.relationship || ''), JSON.stringify(aliases), now, now);
        const phone = normalizePhone(c.phone);
        if (phone) addPhone.run(id, user.id, phone, now);
      }
    }
  },
  // v29: streaks with photo proof. A habit can require a photo for each day it is checked in: `habits.require_photo`
  // (off for every existing habit, so nothing about current streaks changes). A photo for one day is an attachment
  // owned by the habit with `day` set to that date (NULL for every other kind of attachment). `attachments` is
  // rebuilt like in v27 (its CHECK must learn 'habit'): same rows in the same order, same ids, indexes and view.
  (conn) => {
    conn.exec(`
    ALTER TABLE habits ADD COLUMN require_photo INTEGER NOT NULL DEFAULT 0 CHECK (require_photo IN (0, 1));
    DROP VIEW active_habits;
    CREATE VIEW active_habits AS SELECT rowid AS rowid, * FROM habits WHERE deleted_at IS NULL;

    DROP VIEW active_attachments;
    CREATE TABLE attachments_v29 (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_id   TEXT NOT NULL REFERENCES media(id),
      owner_type TEXT NOT NULL CHECK (owner_type IN ('transaction', 'task', 'goal', 'commitment', 'capture', 'habit')),
      owner_id   TEXT NOT NULL,
      day        TEXT,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    INSERT INTO attachments_v29 (rowid, id, user_id, media_id, owner_type, owner_id, created_at, deleted_at)
      SELECT rowid, id, user_id, media_id, owner_type, owner_id, created_at, deleted_at FROM attachments ORDER BY rowid;
    DROP TABLE attachments;
    ALTER TABLE attachments_v29 RENAME TO attachments;
    CREATE UNIQUE INDEX attachments_owner_media ON attachments (user_id, owner_type, owner_id, media_id) WHERE deleted_at IS NULL;
    CREATE INDEX attachments_owner ON attachments (user_id, owner_type, owner_id);
    CREATE INDEX attachments_owner_day ON attachments (user_id, owner_type, owner_id, day) WHERE deleted_at IS NULL;
    CREATE INDEX attachments_media ON attachments (media_id) WHERE deleted_at IS NULL;
    CREATE VIEW active_attachments AS SELECT rowid AS rowid, * FROM attachments WHERE deleted_at IS NULL;
    `);
  },
  // v30: a richer profile. `users` gets optional personal details (all NULL until the person fills them in), and
  // a profile picture is a photo attachment owned by the account itself (`owner_type = 'user'`, owner_id = the
  // user's id), so it reuses the encrypted media store. `attachments` is rebuilt like in v29 (its CHECK must learn
  // 'user'): same rows in the same order, same ids, indexes and view. `avatar_owners` is the "live owner" view for
  // it: an account is its own owner, so `user_id` is just its id.
  `
  ALTER TABLE users ADD COLUMN phone TEXT;
  ALTER TABLE users ADD COLUMN bio TEXT;
  ALTER TABLE users ADD COLUMN birthday TEXT;
  ALTER TABLE users ADD COLUMN city TEXT;
  ALTER TABLE users ADD COLUMN currency TEXT;

  DROP VIEW active_attachments;
  CREATE TABLE attachments_v30 (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id   TEXT NOT NULL REFERENCES media(id),
    owner_type TEXT NOT NULL CHECK (owner_type IN ('transaction', 'task', 'goal', 'commitment', 'capture', 'habit', 'user')),
    owner_id   TEXT NOT NULL,
    day        TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  INSERT INTO attachments_v30 (rowid, id, user_id, media_id, owner_type, owner_id, day, created_at, deleted_at)
    SELECT rowid, id, user_id, media_id, owner_type, owner_id, day, created_at, deleted_at FROM attachments ORDER BY rowid;
  DROP TABLE attachments;
  ALTER TABLE attachments_v30 RENAME TO attachments;
  CREATE UNIQUE INDEX attachments_owner_media ON attachments (user_id, owner_type, owner_id, media_id) WHERE deleted_at IS NULL;
  CREATE INDEX attachments_owner ON attachments (user_id, owner_type, owner_id);
  CREATE INDEX attachments_owner_day ON attachments (user_id, owner_type, owner_id, day) WHERE deleted_at IS NULL;
  CREATE INDEX attachments_media ON attachments (media_id) WHERE deleted_at IS NULL;
  CREATE VIEW active_attachments AS SELECT rowid AS rowid, * FROM attachments WHERE deleted_at IS NULL;
  CREATE VIEW avatar_owners AS SELECT rowid AS rowid, id, id AS user_id FROM users;
  `,
];
