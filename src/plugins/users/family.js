const { counterparty } = require('../rules/rules.helper');
const { normalizePhone, upiPhones } = require('./contact.helper');

const normalizeName = (value) => String(value || '').normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const contactsFor = (db, userId) => JSON.parse(db.prepare('SELECT family_contacts FROM users WHERE id = ?').get(userId)?.family_contacts || '[]');

function familyPolicy(db, userId) {
  const contacts = contactsFor(db, userId);
  const names = new Set(contacts.flatMap((c) => [c.name, ...(c.aliases || [])]).map(normalizeName));
  const phones = new Set(contacts.map((c) => normalizePhone(c.phone)).filter(Boolean));
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

module.exports = { normalizeName, contactsFor, familyPolicy };
