const { createHash, randomBytes } = require('node:crypto');
const { getDb } = require('../../config/db');
const AppError = require('../../core/AppError');
const { insertRow, updateRow, newId, nowIso } = require('../../core/sql');
const { insertTransaction, addTags, getTags } = require('../transactions/transaction.model');
const { categoryFor } = require('../rules/rules.service');
const { parseSms, normalize } = require('./sms.parser');
const { matches, relatedPayments, linkTransfer } = require('./sms.reconcile');

// "JM-KOTAKB-S" -> "KOTAKB": the 2-letter operator/circle prefix and 1-letter type suffix vary by
// network, so only the DLT header identifies the bank. Mirrors BankFilter.header() on the phone.
const senderHeader = (id) => {
  const s = String(id).trim().toUpperCase();
  return /^(?:[A-Z]{2}-)?([A-Z0-9]{3,})(?:-[A-Z])?$/.exec(s)?.[1] || s;
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const failAuth = () => new AppError('Pair this SMS device again', 401, 'SMS_AUTH_REQUIRED');
const ack = (row) => ({ id: row.id, status: row.status, reason: row.reason || undefined, transactionId: row.transaction_id || undefined });

function listAccounts(userId) {
  return getDb().prepare('SELECT bank, last4, senders FROM sms_accounts WHERE user_id = ? AND deleted_at IS NULL').all(userId)
    .map((r) => ({ bank: r.bank, last4: r.last4, senders: JSON.parse(r.senders) }));
}

function saveAccounts(userId, { accounts }) {
  const db = getDb();
  db.transaction(() => {
    for (const account of accounts) {
      const existing = db.prepare('SELECT * FROM sms_accounts WHERE user_id = ? AND bank = ? AND deleted_at IS NULL').get(userId, account.bank);
      if (existing && existing.last4 !== account.last4) throw AppError.conflict('An account is already mapped for this bank. This version supports one account per bank.', 'SMS_ACCOUNT_LOCKED');
      if (existing) updateRow(db, 'sms_accounts', existing.id, { senders: JSON.stringify(account.senders), updated_at: nowIso() });
      else insertRow(db, 'sms_accounts', { id: newId(), user_id: userId, bank: account.bank, last4: account.last4,
        senders: JSON.stringify(account.senders), created_at: nowIso(), updated_at: nowIso() });
    }
  })();
  return listAccounts(userId);
}

function createDevice(userId, { name }) {
  const db = getDb();
  if (db.prepare('SELECT count(*) FROM sms_devices WHERE user_id = ? AND revoked_at IS NULL').pluck().get(userId) >= 5) throw AppError.badRequest('Revoke an old SMS device before pairing another');
  const user = db.prepare('SELECT password_changed_at, financial_generation FROM users WHERE id = ?').get(userId);
  const id = newId(), token = `${id}.${randomBytes(32).toString('base64url')}`;
  insertRow(db, 'sms_devices', { id, user_id: userId, name, token_hash: hash(token), password_changed_at: user.password_changed_at,
    generation: user.financial_generation, created_at: nowIso() });
  return { id, name, token }; // Returned once; only its hash is stored.
}
function listDevices(userId) {
  return getDb().prepare('SELECT id, name, created_at AS createdAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt FROM sms_devices WHERE user_id = ?').all(userId);
}
function revokeDevice(userId, id) {
  const { changes } = getDb().prepare('UPDATE sms_devices SET revoked_at = ? WHERE user_id = ? AND id = ?').run(nowIso(), userId, id);
  if (!changes) throw AppError.notFound('SMS device not found');
}
function authenticate(authorization) {
  const token = /^Bearer ([a-f0-9]{24}\.[\w-]{43})$/.exec(authorization || '')?.[1];
  if (!token) throw failAuth();
  const device = getDb().prepare(`SELECT d.* FROM sms_devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?
    AND d.revoked_at IS NULL AND d.password_changed_at = u.password_changed_at AND d.generation = u.financial_generation`).get(hash(token));
  if (!device) throw failAuth();
  return device;
}

function processParsed(db, event, parsed) {
  const binding = db.prepare('SELECT * FROM sms_accounts WHERE user_id = ? AND bank = ? AND last4 = ? AND deleted_at IS NULL')
    .get(event.user_id, parsed.bank, parsed.last4);
  if (!binding) return { status: 'review', reason: 'account_not_mapped' };
  const receivedDate = new Date(new Date(event.received_at).getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const age = (Date.parse(receivedDate) - Date.parse(parsed.date)) / 86400_000;
  if (age < 0 || age > 7) return { status: 'review', reason: 'date_outside_window' };
  const doc = { ...parsed, account: binding.bank, source: 'sms', autoCategorized: true };
  const candidates = matches(db, event.user_id, doc);
  if (candidates.length > 1) return { status: 'review', reason: 'ambiguous_match' };
  if (!candidates.length && relatedPayments(db, event.user_id, doc).length) return { status: 'review', reason: 'reference_conflict' };
  let transactionId, status;
  if (candidates.length === 1) {
    transactionId = candidates[0].id;
    status = candidates[0].source === 'import' ? 'reconciled' : 'duplicate';
    // An explicit review confirmation may reconnect quarantined SMS evidence to the statement.
    if (event.status === 'review' && event.transaction_id && event.transaction_id !== transactionId) {
      const previous = db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(event.transaction_id, event.user_id);
      if (previous) {
        const changes = {};
        if (previous.notes && !candidates[0].notes) changes.notes = previous.notes;
        if (previous.category_id && !previous.auto_categorized && (!candidates[0].category_id || candidates[0].auto_categorized)) {
          changes.category_id = previous.category_id; changes.auto_categorized = 0;
        }
        if (Object.keys(changes).length) updateRow(db, 'transactions', transactionId, { ...changes, updated_at: nowIso() });
        addTags(db, event.user_id, transactionId, getTags(db, event.transaction_id));
      }
    }
  } else {
    const archived = matches(db, event.user_id, doc, { includeDeleted: true }).find((r) => r.source === 'sms' && r.deleted_at);
    if (archived) return { status: 'ignored', reason: 'transaction_deleted' };
    doc.category = categoryFor(db, event.user_id, doc);
    transactionId = insertTransaction(db, event.user_id, doc);
    require('../notifications/payment-prompts').record(db, event.user_id, transactionId);
    status = 'captured';
  }
  // Save evidence before transfer pairing so a later statement can retain the SMS provenance.
  updateRow(db, 'sms_events', event.id, { transaction_id: transactionId, parsed: JSON.stringify(parsed) });
  linkTransfer(db, event.user_id, transactionId);
  return { status, reason: null, transaction_id: transactionId };
}

function ingest(device, input) {
  const db = getDb();
  const now = nowIso(), messageHash = hash(`${input.sender}\n${normalize(input.body)}`);
  return db.transaction(() => {
    const active = db.prepare(`SELECT d.id FROM sms_devices d JOIN users u ON u.id = d.user_id WHERE d.id = ? AND d.token_hash = ?
      AND d.revoked_at IS NULL AND d.password_changed_at = u.password_changed_at AND d.generation = u.financial_generation`).get(device.id, device.token_hash);
    if (!active) throw failAuth();
    const prior = db.prepare('SELECT * FROM sms_events WHERE device_id = ? AND event_key = ?').get(device.id, input.eventId);
    if (prior) {
      if (prior.message_hash !== messageHash || prior.received_at !== input.receivedAt) throw AppError.conflict('Event ID was already used for a different message', 'SMS_EVENT_REUSED');
      return ack(prior);
    }
    if (Date.parse(input.receivedAt) > Date.now() + 5 * 60_000 || Date.parse(input.receivedAt) < Date.parse(device.created_at)) {
      throw AppError.badRequest('Only new messages received after pairing can be submitted', 'SMS_EVENT_DATE');
    }
    const bindings = db.prepare('SELECT * FROM sms_accounts WHERE user_id = ? AND deleted_at IS NULL').all(device.user_id)
      .filter((a) => JSON.parse(a.senders).some((s) => senderHeader(s) === senderHeader(input.sender)));
    if (!bindings.length) return { status: 'ignored', reason: 'sender_not_allowed' }; // Do not retain personal messages.
    const old = db.prepare('SELECT * FROM sms_events WHERE user_id = ? AND message_hash = ? AND deleted_at IS NULL LIMIT 1').get(device.user_id, messageHash);
    const parsed = parseSms(input.body);
    const binding = bindings.find((a) => a.bank === parsed.bank) || (bindings.length === 1 ? bindings[0] : null);
    const event = { id: newId(), user_id: device.user_id, device_id: device.id, event_key: input.eventId, message_hash: messageHash,
      sender: input.sender, received_at: input.receivedAt, bank: binding?.bank || null,
      body: parsed.status === 'ignored' ? null : input.body, parsed: parsed.status === 'parsed' ? JSON.stringify(parsed) : null,
      status: 'review', reason: null, created_at: now, updated_at: now };
    insertRow(db, 'sms_events', event);
    let result;
    if (old) result = { status: 'duplicate', reason: 'message_already_received', transaction_id: old.transaction_id };
    else if (parsed.status !== 'parsed') result = { status: parsed.status, reason: parsed.reason };
    else if (!binding || binding.bank !== parsed.bank) result = { status: 'review', reason: 'sender_bank_mismatch' };
    else result = processParsed(db, event, parsed);
    updateRow(db, 'sms_events', event.id, { ...result, updated_at: now });
    updateRow(db, 'sms_devices', device.id, { last_seen_at: now });
    return ack(db.prepare('SELECT * FROM sms_events WHERE id = ?').get(event.id));
  })();
}

function listEvents(userId, { page, limit, status }) {
  const db = getDb(), condition = `user_id = ? AND deleted_at IS NULL${status ? ' AND status = ?' : ''}`;
  const params = status ? [userId, status] : [userId];
  const items = db.prepare(`SELECT id, sender, received_at AS receivedAt, bank, status, reason, transaction_id AS transactionId, body, parsed
    FROM sms_events WHERE ${condition} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit)
    .map((r) => ({ ...r, parsed: r.parsed ? JSON.parse(r.parsed) : null,
      ...(r.status === 'review' && r.transactionId && { previousTransaction: db.prepare(`SELECT date, description, amount_paise AS amountPaise, type, notes, category_id AS categoryId
        FROM transactions WHERE id = ? AND user_id = ?`).get(r.transactionId, userId) }),
    }));
  const total = db.prepare(`SELECT count(*) FROM sms_events WHERE ${condition}`).pluck().get(...params);
  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}
function reviewEvent(userId, id, fields) {
  const db = getDb();
  return db.transaction(() => {
    const event = db.prepare('SELECT * FROM sms_events WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, userId);
    if (!event) throw AppError.notFound('SMS event not found');
    if (event.status !== 'review') throw AppError.conflict('This event is no longer awaiting review');
    const result = fields ? processParsed(db, event, { ...fields, bank: event.bank, paymentMode: 'upi' }) : { status: 'dismissed', reason: null };
    updateRow(db, 'sms_events', id, { ...result, updated_at: nowIso() });
    return ack(db.prepare('SELECT * FROM sms_events WHERE id = ?').get(id));
  })();
}

module.exports = { senderHeader, listAccounts, saveAccounts, createDevice, listDevices, revokeDevice, authenticate, ingest, listEvents, reviewEvent };
