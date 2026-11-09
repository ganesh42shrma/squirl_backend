// Synthetic in-memory integration checks. Never opens the configured database or calls the model.
const assert = require('node:assert/strict');
const Database = require('better-sqlite3-multiple-ciphers');
const db = new Database(':memory:');
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports }; };
stub('../src/config/db', { getDb: () => db });
stub('../src/core/logger', { info() {}, warn() {} });
let answer = { items: [] };
stub('../src/plugins/insights/llm.client', { chat: async () => ({ text: JSON.stringify(answer), model: 'synthetic' }), parseJson: JSON.parse });
const migrations = require('../src/config/migrations');
for (const migration of migrations) typeof migration === 'function' ? migration(db) : db.exec(migration);
db.pragma('foreign_keys = ON');
const { insertUser } = require('../src/plugins/users/user.model');
const { seedDefaults } = require('../src/plugins/users/defaults');
const { insertRow, newId, nowIso } = require('../src/core/sql');
const { counterparty } = require('../src/plugins/rules/rules.helper');
const { familyPolicy } = require('../src/plugins/users/family');
const { updateProfile, getProfile, addFamilyMember } = require('../src/plugins/users/user.service');
const rules = require('../src/plugins/rules/rules.service');
const suggestions = require('../src/plugins/insights/suggestions.service');
const familyWorker = require('../src/plugins/users/family.worker');
const drain = (userId) => { while (familyWorker.runBatch(db, userId, 2)) {} };
const { updateProfile: schema } = require('../src/plugins/users/user.validation');
const { normalizePhone, upiPhones } = require('../src/plugins/users/contact.helper');

const user = () => {
  const id = insertUser(db, { email: `${newId()}@example.invalid`, name: 'Test', passwordHash: 'unused' });
  seedDefaults(db, id);
  return id;
};
const a = user();
const b = user();
const upi = (name) => `WDL TFR UPI/DR/123456789012/${name}/SBIN/handle123/Sent`;
const known = upi('ANANYA SHARMA');
const stranger = upi('UNRELATED PERSON');
const category = (name) => db.prepare('SELECT id FROM categories WHERE user_id = ? AND name = ?').get(a, name).id;
const transaction = (userId, description, cat = null, auto = 0) => {
  const id = newId();
  insertRow(db, 'transactions', { id, user_id: userId, date: '2026-11-01', description, amount_paise: 10000, type: 'debit', account: 'test', source: 'import', category_id: cat, auto_categorized: auto, created_at: nowIso(), updated_at: nowIso() });
  return id;
};
const row = (id) => db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);

async function main() {
  assert.equal(schema.safeParse({ body: { familyContacts: [{ name: '' }] } }).success, false);
  assert.equal(schema.safeParse({ body: { familyContacts: [{ name: 'Test', aliases: [''] }] } }).success, false);
  assert.equal(schema.safeParse({ body: { familyContacts: Array(201).fill({ name: 'Test' }) } }).success, false);
  const matched = transaction(a, known);
  const unlisted = transaction(a, stranger);
  const confirmed = transaction(a, known, category('Food & Drinks'));
  const otherUser = transaction(b, known);
  await updateProfile(a, { familyContacts: [{ name: 'Ananya Sharma', aliases: ['Ananya S'] }] });
  assert.equal(row(matched).category_id, null, 'profile save queues the historical scan');
  drain(a);
  assert.deepEqual((await getProfile(a)).familyContacts, [{ name: 'Ananya Sharma', aliases: ['Ananya S'] }]);
  assert.equal(row(matched).category_id, category('Family'));
  assert.equal(row(matched).auto_categorized, 1);
  assert.equal(row(unlisted).category_id, null);
  assert.equal(row(confirmed).category_id, category('Family'));
  assert.equal(row(otherUser).category_id, null);
  assert.equal(rules.categoryFor(db, a, { description: known, type: 'debit' }), category('Family'));
  assert.equal(rules.categoryFor(db, a, { description: upi('ANANYA S'), type: 'credit' }), category('Family'));
  assert.equal(familyPolicy(db, a).matches(upi('ANANYA')), false);
  assert.equal(familyPolicy(db, a).matches(upi('ANANYA SHARMA STORE')), false);
  assert.equal(familyPolicy(db, a).matches(upi('Ananya.Sharma')), true);
  assert.equal(rules.categoryFor(db, b, { description: known, type: 'debit' }), null);

  // Previously learned Family answers cannot classify an unlisted person as Family.
  rules.learn(db, a, [unlisted], category('Family'));
  assert.equal(rules.categoryFor(db, a, { description: stranger, type: 'debit' }), category('Other'));
  await rules.applyRules(a);
  assert.equal(row(unlisted).category_id, category('Other'));

  // A cached model Family guess is corrected both when displayed and when applied.
  const cachedDescription = upi('CACHED STRANGER');
  const cachedRow = transaction(a, cachedDescription);
  const cachedId = newId();
  insertRow(db, 'merchant_suggestions', { id: cachedId, user_id: a, direction: 'debit', merchant_key: counterparty(cachedDescription).key, merchant: 'CACHED STRANGER', example: cachedDescription, category_id: category('Family'), confidence: 'high', created_at: nowIso(), updated_at: nowIso() });
  assert.equal((await suggestions.listSuggestions(a)).suggestions.find((s) => s._id === cachedId).category._id, category('Other'));
  await suggestions.applySuggestions(a, [{ id: cachedId }]);
  assert.equal(row(cachedRow).category_id, category('Other'));

  // A model identifies an unfamiliar person: Other regardless of its proposed gift category.
  const description = upi('NEW STRANGER');
  transaction(a, description);
  const main = db.prepare('SELECT id, name, type FROM categories WHERE user_id = ? AND parent_id IS NULL').all(a).sort((x, y) => x.type.localeCompare(y.type) || x.name.localeCompare(y.name));
  answer = { items: [{ t: 1, c: main.findIndex((c) => c.name === 'Social & Gifts') + 1, confidence: 'high', person: true }] };
  await suggestions.suggestBatch(db, a, [{ direction: 'debit', key: counterparty(description).key, merchant: 'NEW STRANGER', example: description }]);
  const saved = db.prepare('SELECT * FROM merchant_suggestions WHERE user_id = ? AND merchant_key = ?').get(a, counterparty(description).key);
  assert.equal(saved.category_id, category('Other'));
  assert.equal(saved.is_person, 1);
  assert.equal(rules.categoryFor(db, a, { description, type: 'debit' }), category('Other'));

  // Phones survive storage and match only complete phone-based counterparty UPI IDs.
  const phoneDescription = 'WDL TFR UPI/DR/123456789012/BANK DISPLAY NAME/SBIN/9000000001@ybl/Sent';
  const phoneRow = transaction(a, phoneDescription);
  const contacts = schema.parse({ body: { familyContacts: [{ name: 'Ananya Sharma', aliases: ['Ananya S'], phone: '+91 90000 00001', relationship: 'Sister' }] } }).body;
  assert.equal(contacts.familyContacts[0].phone, '9000000001');
  await updateProfile(a, contacts);
  drain(a);
  assert.deepEqual((await getProfile(a)).familyContacts, contacts.familyContacts);
  assert.equal(row(phoneRow).category_id, category('Family'));
  assert.equal(rules.categoryFor(db, a, { description: phoneDescription, type: 'debit' }), category('Family'));
  assert.equal(rules.categoryFor(db, b, { description: phoneDescription, type: 'debit' }), null);
  for (const number of ['9000000001', '+91 90000 00001', '919000000001', '00919000000001', '09000000001']) assert.equal(normalizePhone(number), '9000000001');
  assert.equal(schema.safeParse({ body: { familyContacts: [{ name: 'Test', phone: '900000000' }] } }).success, false);
  assert.equal(schema.safeParse({ body: { familyContacts: [{ name: 'Test', phone: 'abc9000000001' }] } }).success, false);
  assert.deepEqual(upiPhones('UPI/9000000001@ybl/SBIN/123456789012/Payment from'), ['9000000001']);
  assert.equal(familyPolicy(db, a).matches('UPI/DR/123456789012/DIFFERENT NAME/SBIN/919000000001@upi/NA'), true);
  for (const d of [
    'UPI/DR/919000000001/DIFFERENT NAME/SBIN/customhandle@upi/NA', // ref is not a phone
    'UPI/DIFFERENT NAME/SBIN/919000000001/Payment from', // Kotak ref is not a phone
    'UPI/DR/123456789012/DIFFERENT NAME/SBIN/custom9000000001@upi/NA',
    'UPI/DR/123456789012/DIFFERENT NAME/SBIN/90000000012@upi/NA',
    'UPI/DR/123456789012/DIFFERENT NAME/SBIN/90000XXXXX@upi/NA',
    'UPI/DR/123456789012/DIFFERENT NAME/SBIN/custom@upi/9000000001', // remark is not a UPI ID
    'NEFT*SBIN0000001*9000000001*DIFFERENT NAME',
  ]) assert.equal(familyPolicy(db, a).matches(d), false, d);
  assert.equal(familyPolicy(db, a).matches(upi('ANANYA SHARMA')), true, 'name matching still works with a phone saved');

  // Removing a contact reverses automatic Family assignments without changing confirmed rows.
  await updateProfile(a, { familyContacts: [] });
  drain(a);
  assert.equal(row(matched).category_id, category('Other'));
  assert.equal(row(phoneRow).category_id, category('Other'));
  assert.equal(row(confirmed).category_id, category('Other'));
  // The ledger shortcut saves atomically, retains the bank name, and changes the selected row.
  const ledgerDescription = 'UPI/DR/123456789012/LEDGER BANK NAME/SBIN/9000000002@ybl/NA';
  const selectedRow = transaction(a, ledgerDescription, category('Other'));
  const matchingRow = transaction(a, ledgerDescription);
  const candidate = require('../src/plugins/users/contact.helper').memberCandidate(ledgerDescription);
  assert.deepEqual(candidate, { name: 'LEDGER BANK NAME', phone: '9000000002' });
  const memberInput = require('../src/plugins/users/user.validation').addFamilyMember.parse({ body: { transactionId: selectedRow, name: 'Usual Name', phone: '+91 9000000002', relationship: 'Friend' } }).body;
  const ledgerProfile = await addFamilyMember(a, memberInput);
  drain(a);
  assert.equal(ledgerProfile.familyContacts.length, 1);
  assert.deepEqual(ledgerProfile.familyContacts[0].aliases, ['LEDGER BANK NAME']);
  assert.equal(ledgerProfile.familyContacts[0].relationship, 'Friend');
  assert.equal(row(selectedRow).category_id, category('Family'));
  assert.equal(row(selectedRow).auto_categorized, 0);
  assert.equal(row(matchingRow).category_id, category('Family'));
  assert.equal(rules.categoryFor(db, a, { description: ledgerDescription, type: 'debit' }), category('Family'));
  await addFamilyMember(a, { ...memberInput, name: 'Updated Name' });
  drain(a);
  assert.equal((await getProfile(a)).familyContacts.length, 1, 'same phone updates an existing member');
  const snapshot = (await getProfile(b)).familyContacts;
  await assert.rejects(() => addFamilyMember(b, memberInput), /Transaction not found/);
  assert.deepEqual((await getProfile(b)).familyContacts, snapshot);
  // Checkpoints, reruns and coalesced edits on a scan that spans several batches.
  const c = user();
  const food = db.prepare("SELECT id FROM active_categories WHERE user_id = ? AND name = 'Food & Drinks'").pluck().get(c);
  const family = db.prepare("SELECT id FROM active_categories WHERE user_id = ? AND name = 'Family'").pluck().get(c);
  const batchRows = Array.from({ length: 7 }, () => transaction(c, upi('BATCH PERSON'), food));
  db.prepare("UPDATE transactions SET source = 'manual' WHERE id = ?").run(batchRows[1]);
  db.prepare('UPDATE transactions SET deleted_at = ? WHERE id = ?').run(nowIso(), batchRows[6]);
  const unrelated = transaction(c, upi('UNRELATED SHOP'), food);
  await updateProfile(c, { familyContacts: [{ name: 'Batch Person', aliases: [] }] });
  const checkpoint = familyWorker.statusFor(c);
  db.exec("CREATE TRIGGER fail_family_batch BEFORE UPDATE OF category_id ON transactions WHEN NEW.user_id = '" + c + "' BEGIN SELECT RAISE(ABORT, 'synthetic batch failure'); END");
  assert.throws(() => familyWorker.runBatch(db, c, 2), /synthetic batch failure/);
  assert.deepEqual(familyWorker.statusFor(c), checkpoint, 'a failed batch rolls back its checkpoint');
  assert.equal(row(batchRows[0]).category_id, food);
  db.exec('DROP TRIGGER fail_family_batch');
  assert.equal(familyWorker.runBatch(db, c, 2), true);
  assert.equal(familyWorker.statusFor(c).processed, 2);
  assert.equal(row(batchRows[1]).category_id, family, 'manual rows are scanned too');
  drain(c);
  assert.equal(familyWorker.statusFor(c).changed, 6);
  assert.equal(row(batchRows[6]).category_id, food, 'soft-deleted transactions are untouched');
  assert.equal(row(unrelated).category_id, food, 'unmatched categorized transactions stay unchanged');
  await updateProfile(c, { familyContacts: [{ name: 'Batch Person', aliases: [] }] });
  drain(c);
  assert.equal(familyWorker.statusFor(c).changed, 0, 'rerunning the same list is idempotent');
  await updateProfile(c, { familyContacts: [{ name: 'Different Person', aliases: [] }] });
  await updateProfile(c, { familyContacts: [{ name: 'Batch Person', aliases: [] }] });
  assert.equal(familyWorker.statusFor(c).processed, 0, 'newer edits restart a pending scan');
  drain(c);
  assert.equal(row(batchRows[0]).category_id, family, 'only the latest contact list is used');
  // Reproduce 44 merchants, 25 cached no-answers and 19 learned rules: no AI work is pending.
  const d = user();
  const dFood = db.prepare("SELECT id FROM active_categories WHERE user_id = ? AND name = 'Food & Drinks'").pluck().get(d);
  for (let i = 0; i < 44; i += 1) {
    const desc = upi(`STATUS MERCHANT ${i}`);
    transaction(d, desc);
    const base = { id: newId(), user_id: d, direction: 'debit', merchant_key: counterparty(desc).key, example: desc, created_at: nowIso(), updated_at: nowIso() };
    if (i < 25) insertRow(db, 'merchant_suggestions', { ...base, merchant: `STATUS MERCHANT ${i}`, category_id: null, confidence: 'none' });
    else insertRow(db, 'merchant_rules', { ...base, category_id: dFood });
  }
  const status = (await suggestions.listSuggestions(d)).status;
  assert.equal(status.merchants, 44);
  assert.equal(status.merchantsAsked, 25);
  assert.equal(status.checkedMerchants, 44);
  assert.equal(status.pendingMerchants, 0);
  assert.equal(status.learnedMerchants, 19);
  assert.equal(status.learnedRows, 19);
  assert.equal(status.suggestedRows, 0);
  assert.equal(suggestions.pendingGroups(db, d).length, 0);
  assert.equal(familyWorker.statusFor(d).status, 'idle');
  // Contacts created before the queue existed receive a first job through the forward migration.
  const e = user();
  const legacyRow = transaction(e, upi('LEGACY MEMBER'));
  db.prepare('UPDATE users SET family_contacts = ? WHERE id = ?').run(JSON.stringify([{ name: 'Legacy Member', aliases: [] }]), e);
  assert.equal(familyWorker.statusFor(e).status, 'idle');
  require('../src/config/migrations')[12](db);
  assert.equal(familyWorker.statusFor(e).status, 'pending');
  drain(e);
  assert.equal(row(legacyRow).category_id, familyPolicy(db, e).familyId);
  const completed = familyWorker.statusFor(e);
  require('../src/config/migrations')[12](db);
  assert.deepEqual(familyWorker.statusFor(e), completed, 'backfill never replaces an existing job');
  // The automatic pipeline drains old no-answer caches and learned matches even with AI offline.
  const autoWorker = require('../src/plugins/insights/suggestions.worker');
  await autoWorker.runForUser(db, d, { allowModel: false });
  assert.equal(db.prepare('SELECT count(*) FROM active_transactions WHERE user_id = ? AND category_id IS NULL').pluck().get(d), 0);
  assert.equal(autoWorker.progressFor(d).autoApplied, 44);
  assert.equal(db.prepare('SELECT count(*) FROM active_transactions WHERE user_id = ? AND category_id = ?').pluck().get(d, familyPolicy(db, d).otherId), 25);
  assert.equal(db.prepare('SELECT count(*) FROM active_transactions WHERE user_id = ? AND category_id = ?').pluck().get(d, dFood), 19);
  // Fresh AI results are applied without becoming user-confirmed merchant rules.
  const f = user();
  const fFood = db.prepare("SELECT id FROM active_categories WHERE user_id = ? AND name = 'Food & Drinks'").pluck().get(f);
  const freshImport = transaction(f, upi('AUTOMATIC SHOP'));
  const freshManual = transaction(f, upi('AUTOMATIC SHOP'));
  db.prepare("UPDATE transactions SET source = 'manual' WHERE id = ?").run(freshManual);
  const assigned = transaction(f, upi('KEEP MY CATEGORY'), fFood);
  const archived = transaction(f, upi('ARCHIVED ROW'));
  db.prepare('UPDATE transactions SET deleted_at = ? WHERE id = ?').run(nowIso(), archived);
  const fMain = db.prepare('SELECT id, name, type FROM active_categories WHERE user_id = ? AND parent_id IS NULL').all(f).sort((x, y) => x.type.localeCompare(y.type) || x.name.localeCompare(y.name));
  answer = { items: [{ t: 1, c: fMain.findIndex((c) => c.name === 'Food & Drinks') + 1, confidence: 'high', person: false }] };
  await autoWorker.runForUser(db, f);
  assert.equal(row(freshImport).category_id, fFood);
  assert.equal(row(freshManual).category_id, fFood);
  assert.equal(row(freshImport).auto_categorized, 1);
  assert.equal(row(assigned).category_id, fFood);
  assert.equal(row(archived).category_id, null);
  assert.equal(db.prepare('SELECT count(*) FROM active_merchant_rules WHERE user_id = ?').pluck().get(f), 0);
  const noAnswer = transaction(f, upi('UNKNOWN PURPOSE'));
  const generic = transaction(f, 'UPI');
  answer = { items: [] };
  await autoWorker.runForUser(db, f);
  assert.equal(row(noAnswer).category_id, familyPolicy(db, f).otherId);
  assert.equal(row(generic).category_id, familyPolicy(db, f).otherId);
  const offline = transaction(f, upi('NEEDS MODEL'));
  await autoWorker.runForUser(db, f, { allowModel: false });
  assert.equal(row(offline).category_id, null, 'a temporarily offline model is retried');
  assert.equal(autoWorker.progressFor(f).waitingForModel, true);
  assert.equal(db.pragma('foreign_key_check').length, 0);
  console.log('Passed: profile persistence/validation, phone normalization and UPI matching, relationship storage, exact names and aliases, import rules, tenant isolation, cached suggestions, model person policy, contact removal and historical recategorization including confirmed rows.');
}
main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => { familyWorker.stopFamilyWorker(); db.close(); });
