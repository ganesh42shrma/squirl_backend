const { getDb } = require('../../config/db');
const AppError = require('../../core/AppError');
const { nowIso } = require('../../core/sql');
const { insertCategory } = require('../categories/category.model');
const { normalizeName, familyPolicy } = require('../users/family');
const familyWorker = require('../users/family.worker');
const { normalizePhone, upiPhones, linkKeys, memberCandidate } = require('../users/contact.helper');
const { parseVcf } = require('./vcard');
const { MAX_PEOPLE, MAX_FAMILY, MAX_PHONES, MAX_ALIASES, withPhones, findPerson, insertPerson, insertPhones } = require('./people.model');

// Plain-text search: a name contains the words, or a phone number contains 3+ typed digits.
function searchClause(search) {
  const needle = String(search || '').trim().toLowerCase();
  if (!needle) return { sql: '', params: [] };
  const digits = needle.replace(/\D/g, '');
  const byPhone = digits.length >= 3 ? ' OR EXISTS (SELECT 1 FROM person_phones ph WHERE ph.person_id = p.id AND instr(ph.phone, ?) > 0)' : '';
  return { sql: ` AND (instr(lower(p.name), ?) > 0${byPhone})`, params: byPhone ? [needle, digits] : [needle] };
}

async function listPeople(userId, { search, family, page = 1, limit = 50 }) {
  const db = getDb();
  const found = searchClause(search);
  const where = `p.user_id = ?${family ? ' AND p.is_family = 1' : ''}${found.sql}`;
  const params = [userId, ...found.params];
  const rows = db.prepare(`SELECT p.* FROM active_people p WHERE ${where} ORDER BY p.name COLLATE NOCASE, p.rowid LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit);
  const total = db.prepare(`SELECT count(*) FROM active_people p WHERE ${where}`).pluck().get(...params);
  const counts = db.prepare('SELECT count(*) AS circle, ifnull(sum(is_family), 0) AS family FROM active_people WHERE user_id = ?').get(userId);
  return { items: withPhones(db, userId, rows), meta: { page, limit, total, pages: Math.ceil(total / limit), circle: counts.circle, family: counts.family } };
}

/** The palette's people results: a few matches, best (alphabetical) first. */
function searchPeople(db, userId, q, limit = 4) {
  const found = searchClause(q);
  const rows = db.prepare(`SELECT p.* FROM active_people p WHERE p.user_id = ?${found.sql} ORDER BY p.name COLLATE NOCASE, p.rowid LIMIT ?`).all(userId, ...found.params, limit);
  return withPhones(db, userId, rows);
}

async function getPerson(userId, id) {
  const person = findPerson(getDb(), userId, id);
  if (!person) throw AppError.notFound('Person not found');
  return person;
}

// The Family and Other categories must exist before anyone is marked family (the sort-out worker needs them).
function ensureFamilyCategories(db, userId) {
  for (const category of ['Family', 'Other']) {
    if (!db.prepare('SELECT id FROM active_categories WHERE user_id = ? AND lower(name) = ? AND type = ? AND (? = 0 OR parent_id IS NULL)').get(userId, category.toLowerCase(), 'expense', category === 'Family' ? 1 : 0)) {
      insertCategory(db, userId, { name: category, type: 'expense' });
    }
  }
}

// What the Family rules see of one person. If it changes (or the person is/was family), past payments need a re-sort.
const familySignature = (person) => JSON.stringify([person.isFamily, person.name, person.aliases, [...person.phones].sort()]);

// Same job the old profile save did: make sure the categories exist and queue the resumable re-sort.
function touchFamily(db, userId) {
  ensureFamilyCategories(db, userId);
  familyWorker.enqueue(db, userId);
}

function assertFamilyRoom(db, userId, excludingId) {
  const count = db.prepare('SELECT count(*) FROM active_people WHERE user_id = ? AND is_family = 1 AND id <> ?').pluck().get(userId, excludingId || '');
  if (count >= MAX_FAMILY) throw AppError.badRequest(`You can mark up to ${MAX_FAMILY} people as family.`, 'FAMILY_LIMIT');
}

function assertPhonesFree(db, userId, personId, phones) {
  for (const phone of phones) {
    const owner = db.prepare('SELECT p.name FROM person_phones ph JOIN active_people p ON p.id = ph.person_id WHERE ph.user_id = ? AND ph.phone = ? AND ph.person_id <> ?').get(userId, phone, personId || '');
    if (owner) throw AppError.conflict(`That number already belongs to ${owner.name}.`, 'PHONE_TAKEN');
  }
}

function replacePhones(db, userId, personId, phones) {
  assertPhonesFree(db, userId, personId, phones);
  db.prepare('DELETE FROM person_phones WHERE user_id = ? AND person_id = ?').run(userId, personId);
  insertPhones(db, userId, personId, phones);
}

async function createPerson(userId, data) {
  const db = getDb();
  const id = db.transaction(() => {
    if (db.prepare('SELECT count(*) FROM active_people WHERE user_id = ?').pluck().get(userId) >= MAX_PEOPLE) throw AppError.badRequest('Your circle is full.', 'CIRCLE_LIMIT');
    if (data.isFamily) assertFamilyRoom(db, userId);
    assertPhonesFree(db, userId, null, data.phones);
    const personId = insertPerson(db, userId, { ...data, source: 'manual' });
    insertPhones(db, userId, personId, data.phones);
    if (data.isFamily) touchFamily(db, userId);
    return personId;
  })();
  familyWorker.nudge();
  return findPerson(db, userId, id);
}

async function updatePerson(userId, id, data) {
  const db = getDb();
  db.transaction(() => {
    const before = findPerson(db, userId, id);
    if (!before) throw AppError.notFound('Person not found');
    const next = { ...before, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
    if (next.isFamily && !before.isFamily) assertFamilyRoom(db, userId, id);
    if (data.phones !== undefined) replacePhones(db, userId, id, data.phones);
    db.prepare('UPDATE people SET name = ?, is_family = ?, relationship = ?, aliases = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(next.name, next.isFamily ? 1 : 0, next.relationship, JSON.stringify(next.aliases), nowIso(), id, userId);
    const after = findPerson(db, userId, id);
    if ((before.isFamily || after.isFamily) && familySignature(before) !== familySignature(after)) touchFamily(db, userId);
  })();
  familyWorker.nudge();
  return findPerson(db, userId, id);
}

// Soft delete. Their numbers and learned ids go too (they would otherwise block the number for someone else).
async function removePerson(userId, id) {
  const db = getDb();
  db.transaction(() => {
    const person = findPerson(db, userId, id);
    if (!person) throw AppError.notFound('Person not found');
    const now = nowIso();
    db.prepare('UPDATE people SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(now, now, id, userId);
    db.prepare('DELETE FROM person_phones WHERE person_id = ? AND user_id = ?').run(id, userId);
    db.prepare('DELETE FROM person_identifiers WHERE person_id = ? AND user_id = ?').run(id, userId);
    if (person.isFamily) touchFamily(db, userId);
  })();
  familyWorker.nudge();
}

/**
 * Reads a .vcf and merges it into the circle by phone number. Imported people are never family, a match never
 * renames anyone or changes their family flag, and a family person never gains numbers from an import (that
 * would widen what the Family rules recognise). Nothing here queues a re-sort. The file itself is never kept.
 */
async function importContacts(userId, buffer) {
  const cards = parseVcf(buffer);
  const db = getDb();
  const summary = { cards: cards.length, added: 0, merged: 0, unchanged: 0, skipped: 0, heldBack: 0 };
  db.transaction(() => {
    const owner = new Map(db.prepare('SELECT phone, person_id FROM person_phones WHERE user_id = ?').all(userId).map((r) => [r.phone, r.person_id]));
    const family = new Set(db.prepare('SELECT id FROM active_people WHERE user_id = ? AND is_family = 1').pluck().all(userId));
    const phoneCount = db.prepare('SELECT count(*) FROM person_phones WHERE person_id = ?').pluck();
    let people = db.prepare('SELECT count(*) FROM active_people WHERE user_id = ?').pluck().get(userId);
    const touch = db.prepare('UPDATE people SET updated_at = ? WHERE id = ? AND user_id = ?');
    for (const { name, phones } of cards) {
      if (name.length < 2 || !phones.length) { summary.skipped += 1; continue; }
      const target = phones.map((p) => owner.get(p)).find(Boolean);
      if (!target) {
        if (people >= MAX_PEOPLE) throw AppError.badRequest('Your circle is full. Remove some people and try again.', 'CIRCLE_LIMIT');
        const id = insertPerson(db, userId, { name, source: 'import' });
        insertPhones(db, userId, id, phones);
        for (const p of phones) owner.set(p, id);
        people += 1;
        summary.added += 1;
        continue;
      }
      const fresh = phones.filter((p) => !owner.has(p));
      if (!fresh.length) { summary.unchanged += 1; continue; }
      if (family.has(target)) { summary.unchanged += 1; summary.heldBack += 1; continue; }
      const room = MAX_PHONES - phoneCount.get(target);
      if (room <= 0) { summary.unchanged += 1; continue; }
      insertPhones(db, userId, target, fresh.slice(0, room));
      for (const p of fresh.slice(0, room)) owner.set(p, target);
      touch.run(nowIso(), target, userId);
      summary.merged += 1;
    }
  })();
  return summary;
}

/**
 * The ledger shortcut "add to family": phone first, else a family member of the same name, else a new person.
 * The submitted name wins; the bank's wording for the payee is kept as an alias so it keeps matching.
 */
async function addFamilyFromTransaction(userId, { transactionId, ...member }) {
  const db = getDb();
  const id = db.transaction(() => {
    const tx = db.prepare('SELECT id, description FROM active_transactions WHERE id = ? AND user_id = ?').get(transactionId, userId);
    if (!tx) throw AppError.notFound('Transaction not found');
    const candidate = memberCandidate(tx.description);
    const phone = normalizePhone(member.phone);
    let existingId = phone ? db.prepare('SELECT person_id FROM person_phones WHERE user_id = ? AND phone = ?').pluck().get(userId, phone) : null;
    const existing = existingId ? findPerson(db, userId, existingId)
      : withPhones(db, userId, db.prepare('SELECT * FROM active_people WHERE user_id = ? AND is_family = 1').all(userId))
        .find((p) => [p.name, ...p.aliases].some((n) => normalizeName(n) === normalizeName(member.name))) || null;
    existingId = existing?._id || null;
    // Someone already family keeps their earlier names as aliases, as before. Someone only in the phone book does
    // not: the name they were saved under there was never a statement name, and must not start matching payments.
    const earlier = existing?.isFamily ? [existing.name, ...existing.aliases] : [];
    const names = [...earlier, ...(member.aliases || []), candidate.name].filter(Boolean);
    const aliases = [...new Map(names.filter((n) => normalizeName(n) !== normalizeName(member.name)).map((n) => [normalizeName(n), n])).values()];
    if (aliases.length > MAX_ALIASES) throw AppError.badRequest('This member has too many alternate names. Edit them in Your circle.');
    const relationship = member.relationship || existing?.relationship || '';
    const phones = [...new Set([...(existing?.phones || []), ...(phone ? [phone] : [])])];
    if (phones.length > MAX_PHONES) throw AppError.badRequest(`A person can have up to ${MAX_PHONES} numbers. Remove one in Your circle first.`, 'PHONE_LIMIT');
    if (!existing?.isFamily) assertFamilyRoom(db, userId, existingId);
    if (existing) {
      assertPhonesFree(db, userId, existingId, phones);
      db.prepare('UPDATE people SET name = ?, is_family = 1, relationship = ?, aliases = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(member.name, relationship, JSON.stringify(aliases), nowIso(), existingId, userId);
      replacePhones(db, userId, existingId, phones);
    } else {
      if (db.prepare('SELECT count(*) FROM active_people WHERE user_id = ?').pluck().get(userId) >= MAX_PEOPLE) throw AppError.badRequest('Your circle is full.', 'CIRCLE_LIMIT');
      assertPhonesFree(db, userId, null, phones);
      existingId = insertPerson(db, userId, { name: member.name, isFamily: true, relationship, aliases, source: 'manual' });
      insertPhones(db, userId, existingId, phones);
    }
    touchFamily(db, userId);
    // This row is an explicit choice, even if it had a confirmed category before.
    db.prepare('UPDATE transactions SET category_id = ?, auto_categorized = 0, updated_at = ? WHERE deleted_at IS NULL AND id = ? AND user_id = ?').run(familyPolicy(db, userId).familyId, nowIso(), tx.id, userId);
    return existingId;
  })();
  familyWorker.nudge();
  return findPerson(db, userId, id);
}

/* ── Ledger labels ─────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Who a payment is with, for labels and the person filter (they share this, so they always agree). One lookup of
 * the circle's numbers and linked ids per call; rows are then matched in memory. In order of trust:
 *   1. a UPI id the owner linked by hand,  2. a phone number inside the UPI id,  3. a payee name linked by hand.
 * Names are never matched on their own. Nothing here is read by the Family category rules.
 */
function labeler(db, userId) {
  const phoneOwner = new Map(db.prepare('SELECT phone, person_id FROM person_phones WHERE user_id = ?').all(userId).map((r) => [r.phone, r.person_id]));
  const linked = { vpa: new Map(), payee: new Map() };
  for (const r of db.prepare('SELECT kind, value, person_id FROM person_identifiers WHERE user_id = ?').all(userId)) linked[r.kind].set(r.value, r.person_id);
  const empty = !phoneOwner.size && !linked.vpa.size && !linked.payee.size;
  const people = new Map();
  const person = (id) => {
    if (!people.has(id)) people.set(id, db.prepare('SELECT id, name, is_family FROM active_people WHERE id = ? AND user_id = ?').get(id, userId) || null);
    return people.get(id);
  };

  // → { personId, via: 'link' | 'phone', kind?, value? } or null
  function explain(description) {
    if (empty) return null;
    const keys = linkKeys(description);
    if (keys.vpa && linked.vpa.has(keys.vpa)) return { personId: linked.vpa.get(keys.vpa), via: 'link', kind: 'vpa', value: keys.vpa };
    for (const phone of upiPhones(description)) if (phoneOwner.has(phone)) return { personId: phoneOwner.get(phone), via: 'phone' };
    if (keys.payee && linked.payee.has(keys.payee)) return { personId: linked.payee.get(keys.payee), via: 'link', kind: 'payee', value: keys.payee };
    return null;
  }
  function label(description) {
    const found = explain(description);
    const p = found && person(found.personId);
    return p ? { _id: p.id, name: p.name, isFamily: p.is_family === 1, via: found.via } : null;
  }
  return { explain, label, empty };
}

/** The ids of this account's payments that are with `personId`: exactly the rows the labels point at. */
function transactionIdsFor(db, userId, personId) {
  const match = labeler(db, userId);
  if (match.empty) return [];
  const ids = [];
  for (const row of db.prepare('SELECT id, description FROM active_transactions WHERE user_id = ?').iterate(userId)) {
    if (match.explain(row.description)?.personId === personId) ids.push(row.id);
  }
  return ids;
}

/** "Who is this?": remember a payment's UPI id (else payee name) for a person, or forget it when personId is null. */
async function linkTransaction(userId, transactionId, personId) {
  const db = getDb();
  db.transaction(() => {
    const tx = db.prepare('SELECT id, description FROM active_transactions WHERE id = ? AND user_id = ?').get(transactionId, userId);
    if (!tx) throw AppError.notFound('Transaction not found');
    const keys = linkKeys(tx.description);
    // Anything this payment taught earlier goes. Clearing also removes the hand-linked id that labels the row now
    // (whichever payment taught it). Re-linking leaves that one alone unless it is the very id being re-linked
    // (the insert below then moves it): a payee name linked from another payment keeps labelling that payment.
    const labelled = labeler(db, userId).explain(tx.description);
    db.prepare('DELETE FROM person_identifiers WHERE user_id = ? AND transaction_id = ?').run(userId, tx.id);
    if (!personId) {
      if (labelled?.via === 'link') db.prepare('DELETE FROM person_identifiers WHERE user_id = ? AND kind = ? AND value = ?').run(userId, labelled.kind, labelled.value);
      return;
    }
    if (!db.prepare('SELECT 1 FROM active_people WHERE id = ? AND user_id = ?').get(personId, userId)) throw AppError.notFound('Person not found');
    const [kind, value] = keys.vpa ? ['vpa', keys.vpa] : keys.payee ? ['payee', keys.payee] : [];
    if (!kind) throw AppError.badRequest('This payment has no UPI id or payee name Squirl can recognise, so it can’t be linked to someone.', 'NOTHING_TO_LINK');
    // Linking an id that is already linked moves it to this person.
    db.prepare(`INSERT INTO person_identifiers (person_id, user_id, kind, value, transaction_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, kind, value) DO UPDATE SET person_id = excluded.person_id, transaction_id = excluded.transaction_id`).run(personId, userId, kind, value, tx.id, nowIso());
  })();
}

module.exports = {
  listPeople, searchPeople, getPerson, createPerson, updatePerson, removePerson, importContacts, addFamilyFromTransaction,
  labeler, transactionIdsFor, linkTransaction,
};
