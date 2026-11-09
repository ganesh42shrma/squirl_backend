const { getDb } = require('../../config/db');
const AppError = require('../../core/AppError');
const logger = require('../../core/logger');
const { nowIso, updateRow } = require('../../core/sql');
const { hashPassword, verifyPassword } = require('../../core/password');
const { toUser, insertUser } = require('./user.model');
const { seedDefaults, adoptUnowned } = require('./defaults');
const { contactsFor, normalizeName, familyPolicy } = require('./family');
const familyWorker = require('./family.worker');
const { normalizePhone, memberCandidate } = require('./contact.helper');
const { insertCategory } = require('../categories/category.model');

const findRow = (id) => getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
const findByEmail = (email) => getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);

/**
 * Creates an account. The very first account adopts any data that existed before accounts did;
 * every account gets the default categories and tags.
 */
async function createUser({ email, name, password }) {
  if (findByEmail(email)) throw AppError.conflict('An account with this email already exists', 'EMAIL_TAKEN');
  const passwordHash = await hashPassword(password);

  const db = getDb();
  const { id, adopted } = db.transaction(() => {
    const userId = insertUser(db, { email, name, passwordHash });
    const isFirst = db.prepare('SELECT count(*) FROM users').pluck().get() === 1;
    const adoptedRows = isFirst ? adoptUnowned(db, userId) : 0;
    seedDefaults(db, userId);
    return { id: userId, adopted: adoptedRows };
  })();

  logger.info('Account created', { userId: id, adoptedRows: adopted });
  return findRow(id);
}

async function getProfile(userId) {
  const user = toUser(findRow(userId));
  if (!user) throw AppError.notFound('Account not found');
  const db = getDb();
  const count = (table) => db.prepare(`SELECT count(*) FROM active_${table} WHERE user_id = ?`).pluck().get(userId);
  return { ...user, dashboardConfig: JSON.parse(findRow(userId).dashboard_config || 'null'), familyContacts: contactsFor(db, userId), stats: { transactions: count('transactions'), imports: count('imports'), categories: count('categories') } };
}

async function updateProfile(userId, { name, email, familyContacts, dashboardConfig }) {
  if (email) {
    const other = findByEmail(email);
    if (other && other.id !== userId) throw AppError.conflict('An account with this email already exists', 'EMAIL_TAKEN');
  }
  const changes = { updated_at: nowIso() };
  if (name !== undefined) changes.name = name;
  if (email !== undefined) changes.email = email;
  if (dashboardConfig !== undefined) changes.dashboard_config = JSON.stringify(dashboardConfig);
  const db = getDb();
  db.transaction(() => {
    updateRow(db, 'users', userId, changes);
    if (familyContacts !== undefined) saveContacts(db, userId, familyContacts);
  })();
  if (familyContacts !== undefined) familyWorker.nudge();
  return getProfile(userId);
}

function saveContacts(db, userId, contacts) {
  for (const category of ['Family', 'Other']) {
    if (!db.prepare('SELECT id FROM active_categories WHERE user_id = ? AND lower(name) = ? AND type = ? AND (? = 0 OR parent_id IS NULL)').get(userId, category.toLowerCase(), 'expense', category === 'Family' ? 1 : 0)) {
      insertCategory(db, userId, { name: category, type: 'expense' });
    }
  }
  updateRow(db, 'users', userId, { family_contacts: JSON.stringify(contacts), updated_at: nowIso() });
  familyWorker.enqueue(db, userId);
}

async function addFamilyMember(userId, { transactionId, ...member }) {
  const db = getDb();
  db.transaction(() => {
    const tx = db.prepare('SELECT id, description FROM active_transactions WHERE id = ? AND user_id = ?').get(transactionId, userId);
    if (!tx) throw AppError.notFound('Transaction not found');
    const contacts = contactsFor(db, userId);
    const candidate = memberCandidate(tx.description);
    const index = contacts.findIndex((c) =>
      (member.phone && normalizePhone(c.phone) === normalizePhone(member.phone)) ||
      [c.name, ...(c.aliases || [])].some((n) => normalizeName(n) === normalizeName(member.name)));
    const existing = index >= 0 ? contacts[index] : null;
    const names = [existing?.name, ...(existing?.aliases || []), ...(member.aliases || []), candidate.name].filter(Boolean);
    const aliases = [...new Map(names.filter((n) => normalizeName(n) !== normalizeName(member.name)).map((n) => [normalizeName(n), n])).values()];
    if (aliases.length > 20) throw AppError.badRequest('This member has too many alternate names. Edit them in Profile.');
    const saved = { ...member, phone: member.phone || existing?.phone || '', relationship: member.relationship || existing?.relationship || '', aliases };
    if (index >= 0) contacts[index] = saved;
    else {
      if (contacts.length >= 200) throw AppError.badRequest('You can save up to 200 family members and friends.');
      contacts.push(saved);
    }
    saveContacts(db, userId, contacts);
    // This row is an explicit choice, even if it had a confirmed category before.
    db.prepare('UPDATE transactions SET category_id = ?, auto_categorized = 0, updated_at = ? WHERE deleted_at IS NULL AND id = ? AND user_id = ?').run(familyPolicy(db, userId).familyId, nowIso(), tx.id, userId);
  })();
  familyWorker.nudge();
  return getProfile(userId);
}

async function assertPassword(userId, password) {
  const row = findRow(userId);
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    throw new AppError('That password isn’t right', 403, 'WRONG_PASSWORD');
  }
}

/** Returns the new password_changed_at, which ends every other session (see requireAuth). */
async function changePassword(userId, { currentPassword, newPassword }) {
  await assertPassword(userId, currentPassword);
  const now = nowIso();
  updateRow(getDb(), 'users', userId, { password_hash: await hashPassword(newPassword), password_changed_at: now, updated_at: now });
  logger.info('Password changed', { userId });
  return now;
}

// Deletes the account and, through ON DELETE CASCADE, every row it owns.
async function deleteAccount(userId, { password }) {
  await assertPassword(userId, password);
  const db = getDb();
  db.transaction(() => {
    // Explicit order instead of relying on cascades: transactions and subcategories point at
    // categories with RESTRICT, so dependants go before what they depend on.
    for (const sql of [
      'DELETE FROM goals WHERE user_id = ?', // goal contributions and analyses cascade
      'DELETE FROM transactions WHERE user_id = ?', // transaction_tags cascade
      'DELETE FROM merchant_rules WHERE user_id = ?',
      'DELETE FROM merchant_suggestions WHERE user_id = ?',
      'DELETE FROM commitments WHERE user_id = ?',
      'DELETE FROM imports WHERE user_id = ?',
      'DELETE FROM tags WHERE user_id = ?',
      'DELETE FROM categories WHERE user_id = ? AND parent_id IS NOT NULL',
      'DELETE FROM categories WHERE user_id = ?',
      'DELETE FROM users WHERE id = ?',
    ]) {
      db.prepare(sql).run(userId);
    }
  })();
  logger.info('Account deleted', { userId });
}

async function resetFinancialData(userId) {
  const db = getDb();
  if (!findRow(userId)) throw AppError.notFound('Account not found');
  const result = db.transaction(() => {
    const now = nowIso();
    updateRow(db, 'users', userId, { transactions_reset_at: now, financial_generation: findRow(userId).financial_generation + 1, updated_at: now });
    const archived = {};
    for (const table of ['goals', 'transactions', 'imports', 'commitments', 'merchant_rules', 'merchant_suggestions', 'categories', 'tags']) {
      archived[table] = db.prepare(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND deleted_at IS NULL`).run(now, now, userId).changes;
    }
    seedDefaults(db, userId);
    db.prepare("UPDATE family_sync_jobs SET status = 'cancelled', updated_at = ? WHERE user_id = ?").run(now, userId);
    return { archived };
  })();
  require('../insights/suggestions.worker').resetForUser(userId);
  return result;
}

module.exports = { createUser, findByEmail, getProfile, updateProfile, changePassword, deleteAccount, addFamilyMember, resetFinancialData };
