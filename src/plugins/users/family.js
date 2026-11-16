const { counterparty } = require('../rules/rules.helper');
const { upiPhones } = require('./contact.helper');

const normalizeName = (value) => String(value || '').normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

// The people marked as family: the ONLY people the Family category ever looks at. Other people in the circle,
// and the UPI ids / payee names a person linked to someone by hand, are labels and never feed this.
function familyMembers(db, userId) {
  const phones = new Map();
  for (const row of db.prepare('SELECT person_id, phone FROM person_phones WHERE user_id = ? AND person_id IN (SELECT id FROM active_people WHERE user_id = ? AND is_family = 1)').all(userId, userId)) {
    if (!phones.has(row.person_id)) phones.set(row.person_id, []);
    phones.get(row.person_id).push(row.phone);
  }
  return db.prepare('SELECT id, name, aliases FROM active_people WHERE user_id = ? AND is_family = 1 ORDER BY rowid').all(userId)
    .map((p) => ({ name: p.name, aliases: JSON.parse(p.aliases || '[]'), phones: phones.get(p.id) || [] }));
}

function familyPolicy(db, userId) {
  const members = familyMembers(db, userId);
  const names = new Set(members.flatMap((m) => [m.name, ...m.aliases]).map(normalizeName));
  const phones = new Set(members.flatMap((m) => m.phones));
  const categories = db.prepare('SELECT id, name, parent_id, type FROM active_categories WHERE user_id = ?').all(userId);
  const family = categories.find((c) => !c.parent_id && c.name.toLowerCase() === 'family');
  const other = categories.find((c) => c.type === 'expense' && c.name.toLowerCase() === 'other');
  const familyRoots = new Set(categories.filter((c) => !c.parent_id && /\bfamily\b/i.test(c.name)).map((c) => c.id));
  const familyIds = new Set(categories.filter((c) => familyRoots.has(c.id) || familyRoots.has(c.parent_id)).map((c) => c.id));
  const matches = (description) => names.has(normalizeName(counterparty(description).name)) || upiPhones(description).some((phone) => phones.has(phone));
  return {
    matches,
    familyId: family?.id,
    otherId: other?.id,
    familyIds,
    // A name alone is never evidence of a relationship. Apply this to cached answers too.
    categoryFor(description, proposed, isPerson = false) {
      if (matches(description)) return family?.id || null;
      if (isPerson || familyIds.has(proposed)) return other?.id || null;
      return proposed;
    },
  };
}

module.exports = { normalizeName, familyMembers, familyPolicy };
