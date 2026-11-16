const { insertRow, newId, nowIso, placeholders } = require('../../core/sql');

// Tables: people, person_phones, person_identifiers. Every query below is scoped by user_id.
const MAX_PEOPLE = 20_000;
const MAX_FAMILY = 200; // the old Family & friends limit; the Family rules check every one of them per payment
const MAX_PHONES = 10;
const MAX_ALIASES = 20;

const parseAliases = (text) => { try { const a = JSON.parse(text || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

function toPerson(row, phones = []) {
  return {
    _id: row.id,
    name: row.name,
    isFamily: row.is_family === 1,
    relationship: row.relationship,
    aliases: parseAliases(row.aliases),
    phones,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Rows of `people` → API objects, with their phones loaded in one query.
function withPhones(db, userId, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const byPerson = new Map(ids.map((id) => [id, []]));
  for (const { person_id: id, phone } of db.prepare(`SELECT person_id, phone FROM person_phones WHERE user_id = ? AND person_id IN (${placeholders(ids)}) ORDER BY rowid`).all(userId, ...ids)) byPerson.get(id).push(phone);
  return rows.map((row) => toPerson(row, byPerson.get(row.id)));
}

function findPerson(db, userId, id) {
  const row = db.prepare('SELECT * FROM active_people WHERE id = ? AND user_id = ?').get(id, userId);
  return row ? withPhones(db, userId, [row])[0] : null;
}

function insertPerson(db, userId, { name, isFamily = false, relationship = '', aliases = [], source = 'manual' }) {
  const id = newId();
  const now = nowIso();
  insertRow(db, 'people', { id, user_id: userId, name, is_family: isFamily ? 1 : 0, relationship, aliases: JSON.stringify(aliases), source, created_at: now, updated_at: now });
  return id;
}

function insertPhones(db, userId, personId, phones) {
  const insert = db.prepare('INSERT INTO person_phones (person_id, user_id, phone, created_at) VALUES (?, ?, ?, ?)');
  const now = nowIso();
  for (const phone of phones) insert.run(personId, userId, phone, now);
}

module.exports = { MAX_PEOPLE, MAX_FAMILY, MAX_PHONES, MAX_ALIASES, toPerson, withPhones, findPerson, insertPerson, insertPhones, parseAliases };
