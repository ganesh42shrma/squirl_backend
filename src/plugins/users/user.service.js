const { getDb } = require('../../config/db');
const AppError = require('../../core/AppError');
const logger = require('../../core/logger');
const { nowIso, updateRow } = require('../../core/sql');
const { hashPassword, verifyPassword } = require('../../core/password');
const { toUser, insertUser } = require('./user.model');
const { seedDefaults, adoptUnowned } = require('./defaults');
const people = require('../people/people.service');
const media = require('../media/media.service');

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
  const row = findRow(userId);
  return {
    ...user,
    phone: row.phone, bio: row.bio, birthday: row.birthday, city: row.city, currency: row.currency,
    avatarMediaId: media.avatarMediaId(userId),
    dashboardConfig: JSON.parse(row.dashboard_config || 'null'), stats: { transactions: count('transactions'), imports: count('imports'), categories: count('categories') } };
}

async function updateProfile(userId, { name, email, dashboardConfig, ...details }) {
  if (email) {
    const other = findByEmail(email);
    if (other && other.id !== userId) throw AppError.conflict('An account with this email already exists', 'EMAIL_TAKEN');
  }
  const changes = { updated_at: nowIso() };
  if (name !== undefined) changes.name = name;
  if (email !== undefined) changes.email = email;
  for (const key of ['phone', 'bio', 'birthday', 'city', 'currency']) if (details[key] !== undefined) changes[key] = details[key];
  if (dashboardConfig !== undefined) changes.dashboard_config = JSON.stringify(dashboardConfig);
  updateRow(getDb(), 'users', userId, changes);
  return getProfile(userId);
}

// The ledger shortcut "add to family" now saves into Your circle (see people.service).
async function addFamilyMember(userId, body) {
  return people.addFamilyFromTransaction(userId, body);
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
  // Photo files live outside the database, so list them now and erase them once the rows are gone.
  const photos = media.collectUserMedia(db, userId);
  db.transaction(() => {
    // Explicit order instead of relying on cascades: transactions and subcategories point at
    // categories with RESTRICT, so dependants go before what they depend on.
    for (const sql of [
      'DELETE FROM attachments WHERE user_id = ?',
      'DELETE FROM media WHERE user_id = ?',
      'DELETE FROM goals WHERE user_id = ?', // goal contributions and analyses cascade
      'DELETE FROM people WHERE user_id = ?', // their numbers and linked ids cascade
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
  media.eraseFiles(photos);
  logger.info('Account deleted', { userId });
}

async function resetFinancialData(userId) {
  const db = getDb();
  if (!findRow(userId)) throw AppError.notFound('Account not found');
  const result = db.transaction(() => {
    const now = nowIso();
    updateRow(db, 'users', userId, { transactions_reset_at: now, financial_generation: findRow(userId).financial_generation + 1, updated_at: now });
    db.prepare('UPDATE sms_devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
    const archived = {};
    for (const table of ['captures', 'sms_events', 'sms_accounts', 'goals', 'transactions', 'imports', 'commitments', 'merchant_rules', 'merchant_suggestions', 'categories', 'tags']) {
      archived[table] = db.prepare(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND deleted_at IS NULL`).run(now, now, userId).changes;
    }
    // `people` (Your circle) and its linked ids are deliberately not in the list above: contacts are not financial data.
    seedDefaults(db, userId);
    db.prepare("UPDATE family_sync_jobs SET status = 'cancelled', updated_at = ? WHERE user_id = ?").run(now, userId);
    // "Start fresh" also removes receipt photos on transactions, goals, EMIs & bills and capture inbox notes (the
    // one deliberate exception to soft retention above: a photo is far more sensitive than a row). Task photos are
    // not financial data.
    return { archived, photos: media.detachOwnerTypes(db, userId, ['transaction', 'goal', 'commitment', 'capture'], now) };
  })();
  media.purgeFiles(result.photos); // files go only after the database change has committed
  delete result.photos;
  require('../insights/suggestions.worker').resetForUser(userId);
  return result;
}

module.exports = { createUser, findByEmail, getProfile, updateProfile, changePassword, deleteAccount, addFamilyMember, resetFinancialData };
