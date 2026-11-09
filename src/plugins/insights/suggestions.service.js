// Model category suggestions, worked out merchant by merchant and saved.
// Deterministic by design: each merchant is asked about once (temperature 0, fixed seed, a fixed
// list of main categories), and the saved answer is reused for every row of that merchant.
const { getDb } = require('../../config/db');
const AppError = require('../../core/AppError');
const { newId, nowIso, placeholders } = require('../../core/sql');
const { counterparty, isUsableKey } = require('../rules/rules.helper');
const { learn } = require('../rules/rules.service');
const llm = require('./llm.client');
const { familyPolicy } = require('../users/family');

const BATCH = 40; // merchants per model call

const groupKey = (direction, key) => `${direction}|${key}`;

/** This account's unsorted imported rows, grouped by counterparty and direction. */
function unsortedGroups(db, userId) {
  const rows = db
    .prepare("SELECT id, description, type FROM active_transactions WHERE user_id = ? AND category_id IS NULL ORDER BY date DESC, rowid DESC")
    .all(userId);
  const groups = new Map();
  for (const row of rows) {
    const party = counterparty(row.description);
    if (!isUsableKey(party.key)) continue;
    const slot = groupKey(row.type, party.key);
    if (!groups.has(slot)) groups.set(slot, { direction: row.type, key: party.key, merchant: party.name, example: row.description, ids: [] });
    groups.get(slot).ids.push(row.id);
  }
  return groups;
}

/**
 * Merchants the model hasn't been asked about yet: no saved suggestion (of any status) and no
 * learned rule (the person's own choice beats a model guess). Most rows first.
 */
function pendingGroups(db, userId) {
  const known = new Set([
    ...db.prepare('SELECT direction, merchant_key FROM active_merchant_suggestions WHERE user_id = ?').all(userId).map((r) => groupKey(r.direction, r.merchant_key)),
    ...db.prepare('SELECT direction, merchant_key FROM active_merchant_rules WHERE user_id = ?').all(userId).map((r) => groupKey(r.direction, r.merchant_key)),
  ]);
  return [...unsortedGroups(db, userId).values()]
    .filter((g) => !known.has(groupKey(g.direction, g.key)))
    .sort((a, b) => b.ids.length - a.ids.length || a.key.localeCompare(b.key));
}

// Main categories only, numbered, each with its subcategories as a hint of what it covers.
function mainCategories(db, userId) {
  const rows = db.prepare('SELECT id, name, type, parent_id FROM active_categories WHERE user_id = ?').all(userId);
  return rows
    .filter((r) => !r.parent_id)
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
    .map((c, i) => ({
      n: i + 1,
      id: c.id,
      name: c.name,
      type: c.type,
      covers: rows.filter((r) => r.parent_id === c.id).map((r) => r.name).sort().join(', '),
    }));
}

// The person's own past choices (learned merchants), mapped to main categories: few-shot examples.
function pastChoices(db, userId, limit = 20) {
  return db
    .prepare(
      `SELECT r.merchant_key, r.direction, coalesce(p.name, c.name) AS main
       FROM active_merchant_rules r JOIN active_categories c ON c.id = r.category_id AND c.user_id = r.user_id
       LEFT JOIN active_categories p ON p.id = c.parent_id AND p.user_id = r.user_id
       WHERE r.user_id = ? ORDER BY r.hits DESC, r.updated_at DESC LIMIT ?`,
    )
    .all(userId, limit);
}

const SYSTEM_PROMPT = `You sort Indian bank-statement transactions into a person's MAIN spending categories.
You get their numbered main categories (each with what it covers), some of their own past choices as examples,
and numbered transactions: who it was with, whether money went out or came in, and one example description.
For each transaction pick the single best main category number, or null if the description doesn't tell you.
Rules:
- Follow the person's past choices for the same or similar merchants.
- Moving money between the person's own accounts goes in the transfer category.
- A payment to or from an individual with no evidence of a business or specific purpose: set "person":true and pick Other. Never assume that a person's name means family, friends, gifts or support.
- Never infer Family, family support, friendship or gifts from a name. Known family and friends are matched separately from an explicit profile list.
- Never pick an income category for money going out.
Answer with JSON only: {"items":[{"t":1,"c":4,"confidence":"high","person":false}]} with confidence "high", "medium" or "low".`;

/** Asks the model about one batch of merchants and saves an answer (or "none") for every one of them. */
async function suggestBatch(db, userId, groups) {
  const generation = db.prepare('SELECT financial_generation FROM users WHERE id = ?').get(userId)?.financial_generation;
  const categories = mainCategories(db, userId);
  const byNumber = new Map(categories.map((c) => [c.n, c]));
  const examples = pastChoices(db, userId);

  const prompt = [
    'Main categories:',
    ...categories.map((c) => `${c.n}. ${c.name} (${c.type})${c.covers ? `: ${c.covers}` : ''}`),
    '',
    ...(examples.length
      ? ['How this person has categorised before:', ...examples.map((e) => `- ${e.merchant_key} (${e.direction === 'debit' ? 'money out' : 'money in'}) → ${e.main}`), '']
      : []),
    'Transactions:',
    ...groups.map((g, i) => `${i + 1}. [${g.direction === 'debit' ? 'money out' : 'money in'}] ${g.key} | ${g.example.slice(0, 100)}`),
  ].join('\n');

  const { text, model } = await llm.chat(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    { json: true, maxTokens: 80 + groups.length * 28, temperature: 0 },
  );
  const answer = llm.parseJson(text);
  if (db.prepare('SELECT financial_generation FROM users WHERE id = ?').get(userId)?.financial_generation !== generation) return 0;
  if (!Array.isArray(answer?.items)) throw new AppError('The local model gave an answer that couldn’t be read', 502, 'LLM_BAD_RESPONSE');
  // The profile may have changed while the model was answering.
  const policy = familyPolicy(db, userId);

  const picks = new Map();
  for (const item of answer.items) {
    const index = Number(item.t) - 1;
    const group = groups[index];
    const proposed = byNumber.get(Number(item.c));
    const categoryId = policy.categoryFor(group?.example, proposed?.id, item.person === true);
    const category = categories.find((c) => c.id === categoryId)
      || (categoryId === policy.otherId ? { id: policy.otherId, type: 'expense' } : null);
    if (!group || picks.has(index) || !category) continue; // invented row or category: ignore
    if (group.direction === 'debit' && category.type === 'income') continue; // money out is never income
    let confidence = ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'low';
    if (group.direction === 'credit' && category.type === 'expense') confidence = 'low'; // only a refund fits
    picks.set(index, { category, confidence, isPerson: item.person === true });
  }

  const now = nowIso();
  const insert = db.prepare(`
    INSERT INTO merchant_suggestions (id, user_id, direction, merchant_key, merchant, example, category_id, confidence, is_person, model, created_at, updated_at)
    VALUES (@id, @userId, @direction, @key, @merchant, @example, @category, @confidence, @isPerson, @model, @now, @now)
    ON CONFLICT (user_id, direction, merchant_key) WHERE deleted_at IS NULL DO NOTHING`);
  db.transaction(() => {
    groups.forEach((g, i) => {
      const pick = picks.get(i);
      insert.run({
        id: newId(),
        userId,
        direction: g.direction,
        key: g.key,
        merchant: g.merchant,
        example: g.example.slice(0, 200),
        category: pick ? pick.category.id : null,
        confidence: pick ? pick.confidence : 'none', // remembered, so it isn't asked again
        isPerson: pick?.isPerson ? 1 : 0,
        model,
        now,
      });
    });
  })();
  return picks.size;
}

// ── For the API ──────────────────────────────────────────────────────────────────────────────

const ORDER = { high: 0, medium: 1, low: 2 };

/** Pending suggestions that still have unsorted rows, plus progress numbers. */
async function listSuggestions(userId, { limit = 100, offset = 0 } = {}, progress = null) {
  const db = getDb();
  const policy = familyPolicy(db, userId);
  const groups = unsortedGroups(db, userId);
  const saved = db
    .prepare(
      `SELECT s.*, c.name AS c_name, c.type AS c_type FROM active_merchant_suggestions s
       LEFT JOIN active_categories c ON c.id = s.category_id AND c.user_id = s.user_id
       WHERE s.user_id = ?`,
    )
    .all(userId);
  const savedKeys = new Set(saved.map((s) => groupKey(s.direction, s.merchant_key)));
  const learnedKeys = new Set(db.prepare('SELECT direction, merchant_key FROM active_merchant_rules WHERE user_id = ?').all(userId).map((r) => groupKey(r.direction, r.merchant_key)));

  const items = saved
    .filter((s) => s.status === 'pending' && s.category_id)
    .map((s) => ({ s, group: groups.get(groupKey(s.direction, s.merchant_key)) }))
    .filter((x) => x.group)
    .map(({ s, group }) => {
      const categoryId = policy.categoryFor(group.example, s.category_id, Boolean(s.is_person));
      const category = db.prepare('SELECT id, name, type FROM active_categories WHERE user_id = ? AND id = ?').get(userId, categoryId);
      if (!category) return null;
      return {
        _id: s.id,
        merchant: s.merchant,
        example: group.example,
        direction: s.direction,
        rowCount: group.ids.length,
        category: { _id: category.id, label: category.name, type: category.type },
        confidence: s.confidence,
      };
    })
    .filter(Boolean)
    .sort((a, b) => ORDER[a.confidence] - ORDER[b.confidence] || b.rowCount - a.rowCount || a.merchant.localeCompare(b.merchant));

  const unsortedRows = db.prepare("SELECT count(*) FROM active_transactions WHERE user_id = ? AND category_id IS NULL").pluck().get(userId);
  const allGroups = [...groups.values()];
  const pending = allGroups.filter((g) => !savedKeys.has(groupKey(g.direction, g.key)) && !learnedKeys.has(groupKey(g.direction, g.key)));
  const learned = allGroups.filter((g) => learnedKeys.has(groupKey(g.direction, g.key)));
  return {
    status: {
      ...(progress || { running: false }),
      unsortedRows,
      merchants: allGroups.length,
      merchantsAsked: allGroups.filter((g) => savedKeys.has(groupKey(g.direction, g.key))).length,
      pendingMerchants: pending.length,
      checkedMerchants: allGroups.length - pending.length,
      learnedMerchants: learned.length,
      learnedRows: learned.reduce((n, g) => n + g.ids.length, 0),
      suggestedRows: items.reduce((n, i) => n + i.rowCount, 0),
      byConfidence: Object.fromEntries(['high', 'medium', 'low'].map((c) => [c, items.filter((i) => i.confidence === c).reduce((n, i) => n + i.rowCount, 0)])),
    },
    total: items.length,
    suggestions: items.slice(offset, offset + limit),
  };
}

/**
 * Applies suggestions: every unsorted row of each merchant gets the chosen category (the suggested
 * one, or the person's override). That's the person's decision, so merchant memory learns it and
 * future imports from that merchant arrive sorted.
 */
async function applySuggestions(userId, items) {
  const db = getDb();
  const policy = familyPolicy(db, userId);
  const groups = unsortedGroups(db, userId);
  const validCategories = new Set(db.prepare('SELECT id FROM active_categories WHERE user_id = ?').pluck().all(userId));

  return db.transaction(() => {
    let rows = 0;
    const now = nowIso();
    for (const { id, categoryId } of items) {
      const s = db.prepare('SELECT * FROM active_merchant_suggestions WHERE id = ? AND user_id = ?').get(id, userId);
      if (!s) continue;
      const category = categoryId || policy.categoryFor(s.example, s.category_id, Boolean(s.is_person));
      if (!category || !validCategories.has(category)) throw AppError.badRequest('Category not found', 'INVALID_CATEGORY');
      const group = groups.get(groupKey(s.direction, s.merchant_key));
      if (group?.ids.length) {
        db.prepare(`UPDATE transactions SET category_id = ?, updated_at = ? WHERE deleted_at IS NULL AND user_id = ? AND category_id IS NULL AND id IN (${placeholders(group.ids)})`).run(
          category,
          now,
          userId,
          ...group.ids,
        );
        learn(db, userId, group.ids, category);
        rows += group.ids.length;
      }
      db.prepare("UPDATE merchant_suggestions SET status = 'applied', updated_at = ? WHERE id = ?").run(now, s.id);
    }
    return { applied: rows };
  })();
}

async function dismissSuggestion(userId, id) {
  const { changes } = getDb()
    .prepare("UPDATE merchant_suggestions SET status = 'dismissed', updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
    .run(nowIso(), id, userId);
  if (!changes) throw AppError.notFound('Suggestion not found');
  return { dismissed: true };
}

// Users with unsorted imported rows: the worker's to-do list.
const usersWithUnsorted = (db) =>
  db.prepare('SELECT DISTINCT user_id FROM active_transactions WHERE category_id IS NULL AND user_id IS NOT NULL').pluck().all();

// Apply trusted rules/cached answers without teaching model guesses back as user-confirmed rules.
// A successful but inconclusive model answer (or an unidentifiable description) goes to Other.
function autoCategorize(db, userId) {
  return db.transaction(() => {
    let policy = familyPolicy(db, userId);
    if (!policy.otherId) {
      require('../categories/category.model').insertCategory(db, userId, { name: 'Other', type: 'expense' });
      policy = familyPolicy(db, userId);
    }
    const rules = new Map(db.prepare('SELECT direction, merchant_key, category_id FROM active_merchant_rules WHERE user_id = ?').all(userId).map((r) => [groupKey(r.direction, r.merchant_key), r.category_id]));
    const saved = new Map(db.prepare('SELECT * FROM active_merchant_suggestions WHERE user_id = ?').all(userId).map((r) => [groupKey(r.direction, r.merchant_key), r]));
    const valid = new Set(db.prepare('SELECT id FROM active_categories WHERE user_id = ?').pluck().all(userId));
    const update = db.prepare('UPDATE transactions SET category_id = ?, auto_categorized = 1, updated_at = ? WHERE user_id = ? AND id = ? AND category_id IS NULL AND deleted_at IS NULL');
    const rows = db.prepare('SELECT id, description, type FROM active_transactions WHERE user_id = ? AND category_id IS NULL').all(userId);
    let applied = 0;
    for (const row of rows) {
      const party = counterparty(row.description);
      const slot = groupKey(row.type, party.key);
      const cached = saved.get(slot);
      const learned = rules.get(slot);
      let category;
      if (policy.matches(row.description)) category = policy.familyId;
      else if (learned) category = policy.categoryFor(row.description, learned);
      else if (cached) category = cached.status === 'dismissed' ? policy.otherId : policy.categoryFor(row.description, cached.category_id || policy.otherId, Boolean(cached.is_person));
      else if (!isUsableKey(party.key)) category = policy.otherId;
      else continue; // Still needs an AI answer; a server failure is retried, not guessed away.
      if (!valid.has(category)) category = policy.otherId;
      applied += update.run(category, nowIso(), userId, row.id).changes;
    }
    return applied;
  })();
}

module.exports = { BATCH, pendingGroups, suggestBatch, listSuggestions, applySuggestions, dismissSuggestion, usersWithUnsorted, autoCategorize };
