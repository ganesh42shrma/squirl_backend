const { getDb } = require('../../config/db');
const { newId, nowIso } = require('../../core/sql');
const AppError = require('../../core/AppError');
const { getTransaction } = require('../transactions/transaction.service');

function record(db, userId, transactionId) {
  db.prepare(`INSERT OR IGNORE INTO payment_prompts (id, user_id, transaction_id, generation, created_at)
    SELECT ?, id, ?, financial_generation, ? FROM users WHERE id = ?`)
    .run(newId(), transactionId, nowIso(), userId);
}

function pending(db, subscription, now) {
  const details = JSON.parse(subscription.preferences || '{}').details !== false;
  return db.prepare(`SELECT p.id, p.created_at, t.description, t.amount_paise, t.type FROM payment_prompts p
    JOIN users u ON u.id = p.user_id AND u.financial_generation = p.generation
    JOIN active_transactions t ON t.id = p.transaction_id AND t.user_id = p.user_id
    WHERE p.user_id = ? AND p.answered_at IS NULL AND COALESCE(t.notes, '') = ''
      AND p.created_at >= ? AND p.created_at >= ? AND p.created_at <= ?
    ORDER BY p.created_at, p.id`).all(subscription.user_id, subscription.created_at,
      new Date(now.getTime() - 86400_000).toISOString(), now.toISOString())
    .map((p) => ({ key: `sms-payment:${p.id}`, kind: 'sms_payment', tag: `sms-payment-${p.id}`, promptId: p.id,
      ...(details && { detail: { amount: p.amount_paise / 100, type: p.type, party: p.description.slice(0, 60), at: p.created_at } }) }));
}

function promptFor(db, userId, id) {
  const prompt = db.prepare(`SELECT p.*, t.notes FROM payment_prompts p
    JOIN users u ON u.id = p.user_id AND u.financial_generation = p.generation
    JOIN active_transactions t ON t.id = p.transaction_id AND t.user_id = p.user_id
    WHERE p.id = ? AND p.user_id = ?`).get(id, userId);
  if (!prompt) throw AppError.notFound('This payment is no longer available');
  return prompt;
}
async function get(userId, id) {
  const db = getDb();
  const prompt = promptFor(db, userId, id);
  return { transaction: await getTransaction(userId, prompt.transaction_id), answeredAt: prompt.answered_at };
}
async function reply(userId, id, note) {
  const db = getDb();
  db.transaction(() => {
    const prompt = promptFor(db, userId, id);
    if (prompt.answered_at) {
      if (prompt.answer === note) return; // A retried notification reply must not append twice.
      throw AppError.conflict('A note was already added. Open the ledger to edit it.', 'PAYMENT_ALREADY_ANSWERED');
    }
    const notes = prompt.notes ? `${prompt.notes}\n${note}` : note;
    if (notes.length > 1000) throw AppError.conflict('This payment already has a long note. Open the ledger to edit it.', 'PAYMENT_NOTE_FULL');
    const now = nowIso();
    db.prepare('UPDATE transactions SET notes = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(notes, now, prompt.transaction_id, userId);
    db.prepare('UPDATE payment_prompts SET answer = ?, answered_at = ? WHERE id = ?').run(note, now, id);
  })();
  return get(userId, id);
}

module.exports = { record, pending, get, reply };
