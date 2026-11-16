// Your circle: people, phone-book import, ledger labels, "Who is this?", the person filter and, above all, proof that
// categorisation did not change. Synthetic data, in-memory database, a loopback-only HTTP check; no files, accounts or models.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3-multiple-ciphers');
const db = new Database(':memory:');
const stub = (p, exports) => { require.cache[require.resolve(p)] = { exports }; };
stub('../src/config/db', { getDb: () => db });
stub('../src/core/logger', { info() {}, warn() {}, error() {} });
stub('../src/plugins/insights/suggestions.worker', { nudge() {}, resetForUser() {} });
const migrations = require('../src/config/migrations');

const { insertUser } = require('../src/plugins/users/user.model');
const { seedDefaults } = require('../src/plugins/users/defaults');
const { insertRow, newId, nowIso } = require('../src/core/sql');
const { counterparty } = require('../src/plugins/rules/rules.helper');
const { normalizeName, familyPolicy } = require('../src/plugins/users/family');
const { normalizePhone, upiPhones } = require('../src/plugins/users/contact.helper');
const familyWorker = require('../src/plugins/users/family.worker');
const people = require('../src/plugins/people/people.service');
const { parseVcf } = require('../src/plugins/people/vcard');
const peopleSchemas = require('../src/plugins/people/people.validation');
const transactions = require('../src/plugins/transactions/transaction.service');
const rules = require('../src/plugins/rules/rules.service');
const users = require('../src/plugins/users/user.service');

const drain = (userId) => { while (familyWorker.runBatch(db, userId, 50)) { /* finish the scan */ } };
const vcards = (...cards) => cards.join('\r\n');
const upi = (name, handle = 'handle123') => `WDL TFR UPI/DR/123456789012/${name}/SBIN/${handle}/Sent`;
const kotak = (name) => `UPI/${name}/SBIN/123456789012/Payment from`;

// ── The OLD policy, copied from before this feature, driven by a JSON list. The equivalence test below runs it
// next to the real familyPolicy to prove the Family category sees exactly what it saw before. ──
function legacyUpiPhones(description) {
  const raw = String(description || '').replace(/^(WDL|DEP)\s+TFR\s+/i, '').trim();
  const parts = raw.split('/').map((p) => p.trim());
  if (parts[0]?.toUpperCase() !== 'UPI') return [];
  const candidates = [];
  if (/^(DR|CR)$/i.test(parts[1]) && /^\d{6,}$/.test((parts[2] || '').replace(/\s/g, ''))) {
    if (/^[A-Z]{4}$/i.test((parts[4] || '').replace(/\s/g, ''))) candidates.push(parts[5]);
    if (parts[3]?.includes('@')) candidates.push(parts[3]);
  } else if (parts[1]?.includes('@')) {
    candidates.push(parts[1]);
  }
  return candidates.map((value) => normalizePhone(String(value || '').split('@')[0])).filter(Boolean);
}
function legacyPolicy(db2, userId, contacts) {
  const names = new Set(contacts.flatMap((c) => [c.name, ...(c.aliases || [])]).map(normalizeName));
  const phones = new Set(contacts.map((c) => normalizePhone(c.phone)).filter(Boolean));
  const categories = db2.prepare('SELECT id, name, parent_id, type FROM active_categories WHERE user_id = ?').all(userId);
  const family = categories.find((c) => !c.parent_id && c.name.toLowerCase() === 'family');
  const other = categories.find((c) => c.type === 'expense' && c.name.toLowerCase() === 'other');
  const familyRoots = new Set(categories.filter((c) => !c.parent_id && /\bfamily\b/i.test(c.name)).map((c) => c.id));
  const familyIds = new Set(categories.filter((c) => familyRoots.has(c.id) || familyRoots.has(c.parent_id)).map((c) => c.id));
  const matches = (description) => names.has(normalizeName(counterparty(description).name)) || legacyUpiPhones(description).some((phone) => phones.has(phone));
  return {
    matches, familyId: family?.id, otherId: other?.id, familyIds,
    categoryFor(description, proposed, isPerson = false) {
      if (matches(description)) return family?.id || null;
      if (isPerson || familyIds.has(proposed)) return other?.id || null;
      return proposed;
    },
  };
}

// ── Setup: schema as of v27, the old family list written the old way, then the v28 migration ──
db.pragma('foreign_keys = OFF');
for (const m of migrations.slice(0, 27)) typeof m === 'function' ? m(db) : db.exec(m);
const mkUser = (name = 'Test') => {
  const id = insertUser(db, { email: `${newId()}@example.invalid`, name, passwordHash: 'unused' });
  seedDefaults(db, id);
  return id;
};
const catId = (userId, name) => db.prepare('SELECT id FROM active_categories WHERE user_id = ? AND name = ?').pluck().get(userId, name);
const addTx = (userId, description, { category = null, auto = 0, source = 'import', date = '2026-11-01' } = {}) => {
  const id = newId();
  insertRow(db, 'transactions', { id, user_id: userId, date, description, amount_paise: 10000, type: 'debit', account: 'test', source, category_id: category, auto_categorized: auto, created_at: nowIso(), updated_at: nowIso() });
  return id;
};
const rowOf = (id) => db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);

const legacy = mkUser('Legacy');
const noList = mkUser('No list');
const corrupt = mkUser('Corrupt');
const LEGACY_LIST = [
  { name: 'Ananya Sharma', aliases: ['Ananya S', 'A Sharma'], phone: '9000000001', relationship: 'Sister' },
  { name: 'Ramesh K', aliases: [], phone: '', relationship: '' },
  { name: 'Same Number', aliases: [], phone: '9000000001', relationship: 'Friend' }, // shares a number with the first entry
  { name: 'रमेश कुमार', aliases: ['Ramesh Kumar'], phone: '+91 90000 00003', relationship: 'Father' }, // Hindi name, unnormalised phone
  { name: 'Bad Phone', aliases: [], phone: '12345', relationship: '' },
];
db.prepare('UPDATE users SET family_contacts = ? WHERE id = ?').run(JSON.stringify(LEGACY_LIST), legacy);
db.prepare('UPDATE users SET family_contacts = ? WHERE id = ?').run('{not json', corrupt);

const DESCRIPTIONS = [
  upi('ANANYA SHARMA'), upi('Ananya.Sharma'), upi('ANANYA S'), upi('A SHARMA'), upi('ANANYA'), upi('ANANYA SHARMA STORE'),
  upi('RAMESH K'), upi('RAMESH KUMAR'), upi('RAMESH'), upi('SAME NUMBER'), upi('BAD PHONE'), upi('UNRELATED PERSON'),
  'WDL TFR UPI/DR/123456789012/BANK DISPLAY NAME/SBIN/9000000001@ybl/Sent',
  'WDL TFR UPI/DR/123456789012/BANK DISPLAY NAME/SBIN/9000000003@okaxis/Sent',
  'UPI/DR/123456789012/DIFFERENT NAME/SBIN/919000000001@upi/NA',
  'UPI/DR/123456789012/DIFFERENT NAME/SBIN/custom9000000001@upi/NA',
  'UPI/DR/919000000001/DIFFERENT NAME/SBIN/customhandle@upi/NA',
  kotak('ANANYA SHARMA'), kotak('RAMESH K'), kotak('SOMEONE ELSE'),
  'UPI/9000000001@ybl/SBIN/123456789012/Payment from', 'UPI/9000000002@ybl/SBIN/123456789012/Payment from',
  'NEFT*SBIN0000001*AXN12345678*ANANYA SHARMA', 'NEFT*SBIN0000001*9000000001*DIFFERENT NAME', 'IMPS/P2A/123456/RAMESH K/SBIN',
  'SMS ALERT CHG FOR THE MONTH OF JUL26', 'UPI', 'ATM WDL 5000', upi('Swiggy', 'swiggy@icici'), upi('रमेश कुमार'),
];

migrations[27](db); // v28 (the real migration, on a populated v27 schema)
db.pragma('foreign_keys = ON');
assert.equal(db.pragma('foreign_key_check').length, 0);

// Every category this account could be sorted into, for the grid below.
const grid = (userId) => {
  const f = catId(userId, 'Family'); const o = catId(userId, 'Other'); const food = catId(userId, 'Food & Drinks');
  return [undefined, null, f, o, food];
};
// categoryFor/matches for every description × proposal × person flag, from a policy object.
const sweep = (policy, userId) => DESCRIPTIONS.flatMap((d) => [policy.matches(d), ...grid(userId).flatMap((proposed) => [false, true].map((p) => policy.categoryFor(d, proposed, p)))]);

async function main() {
  // ── 1. Migration of the old JSON ──
  const migrated = (await people.listPeople(legacy, { limit: 100 })).items;
  assert.deepEqual(migrated.map((p) => p.name), [...LEGACY_LIST.map((c) => c.name)].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0), 'every old entry became a person');
  assert.ok(migrated.every((p) => p.isFamily && p.source === 'manual'));
  const by = (name) => migrated.find((p) => p.name === name);
  assert.deepEqual(by('Ananya Sharma').aliases, ['Ananya S', 'A Sharma']);
  assert.equal(by('Ananya Sharma').relationship, 'Sister');
  assert.deepEqual(by('Ananya Sharma').phones, ['9000000001']);
  assert.deepEqual(by('Same Number').phones, [], 'a number already held by an earlier entry is not duplicated');
  assert.deepEqual(by('रमेश कुमार').phones, ['9000000003'], 'phones are normalised');
  assert.deepEqual(by('रमेश कुमार').aliases, ['Ramesh Kumar']);
  assert.deepEqual(by('Bad Phone').phones, []);
  assert.equal((await people.listPeople(noList, {})).meta.total, 0);
  assert.equal((await people.listPeople(corrupt, {})).meta.total, 0, 'an unreadable old list is skipped, not fatal');
  assert.equal(JSON.parse(db.prepare('SELECT family_contacts FROM users WHERE id = ?').pluck().get(legacy)).length, LEGACY_LIST.length, 'the old column is left as it was');
  assert.equal(db.prepare('SELECT count(*) FROM family_sync_jobs').pluck().get(), 0, 'the migration queues no re-sort: nothing about Family changed');

  // ── 2. Categorisation equivalence: old JSON policy vs the real policy over the migrated people ──
  const before = sweep(legacyPolicy(db, legacy, LEGACY_LIST), legacy);
  assert.ok(before.some(Boolean));
  assert.deepEqual(sweep(familyPolicy(db, legacy), legacy), before, 'identical answers for every payment, proposal and person flag');
  assert.ok(DESCRIPTIONS.some((d) => legacyPolicy(db, legacy, LEGACY_LIST).matches(d)) && DESCRIPTIONS.some((d) => !legacyPolicy(db, legacy, LEGACY_LIST).matches(d)), 'the grid covers both outcomes');
  // The same through the worker that re-sorts existing rows, and through the import rule path.
  const food = catId(legacy, 'Food & Drinks'); const family = catId(legacy, 'Family');
  const rows = DESCRIPTIONS.flatMap((d) => [addTx(legacy, d), addTx(legacy, d, { category: food, auto: 1 }), addTx(legacy, d, { category: family, auto: 1 }), addTx(legacy, d, { category: food, auto: 0 })]);
  const old = legacyPolicy(db, legacy, LEGACY_LIST);
  const expected = rows.map((id) => {
    const r = rowOf(id);
    return old.matches(r.description) ? old.familyId : r.auto_categorized && old.familyIds.has(r.category_id) ? old.otherId : r.category_id;
  });
  familyWorker.enqueue(db, legacy);
  drain(legacy);
  assert.deepEqual(rows.map((id) => rowOf(id).category_id), expected, 'the sort-out worker lands every row where the old list would have');
  for (const d of DESCRIPTIONS) assert.equal(rules.categoryFor(db, legacy, { description: d, type: 'debit' }) === old.familyId, old.matches(d), `import rule path agrees for ${d}`);

  // Importing 100 contacts, linking people to payments and renaming non-family people change no category.
  const snapshot = () => rows.map((id) => rowOf(id).category_id);
  const categoriesBefore = snapshot();
  const sweepBefore = sweep(familyPolicy(db, legacy), legacy);
  const jobBefore = JSON.stringify(familyWorker.statusFor(legacy));
  const hundred = vcards(...Array.from({ length: 100 }, (_, i) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Contact ${String(i).padStart(3, '0')}\r\nTEL;TYPE=CELL:+91 9100${String(i).padStart(6, '0')}\r\nEND:VCARD`));
  const result = await people.importContacts(legacy, Buffer.from(hundred));
  assert.deepEqual(result, { cards: 100, added: 100, merged: 0, unchanged: 0, skipped: 0, heldBack: 0 });
  // Imported people that share a family person's NAME (different number) stay non-family and match nothing by name.
  await people.importContacts(legacy, Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ananya Sharma\r\nTEL:+91 98000 11111\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Swiggy\r\nTEL:9800022222\r\nEND:VCARD'));
  const shop = (await people.listPeople(legacy, { search: 'swiggy' })).items[0];
  const swiggyTx = addTx(legacy, upi('Swiggy', 'swiggy@icici'));
  await people.linkTransaction(legacy, swiggyTx, shop._id);
  const strangerTx = addTx(legacy, upi('UNRELATED PERSON', 'stranger@okaxis'));
  const familyOne = (await people.listPeople(legacy, { search: 'ananya', family: true })).items[0];
  await people.linkTransaction(legacy, strangerTx, familyOne._id); // a stranger's payment linked to a FAMILY person
  await people.updatePerson(legacy, shop._id, { name: 'Swiggy Instamart', phones: ['9800022222', '9800033333'] });
  assert.equal(JSON.stringify(familyWorker.statusFor(legacy)), jobBefore, 'none of that queued a re-sort');
  assert.deepEqual(sweep(familyPolicy(db, legacy), legacy), sweepBefore, 'policy answers unchanged');
  assert.deepEqual(sweep(familyPolicy(db, legacy), legacy), before, '...and still identical to the old list');
  assert.equal(familyPolicy(db, legacy).matches(upi('UNRELATED PERSON', 'stranger@okaxis')), false, 'a linked id never makes a payment Family');
  assert.equal(rules.categoryFor(db, legacy, { description: upi('UNRELATED PERSON', 'stranger@okaxis'), type: 'debit' }), null);
  familyWorker.enqueue(db, legacy); drain(legacy);
  assert.deepEqual(snapshot(), categoriesBefore, 'a full re-sort afterwards moves nothing');
  assert.equal(rowOf(strangerTx).category_id, null);
  // A brand-new account: importing 100 non-family contacts leaves every payment's category as it was.
  const fresh = mkUser();
  const freshRows = DESCRIPTIONS.map((d) => addTx(fresh, d));
  const freshBefore = freshRows.map((id) => rowOf(id).category_id);
  await people.importContacts(fresh, Buffer.from(hundred));
  assert.equal(familyWorker.statusFor(fresh).status, 'idle');
  familyWorker.enqueue(db, fresh); drain(fresh);
  assert.deepEqual(freshRows.map((id) => rowOf(id).category_id), freshBefore);
  assert.equal(db.prepare('SELECT count(*) FROM active_people WHERE user_id = ? AND is_family = 1').pluck().get(fresh), 0, 'import never marks anyone family');

  // ── 3. vCard parsing ──
  const qp = (text) => [...Buffer.from(text, 'utf8')].map((b) => `=${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  const parsed = parseVcf(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Priya Nair', 'N:Nair;Priya;;;',
    'TEL;TYPE=CELL,VOICE:+91 98765 43210', 'item1.TEL;type=pref:098765 43211', 'item1.X-ABLabel:home',
    'TEL;TYPE=HOME:080-23456789', 'TEL;TYPE=FAX:9876543299', 'TEL;TYPE=CELL:+1 415 555 2671', 'TEL;TYPE=CELL:+44 7911 123456',
    'EMAIL;TYPE=INTERNET:priya@example.invalid', 'ADR;TYPE=HOME:;;1 Street;City;;560001;India', 'NOTE:Do not keep this',
    'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQ', ' AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'END:VCARD', '',
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Long ', ' Folded Name', 'TEL:9876543212', 'END:VCARD', '',
  ].join('\r\n'))]));
  assert.deepEqual(parsed, [{ name: 'Priya Nair', phones: ['9876543210', '9876543211'] }, { name: 'Long Folded Name', phones: ['9876543212'] }]);
  assert.deepEqual(Object.keys(parsed[0]).sort(), ['name', 'phones'], 'only a name and numbers are kept');
  // 2.1 as Android writes it: QUOTED-PRINTABLE UTF-8, soft line breaks, bare TYPE params, N without FN.
  const hindi = 'रमेश कुमार';
  const android = parseVcf([
    'BEGIN:VCARD', 'VERSION:2.1',
    `N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${qp('कुमार')};${qp('रमेश')};;;`,
    `FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${qp(hindi).slice(0, 30)}=`, qp(hindi).slice(30),
    'TEL;CELL;PREF:+91 90000 00006', 'TEL;WORK;VOICE:09000000007', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:2.1', `N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${qp('शर्मा')};${qp('अनु')};;;`, 'TEL;CELL:9000000008', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:2.1', 'FN;QUOTED-PRINTABLE:Caf=C3=A9 =3B Bar', 'TEL;CELL:9000000009', 'END:VCARD',
  ].join('\n'));
  assert.deepEqual(android, [
    { name: hindi, phones: ['9000000006', '9000000007'] },
    { name: 'अनु शर्मा', phones: ['9000000008'] },
    { name: 'Café ; Bar', phones: ['9000000009'] },
  ]);
  // 4.0: tel: URIs, escapes, a missing END:VCARD, a card with nothing usable.
  const v4 = parseVcf('BEGIN:VCARD\nVERSION:4.0\nFN:Meera\\, Dr\\; M\nTEL;VALUE=uri;PREF=1:tel:+91-90000-00010\nTEL;VALUE=uri:tel:+91-80-2345-6789\nBEGIN:VCARD\nVERSION:4.0\nN:Rao;Kiran;;Mr;\nTEL;TYPE="cell,voice":9000000011\nEND:VCARD\nBEGIN:VCARD\nVERSION:4.0\nFN:Only Email\nEMAIL:a@example.invalid\nEND:VCARD\nBEGIN:VCARD\nVERSION:4.0\nORG:Corner Shop;Retail\nTEL:9000000012\nEND:VCARD');
  assert.deepEqual(v4, [{ name: 'Meera, Dr; M', phones: ['9000000010'] }, { name: 'Kiran Rao', phones: ['9000000011'] }, { name: 'Only Email', phones: [] }, { name: 'Corner Shop', phones: ['9000000012'] }]);
  assert.deepEqual(parseVcf(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('BEGIN:VCARD\r\nFN:Wide\r\nTEL:9000000013\r\nEND:VCARD', 'utf16le')])), [{ name: 'Wide', phones: ['9000000013'] }], 'UTF-16 with a BOM');
  assert.deepEqual(parseVcf('begin:vcard\r\nfn:Lower\r\ntel;type=cell:9000000014\r\nend:vcard'), [{ name: 'Lower', phones: ['9000000014'] }], 'case-insensitive');
  assert.deepEqual(parseVcf('BEGIN:VCARD\nFN:Dup\nTEL:9000000015\nTEL:+91 90000 00015\nEND:VCARD'), [{ name: 'Dup', phones: ['9000000015'] }], 'the same number twice is kept once');
  assert.throws(() => parseVcf('hello world'), { code: 'NOT_A_VCARD' });
  assert.throws(() => parseVcf('BEGIN:VCARD\nFN:A\nTEL:9000000016\nEND:VCARD\nBEGIN:VCARD\nFN:B\nTEL:9000000017\nEND:VCARD', { maxCards: 1 }), { code: 'TOO_MANY_CONTACTS' });
  assert.equal(parseVcf('BEGIN:VCARD\nFN:A\nEND:VCARD\nBEGIN:VCARD\nFN:B\nEND:VCARD', { maxCards: 2 }).length, 2);

  // ── 4. Merge by phone, re-import no-op, skips ──
  const u = mkUser('Importer');
  const v = mkUser('Other tenant');
  const card = (fn, tels, type = 'CELL') => `BEGIN:VCARD\r\nVERSION:3.0\r\n${fn ? `FN:${fn}\r\n` : ''}${tels.map((t) => `TEL;TYPE=${type}:${t}`).join('\r\n')}\r\nEND:VCARD`;
  const mom = await people.createPerson(u, { name: 'Mom', phones: ['9200000001'], relationship: 'Mother', aliases: [], isFamily: true });
  const doc = await people.createPerson(u, { name: 'Dr Rao', phones: ['9200000002'], relationship: '', aliases: [], isFamily: false });
  const book = Buffer.from(vcards(
    card('Mother', ['+91 92000 00001', '9200000003']), // the number matches Mom (family): her numbers are not widened by an import
    card('Doctor Rao', ['9200000002', '9200000004']), // merges into Dr Rao, no rename
    card('New One', ['9200000005']),
    card('New One Again', ['9200000005', '9200000006']), // same file, same person by number
    card('Landline', ['080-23456789'], 'HOME'), card('', ['9200000007']), card('X', ['9200000008']), card('Foreign', ['+1 415 555 2671']),
  ));
  const tables = () => JSON.stringify(['people', 'person_phones'].map((t) => db.prepare(`SELECT * FROM ${t} WHERE user_id = ? ORDER BY rowid`).all(u)));
  const summary = await people.importContacts(u, book);
  assert.deepEqual(summary, { cards: 8, added: 1, merged: 2, unchanged: 1, skipped: 4, heldBack: 1 });
  const momAfter = await people.getPerson(u, mom._id);
  assert.deepEqual([momAfter.name, momAfter.isFamily, momAfter.phones, momAfter.relationship], ['Mom', true, ['9200000001'], 'Mother']);
  const docAfter = await people.getPerson(u, doc._id);
  assert.deepEqual([docAfter.name, docAfter.isFamily, docAfter.phones], ['Dr Rao', false, ['9200000002', '9200000004']]);
  const newOne = (await people.listPeople(u, { search: 'new one' })).items;
  assert.deepEqual(newOne.map((p) => [p.name, p.phones, p.isFamily, p.source]), [['New One', ['9200000005', '9200000006'], false, 'import']]);
  assert.equal((await people.listPeople(u, {})).meta.total, 3);
  assert.equal(familyWorker.statusFor(u).status, 'pending', 'creating Mom (family) queued a scan, the import itself added none');
  const revision = familyWorker.statusFor(u).revision;
  const settled = tables();
  assert.deepEqual(await people.importContacts(u, book), { cards: 8, added: 0, merged: 0, unchanged: 4, skipped: 4, heldBack: 1 });
  assert.equal(tables(), settled, 're-importing the same file changes nothing, not even timestamps');
  assert.equal(familyWorker.statusFor(u).revision, revision);
  const imported2 = await people.importContacts(v, book);
  assert.deepEqual([imported2.added, imported2.merged], [3, 1], 'another account imports the same numbers independently');
  assert.equal((await people.listPeople(v, {})).meta.total, 3);
  await assert.rejects(() => people.importContacts(u, Buffer.from('nothing here')), /doesn’t look like a contacts file/);

  // ── 5. Manual people, the family toggle and the sort-out worker ──
  const w = mkUser('Family toggles');
  const spendTx = addTx(w, upi('SOME ONE', 'someone@okaxis'));
  const some = await people.createPerson(w, { name: 'Some One', phones: [], relationship: '', aliases: [], isFamily: false });
  await people.updatePerson(w, some._id, { name: 'Some One Else', phones: ['9400000001'] });
  await people.updatePerson(w, some._id, { name: 'Some One' });
  assert.equal(familyWorker.statusFor(w).status, 'idle', 'adding or editing a non-family person never queues a re-sort');
  assert.equal(rowOf(spendTx).category_id, null);
  await people.updatePerson(w, some._id, { isFamily: true });
  assert.equal(familyWorker.statusFor(w).status, 'pending', 'marking someone family queues the same scan adding them to the old list did');
  drain(w);
  assert.equal(rowOf(spendTx).category_id, catId(w, 'Family'));
  assert.equal(rowOf(spendTx).auto_categorized, 1);
  const done = familyWorker.statusFor(w);
  await people.updatePerson(w, some._id, { relationship: 'Cousin' });
  assert.deepEqual(familyWorker.statusFor(w), done, 'a relationship edit changes nothing the rules see');
  await people.updatePerson(w, some._id, { aliases: ['Someone O'] });
  assert.equal(familyWorker.statusFor(w).status, 'pending', 'aliases are family matching data');
  drain(w);
  await people.updatePerson(w, some._id, { isFamily: false });
  drain(w);
  assert.equal(rowOf(spendTx).category_id, catId(w, 'Other'), 'unmarking behaves like removing from the old list');
  await people.updatePerson(w, some._id, { isFamily: true });
  drain(w);
  assert.equal(rowOf(spendTx).category_id, catId(w, 'Family'));
  await people.removePerson(w, some._id);
  assert.equal(familyWorker.statusFor(w).status, 'pending');
  drain(w);
  assert.equal(rowOf(spendTx).category_id, catId(w, 'Other'), 'removing a family person behaves like removing them from the old list');
  await assert.rejects(() => people.getPerson(w, some._id), /Person not found/);
  const taker = await people.createPerson(w, { name: 'Taker', phones: ['9400000001'], relationship: '', aliases: [], isFamily: false });
  assert.deepEqual(taker.phones, ['9400000001'], 'a removed person frees their number');
  await assert.rejects(() => people.createPerson(w, { name: 'Clash', phones: ['9400000001'], relationship: '', aliases: [], isFamily: false }), { code: 'PHONE_TAKEN' });
  const other = await people.createPerson(w, { name: 'Other', phones: [], relationship: '', aliases: [], isFamily: false });
  await assert.rejects(() => people.updatePerson(w, other._id, { phones: ['9400000001'] }), { code: 'PHONE_TAKEN' });
  await assert.rejects(() => people.updatePerson(v, other._id, { name: 'Hijack' }), /Person not found/);
  await assert.rejects(() => people.removePerson(v, other._id), /Person not found/);
  assert.equal(peopleSchemas.createPerson.safeParse({ body: { name: 'A' } }).success, false);
  assert.equal(peopleSchemas.createPerson.safeParse({ body: { name: 'Ok', phones: ['12345'] } }).success, false);
  assert.deepEqual(peopleSchemas.createPerson.parse({ body: { name: 'Ok', phones: ['+91 94000 00009', '9400000009'] } }).body.phones, ['9400000009']);
  const list = await people.listPeople(legacy, { search: 'contact 04', limit: 5 });
  assert.equal(list.meta.total, 10);
  assert.equal(list.items.length, 5);
  assert.equal(list.meta.pages, 2);
  assert.equal((await people.listPeople(legacy, { search: '9100000042' })).items[0].name, 'Contact 042', 'search by number');
  assert.equal((await people.listPeople(legacy, { family: true })).meta.total, LEGACY_LIST.length + 0, 'the family filter lists only family');

  // ── 6. Labels, "Who is this?" and the person filter ──
  const x = mkUser('Labels');
  const y = mkUser('Labels other tenant');
  const ramesh = await people.createPerson(x, { name: 'Ramesh Plumber', phones: ['9300000001'], relationship: '', aliases: [], isFamily: false });
  const priya = await people.createPerson(x, { name: 'Priya', phones: [], relationship: '', aliases: [], isFamily: false });
  const txPhone = addTx(x, 'WDL TFR UPI/DR/123456789012/BANK NAME/SBIN/9300000001@ybl/Sent', { date: '2026-11-05' });
  const txName = addTx(x, upi('RAMESH PLUMBER', 'plumber@okaxis'), { date: '2026-11-04' });
  const txVpa1 = addTx(x, upi('R P', 'rp@okicici'), { date: '2026-11-03' });
  const txVpa2 = addTx(x, upi('RP SHOP', 'RP@okicici'), { date: '2026-11-02', source: 'sms' });
  const txPayee1 = addTx(x, kotak('PRIYA S'), { date: '2026-11-01' });
  const txPayee2 = addTx(x, kotak('Priya  S'), { date: '2026-10-31' });
  const txManual = addTx(x, 'Lunch with team', { source: 'manual', date: '2026-10-30' });
  const yTx = addTx(y, upi('R P', 'rp@okicici'));
  const read = async (userId = x, query = {}) => (await transactions.listTransactions(userId, { page: 1, limit: 50, sort: '-date', ...query })).items;
  const of = async (id) => (await read()).find((t) => t._id === id);
  const label = async (id) => (await of(id)).person;
  assert.deepEqual(await label(txPhone), { _id: ramesh._id, name: 'Ramesh Plumber', isFamily: false, via: 'phone' }, 'a phone number inside the UPI id labels the payment');
  assert.equal(await label(txName), undefined, 'a matching name alone never labels anything');
  assert.equal((await of(txName)).canLinkPerson, true);
  assert.equal((await of(txManual)).canLinkPerson, false);
  const untouched = (id) => JSON.stringify(rowOf(id));
  const frozen = [txPhone, txName, txVpa1, txVpa2, txPayee1, txPayee2].map(untouched);
  const rulesBefore = db.prepare('SELECT count(*) FROM merchant_rules WHERE user_id = ?').pluck().get(x);

  await people.linkTransaction(x, txVpa1, priya._id);
  assert.deepEqual([await label(txVpa1), await label(txVpa2)].map((p) => p?.name), ['Priya', 'Priya'], 'a linked UPI id labels every payment to it, whatever its case');
  assert.equal((await label(txVpa2)).via, 'link');
  assert.deepEqual(db.prepare('SELECT kind, value, transaction_id FROM person_identifiers WHERE user_id = ?').all(x), [{ kind: 'vpa', value: 'rp@okicici', transaction_id: txVpa1 }]);
  await people.linkTransaction(x, txVpa2, ramesh._id); // an sms row: linking never edits the payment
  assert.deepEqual([await label(txVpa1), await label(txVpa2)].map((p) => p?.name), ['Ramesh Plumber', 'Ramesh Plumber'], 're-linking an id moves it');
  assert.deepEqual(db.prepare('SELECT person_id, transaction_id FROM person_identifiers WHERE user_id = ?').all(x), [{ person_id: ramesh._id, transaction_id: txVpa2 }]);
  await people.linkTransaction(x, txVpa1, null);
  assert.equal(await label(txVpa2), undefined, 'clearing removes the id that was labelling the row');
  assert.equal(db.prepare('SELECT count(*) FROM person_identifiers WHERE user_id = ?').pluck().get(x), 0);
  await people.linkTransaction(x, txVpa1, priya._id);
  await people.linkTransaction(x, txPayee1, priya._id);
  assert.deepEqual(db.prepare('SELECT kind, value FROM person_identifiers WHERE user_id = ? ORDER BY kind').all(x), [{ kind: 'payee', value: 'PRIYA S' }, { kind: 'vpa', value: 'rp@okicici' }], 'a payment without a UPI id teaches its normalised payee name');
  assert.equal((await label(txPayee2)).name, 'Priya', 'the same payee written differently');
  await people.linkTransaction(x, txVpa1, null);
  assert.equal(await label(txVpa1), undefined);
  assert.equal((await label(txPayee1)).name, 'Priya', 'clearing one payment leaves what another taught');
  await people.linkTransaction(x, txPayee2, null);
  assert.equal(await label(txPayee1), undefined);
  // A hand link outranks the phone number; clearing it falls back.
  await people.linkTransaction(x, txPhone, priya._id);
  assert.equal((await label(txPhone)).name, 'Priya');
  await people.linkTransaction(x, txPhone, null);
  assert.equal((await label(txPhone)).name, 'Ramesh Plumber');
  await people.linkTransaction(x, txPhone, null); // clearing a phone label is harmless: edit the person's numbers instead
  assert.equal((await label(txPhone)).via, 'phone');
  await assert.rejects(() => people.linkTransaction(x, txManual, priya._id), { code: 'NOTHING_TO_LINK' });
  await people.linkTransaction(x, txManual, null);
  assert.deepEqual([txPhone, txName, txVpa1, txVpa2, txPayee1, txPayee2].map(untouched), frozen, 'no payment row was touched by any of that');
  assert.equal(db.prepare('SELECT count(*) FROM merchant_rules WHERE user_id = ?').pluck().get(x), rulesBefore);
  await assert.rejects(() => transactions.updateTransaction(x, txVpa2, { description: 'changed' }), { code: 'STATEMENT_READ_ONLY' });
  // Tenant isolation.
  await assert.rejects(() => people.linkTransaction(y, txVpa1, ramesh._id), /Transaction not found/);
  await assert.rejects(() => people.linkTransaction(y, yTx, ramesh._id), /Person not found/);
  assert.equal((await read(y)).find((t) => t._id === yTx).person, undefined);
  assert.equal(db.prepare('SELECT count(*) FROM person_identifiers WHERE user_id = ?').pluck().get(y), 0);

  // The person filter agrees with the labels, row for row.
  await people.linkTransaction(x, txVpa1, ramesh._id);
  const everything = await read();
  const labelled = everything.filter((t) => t.person?._id === ramesh._id).map((t) => t._id).sort();
  assert.deepEqual(labelled, [txPhone, txVpa1, txVpa2].sort());
  const filtered = await transactions.listTransactions(x, { page: 1, limit: 50, sort: '-date', person: ramesh._id });
  assert.deepEqual(filtered.items.map((t) => t._id).sort(), labelled);
  assert.equal(filtered.meta.total, 3);
  const pageTwo = await transactions.listTransactions(x, { page: 2, limit: 2, sort: '-date', person: ramesh._id });
  assert.equal(pageTwo.items.length, 1);
  assert.equal(pageTwo.meta.pages, 2);
  assert.equal((await transactions.getSummary(x, { groupBy: 'categoryType', person: ramesh._id })).totals.count, 3);
  assert.equal((await transactions.listTransactions(x, { page: 1, limit: 50, sort: '-date', person: ramesh._id, search: 'rp' })).meta.total, 2, 'combines with other filters');
  assert.equal((await transactions.listTransactions(y, { page: 1, limit: 50, sort: '-date', person: ramesh._id })).meta.total, 0, 'another account\'s person matches nothing');
  assert.equal((await transactions.listTransactions(x, { page: 1, limit: 50, sort: '-date', person: newId() })).meta.total, 0);
  assert.equal((await transactions.getTransaction(x, txVpa2)).person.name, 'Ramesh Plumber');
  // The palette finds people (on this computer only).
  const found = require('../src/plugins/capture/capture.service').search(x, 'ramesh').filter((r) => r.kind === 'person');
  assert.deepEqual(found.map((r) => [r.id, r.title]), [[ramesh._id, 'Ramesh Plumber']]);
  assert.deepEqual(require('../src/plugins/capture/capture.service').search(y, 'ramesh').filter((r) => r.kind === 'person'), []);
  await people.removePerson(x, ramesh._id);
  assert.equal((await of(txPhone)).person, undefined, 'removing a person removes their labels');
  assert.equal(db.prepare('SELECT count(*) FROM person_identifiers WHERE person_id = ?').pluck().get(ramesh._id), 0);

  // ── 7. Privacy, "Start fresh" and account deletion ──
  const src = (file) => fs.readFileSync(path.join(__dirname, '../src/plugins', file), 'utf8');
  for (const file of ['capture/capture.ai.js', 'insights/suggestions.service.js', 'insights/summary.helper.js', 'insights/llm.client.js', 'goals/goal.analysis.js', 'ai/ai.service.js']) {
    assert.doesNotMatch(src(file), /active_people|FROM people|people\.(service|model)|person_phones|person_identifiers|familyMembers|family_contacts|linkKeys|labeler/, `${file} must never see the contact list`);
  }
  const keeper = mkUser('Keeper');
  const keptPerson = await people.createPerson(keeper, { name: 'Kept Person', phones: ['9500000001'], relationship: 'Friend', aliases: [], isFamily: true });
  const keptTx = addTx(keeper, upi('KEPT', 'kept@okaxis'));
  await people.linkTransaction(keeper, keptTx, keptPerson._id);
  const circleBefore = await people.listPeople(keeper, {});
  const idsBefore = db.prepare('SELECT * FROM person_identifiers WHERE user_id = ?').all(keeper);
  await users.resetFinancialData(keeper);
  assert.deepEqual((await people.listPeople(keeper, {})).items, circleBefore.items, 'start fresh keeps your circle');
  assert.deepEqual(db.prepare('SELECT * FROM person_identifiers WHERE user_id = ?').all(keeper), idsBefore, '...and what you linked by hand');
  const { hashPassword } = require('../src/core/password');
  const leaver = insertUser(db, { email: `${newId()}@example.invalid`, name: 'Leaver', passwordHash: await hashPassword('correct-horse-9') });
  seedDefaults(db, leaver);
  const leaverPerson = await people.createPerson(leaver, { name: 'Gone Soon', phones: ['9600000001'], relationship: '', aliases: [], isFamily: false });
  const leaverTx = addTx(leaver, upi('GONE', 'gone@okaxis'));
  await people.linkTransaction(leaver, leaverTx, leaverPerson._id);
  const before2 = (id) => ['people', 'person_phones', 'person_identifiers'].map((t) => db.prepare(`SELECT count(*) FROM ${t} WHERE user_id = ?`).pluck().get(id));
  assert.deepEqual(before2(leaver), [1, 1, 1]);
  await assert.rejects(() => users.deleteAccount(leaver, { password: 'wrong' }), /isn’t right/);
  await users.deleteAccount(leaver, { password: 'correct-horse-9' });
  assert.deepEqual(before2(leaver), [0, 0, 0], 'account deletion removes the whole circle');
  assert.ok(before2(keeper).every((n) => n > 0), 'other accounts are untouched');
  assert.equal(db.pragma('foreign_key_check').length, 0);

  // ── 8. The upload route (loopback only) ──
  const express = require('express');
  const app = express();
  app.use((req, res, next) => { req.user = { id: u }; next(); });
  app.use('/people', require('../src/plugins/people/people.routes'));
  app.use(require('../src/core/errorHandler'));
  const server = await new Promise((resolve) => { const s2 = app.listen(0, '127.0.0.1', () => resolve(s2)); });
  const post = async (bytes, name = 'contacts.vcf', type = 'text/x-vcard') => {
    const form = new FormData();
    if (bytes) form.append('file', new Blob([bytes], { type }), name);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/people/import`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
  };
  try {
    const ok = await post(Buffer.from(card('Over Http', ['9700000001'])), 'c.vcf', '');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.data, { cards: 1, added: 1, merged: 0, unchanged: 0, skipped: 0, heldBack: 0 });
    assert.equal((await post(null)).body.error.code, 'FILE_REQUIRED');
    assert.equal((await post(Buffer.from('<html>not contacts</html>'), 'x.vcf', 'text/html')).body.error.code, 'NOT_A_VCARD');
    const big = await post(Buffer.alloc(21 * 1024 * 1024, 'a'));
    assert.equal(big.status, 413);
    assert.equal(big.body.error.code, 'FILE_TOO_LARGE');
  } finally { await new Promise((resolve) => server.close(resolve)); }
  assert.equal(db.pragma('foreign_key_check').length, 0);
  console.log('Passed: migration of the old family JSON, categorisation equivalence (old list vs people, worker, 100 imported contacts, linked ids), vCard 2.1/3.0/4.0 parsing, merge by phone and no-op re-import, family toggle and re-sort, labels by phone and by linked id, link/re-link/clear, person filter, tenant isolation, privacy, reset and account deletion, upload limits.');
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => { familyWorker.stopFamilyWorker(); db.close(); });
