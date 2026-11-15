// Quick Capture on synthetic in-memory data only: the rule parser (amounts, dates, tasks, habits,
// categories), AI answers being checked before use, commit through the real ledger/task/habit code
// in one transaction, undo, the inbox, search, validation, tenant isolation, and the daily inbox push.
const assert = require('node:assert/strict');
const Database = require('better-sqlite3-multiple-ciphers');
const db = new Database(':memory:');
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports }; };
let aiAnswer = null;
let lastAiRequest = null;
stub('../src/config/db', { getDb: () => db });
stub('../src/core/logger', { info() {}, warn() {}, error() {} });
stub('../src/plugins/insights/llm.client', {
  structured: async (userId, request) => { lastAiRequest = request; if (aiAnswer instanceof Error) throw aiAnswer; assert.equal(request.webSearch, false, 'capture never searches the web'); return { data: aiAnswer, provider: 'local' }; },
  parseJson: JSON.parse,
});
stub('../src/plugins/insights/suggestions.worker', { resetForUser() {} });
for (const m of require('../src/config/migrations')) typeof m === 'function' ? m(db) : db.exec(m);
db.pragma('foreign_keys = ON');
const { insertUser } = require('../src/plugins/users/user.model');
const { seedDefaults } = require('../src/plugins/users/defaults');
const parser = require('../src/plugins/capture/capture.parser');
const { toAction } = require('../src/plugins/capture/capture.ai');
const capture = require('../src/plugins/capture/capture.service');
const schemas = require('../src/plugins/capture/capture.validation');
const { run } = require('../src/plugins/tasks/context');
const habitService = require('../src/plugins/tasks/habit.service');
const { remindersFor } = require('../src/plugins/notifications/reminders');
const { DEFAULT_PREFERENCES } = require('../src/plugins/notifications/notification.service');
const { DEFAULT_SETTINGS } = require('../src/plugins/tasks/settings');
const userService = require('../src/plugins/users/user.service');
const { capturedMatches, mergeIntoCaptured } = require('../src/plugins/sms/sms.reconcile');
const { insertTransaction } = require('../src/plugins/transactions/transaction.model');

const a = insertUser(db, { email: 'capture-a@example.invalid', name: 'Capture A', passwordHash: 'unused' });
const b = insertUser(db, { email: 'capture-b@example.invalid', name: 'Capture B', passwordHash: 'unused' });
seedDefaults(db, a); seedDefaults(db, b);
const TODAY = '2026-11-15'; // a Sunday
const now = new Date(`${TODAY}T12:00:00+05:30`);
const opts = { now };

async function parserCases() {
  const ctx = capture.contextFor(db, a, now);
  assert.equal(ctx.today, TODAY);
  const one = (text) => parser.parse(text, ctx).actions[0];

  // Payments.
  let t = one('chai 40 upi');
  assert.equal(t.type, 'transaction');
  assert.deepEqual([t.data.amount, t.data.direction, t.data.paymentMode, t.data.description, t.data.categoryName, t.data.date], [40, 'debit', 'upi', 'Chai', 'Cafes & Coffee', TODAY]);
  assert.equal(one('Paid ₹1,250 for groceries at dmart').data.amount, 1250);
  assert.equal(one('Paid ₹1,250 for groceries at dmart').data.categoryName, 'Groceries');
  t = one('salary 85k received');
  assert.deepEqual([t.data.amount, t.data.direction, t.data.categoryName], [85000, 'credit', 'Monthly Salary']);
  assert.equal(one('got 500 from dad').data.direction, 'credit');
  assert.equal(one('+300 cashback').data.direction, 'credit');
  assert.equal(one('uber 230 yesterday').data.date, '2026-11-14', 'yesterday dates the payment');
  assert.equal(one('2 coffees 120').data.amount, 120, 'the largest bare number is the amount');
  assert.equal(one('dinner 1.5k sbi card').data.account, 'sbi');
  assert.equal(one('dinner 1.5k sbi card').data.amount, 1500);
  assert.equal(one('random thing 99').data.category, undefined, 'no guess when nothing matches');

  // Tasks and dates.
  t = one('remind me to call mom tomorrow at 7pm');
  assert.deepEqual([t.type, t.data.title, t.data.dueDate, t.data.dueTime], ['task', 'Call mom', '2026-11-16', '19:00']);
  t = one('dentist fri 5:30pm');
  assert.deepEqual([t.type, t.data.title, t.data.dueDate, t.data.dueTime], ['task', 'Dentist', '2026-11-20', '17:30']);
  assert.equal(one('todo: renew passport').data.dueDate, null);
  assert.equal(one('pay rent 15000 on 1st').type, 'task', 'money due in the future is a to-do');
  assert.equal(one('pay rent 15000 on 1st').data.dueDate, '2026-12-01');
  assert.equal(one('submit report 25 dec').data.dueDate, '2026-12-25');
  assert.equal(one('submit report in 3 days').data.dueDate, '2026-11-18');
  assert.equal(one('gym sun').data.dueDate, '2026-11-22', 'a bare weekday on that weekday means next week');
  assert.equal(one('call bank tonight').data.dueTime, '21:00');

  // Notes, splitting, empty input.
  assert.equal(one('idea: a budgeting board game').type, 'note');
  assert.equal(parser.parse('idea: a budgeting board game', ctx).understood, false);
  const many = parser.parse('chai 40; remind me to water plants tomorrow\nbread and butter 60', ctx).actions;
  assert.deepEqual(many.map((x) => x.type), ['transaction', 'task', 'transaction'], '"and" never splits');
  assert.equal(many[2].data.description, 'Bread and butter');
  assert.deepEqual(parser.parse('  ', ctx).actions, []);
  assert.equal(parser.splitClauses(Array(20).fill('x').join(';')).length, parser.MAX_CLAUSES);
  assert.equal(one('call at 5pm').type, 'task', 'a time is never read as an amount');
}

async function habitsAndCommit() {
  const water = run(a, (ctx) => habitService.createHabit(ctx, { name: 'Drink water', targetQuantity: 8, unit: 'glasses', startDate: '2026-11-01' }), opts).data;
  const gym = run(a, (ctx) => habitService.createHabit(ctx, { name: 'Gym', startDate: '2026-11-01' }), opts).data;
  const ctx = capture.contextFor(db, a, now);
  const one = (text) => parser.parse(text, ctx).actions[0];
  assert.deepEqual(one('gym done'), { type: 'habit', data: { habitId: gym._id, name: 'Gym' } });
  assert.deepEqual(one('water 6 glasses').data, { habitId: water._id, name: 'Drink water', quantity: 6 });
  assert.equal(one('gym').type, 'habit', 'the exact habit name alone checks in');
  assert.equal(one('gym membership 2000').type, 'transaction', 'mentioning a habit without "done" is not a check-in');
  assert.equal(one('water bill 450').type, 'transaction');

  // Commit: three things at once, through the real modules, with XP events returned.
  const text = 'chai 40 upi; gym done; remind me to pay rent fri';
  const preview = await capture.preview(a, text, opts);
  assert.equal(preview.engine, 'rules'); assert.equal(preview.understood, true);
  const saved = capture.commit(a, { text, actions: preview.actions }, opts);
  assert.equal(saved.data.created.length, 3); assert.equal(saved.data.capture.status, 'done');
  assert.ok(saved.events.some((e) => e.type === 'xp' && e.reason === 'habit'), 'the check-in paid habit XP');
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(saved.data.created[0].id);
  assert.deepEqual([tx.amount_paise, tx.source, tx.payment_mode, tx.auto_categorized, tx.user_id], [4000, 'manual', 'upi', 1, a]);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(saved.data.created[2].id);
  assert.deepEqual([task.title, task.due_date], ['Pay rent', '2026-11-20']);
  assert.equal(db.prepare("SELECT count(*) FROM habit_checkins WHERE habit_id = ? AND date = ?").pluck().get(gym._id, TODAY), 1);

  // Undo reverses all three, including the habit XP.
  const xpBefore = db.prepare('SELECT ifnull(sum(amount), 0) FROM xp_events WHERE user_id = ?').pluck().get(a);
  const undone = capture.undo(a, saved.data.capture._id, opts);
  assert.equal(undone.data.status, 'undone'); assert.deepEqual(undone.data.kept, []);
  assert.ok(db.prepare('SELECT deleted_at FROM transactions WHERE id = ?').pluck().get(tx.id));
  assert.ok(db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').pluck().get(task.id));
  assert.equal(db.prepare("SELECT count(*) FROM habit_checkins WHERE habit_id = ?").pluck().get(gym._id), 0);
  assert.ok(db.prepare('SELECT ifnull(sum(amount), 0) FROM xp_events WHERE user_id = ?').pluck().get(a) < xpBefore, 'XP reversed');
  assert.throws(() => capture.undo(a, saved.data.capture._id, opts), /Only a saved capture/);

  // A completed task survives undo (its XP was already shown to the person).
  const t2 = capture.commit(a, { text: 'todo: frame photo' }, opts).data;
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(t2.created[0].id);
  assert.equal(capture.undo(a, t2.capture._id, opts).data.kept.length, 1);

  // Everything in one transaction: one bad action (another account's category) saves nothing.
  const foreign = db.prepare('SELECT id FROM categories WHERE user_id = ? LIMIT 1').pluck().get(b);
  const before = db.prepare('SELECT count(*) FROM tasks').pluck().get();
  assert.throws(() => capture.commit(a, { text: 'x', actions: [
    { type: 'task', data: { title: 'Should not survive' } },
    { type: 'transaction', data: { date: TODAY, description: 'x', amount: 1, direction: 'debit', category: foreign } },
  ] }, opts), /Category not found/);
  assert.equal(db.prepare('SELECT count(*) FROM tasks').pluck().get(), before, 'rolled back');
  assert.throws(() => capture.commit(b, { text: 'gym', actions: [{ type: 'habit', data: { habitId: gym._id } }] }, opts), /Habit not found/);
}

// Fix 3, 4, 6 on the rule parser: habit dates, several payments in one line, keyword false positives.
async function parserFixes() {
  const ctx = capture.contextFor(db, a, now);
  const all = (text) => parser.parse(text, ctx).actions;
  const one = (text) => all(text)[0];
  const gym = ctx.habits.find((h) => h.name === 'Gym');

  // 3. A named day reaches the check-in; days the habit service would refuse become notes, never a failing save.
  assert.deepEqual(one('gym done yesterday'), { type: 'habit', data: { habitId: gym.id, name: 'Gym', date: '2026-11-14' } });
  assert.equal(one('gym done today').data.date, TODAY);
  assert.equal(one('gym done sat').data.date, '2026-11-14', 'a bare weekday on a done thing is the most recent one');
  assert.deepEqual(one('water 6 glasses yesterday').data, { habitId: ctx.habits.find((h) => h.name === 'Drink water').id, name: 'Drink water', quantity: 6, date: '2026-11-14' });
  for (const text of ['gym done 3 days ago', 'gym done 2026-11-01', 'gym done tomorrow', 'gym done 12 nov']) assert.equal(one(text).type, 'note', `${text} must not become a check-in`);
  assert.equal(one('gym tomorrow').type, 'task', 'a dated mention without "done" is still a to-do');
  assert.equal(parser.parse('gym done 3 days ago', ctx).understood, false);
  // A habit that starts today can't be checked in for yesterday.
  const young = { ...ctx, habits: [{ id: 'h-new', name: 'Read', startDate: TODAY }] };
  assert.equal(parser.parse('read done yesterday', young).actions[0].type, 'note');
  assert.equal(parser.parse('read done', young).actions[0].type, 'habit');

  // 4. Several payments in one line, only when every part has its own amount.
  const pair = all('chai 40 and samosa 20');
  assert.deepEqual(pair.map((x) => [x.type, x.data.amount, x.data.description]), [['transaction', 40, 'Chai'], ['transaction', 20, 'Samosa']]);
  const shared = all('chai 40, samosa 20 upi');
  assert.deepEqual(shared.map((x) => [x.data.amount, x.data.paymentMode]), [[40, 'upi'], [20, 'upi']], 'a trailing mode applies to every part');
  const dated = all('chai 40 and samosa 20 sbi yesterday');
  assert.deepEqual(dated.map((x) => [x.data.date, x.data.account]), [['2026-11-14', 'sbi'], ['2026-11-14', 'sbi']]);
  const own = all('chai 40 cash, samosa 20 upi yesterday');
  assert.deepEqual(own.map((x) => [x.data.paymentMode, x.data.date]), [['cash', '2026-11-14'], ['upi', '2026-11-14']], 'a part keeps its own mode');
  assert.deepEqual(all('chai 40 yesterday and samosa 20').map((x) => x.data.date), ['2026-11-14', TODAY], 'only a trailing modifier is shared');
  assert.equal(all('bread and butter 60').length, 1, '"bread and butter 60" stays one payment');
  assert.equal(all('lunch with raj and priya 500').length, 1);
  assert.equal(all('chai 40 and samosa 20 and butter').length, 1, 'a part without an amount stops the split');
  assert.equal(all('chai 40, 20').length, 1, 'a part needs a name as well as a number');
  assert.equal(all('Paid ₹1,250 for groceries').length, 1, 'a comma inside an amount is not a separator');
  assert.deepEqual(all('Paid ₹1,250 for groceries, chai 40').map((x) => x.data.amount), [1250, 40]);
  assert.deepEqual(all('remind me to buy chai 40 and samosa 20').map((x) => x.type), ['task'], 'reminders are never split');
  assert.equal(all(Array.from({ length: 14 }, (_, i) => `item${String.fromCharCode(97 + i)} ${i + 1}`).join(', ')).length, parser.MAX_CLAUSES, 'a split never exceeds what a save accepts');

  // 6. Keyword false positives.
  let t = one('birthday card 100');
  assert.deepEqual([t.data.paymentMode, t.data.description], [undefined, 'Birthday card'], '"card" in a description is not a payment mode');
  assert.equal(one('chai 40 card').data.paymentMode, 'card');
  assert.equal(one('paid by card 200 dinner').data.paymentMode, 'card');
  assert.equal(one('dinner 1.5k debit card').data.paymentMode, 'card');
  assert.equal(one('gift card 500').data.paymentMode, undefined);
  assert.notEqual(one('chocolate bar 50').data.categoryName, 'Drinks & Bars');
  assert.notEqual(one('protein bar 120').data.categoryName, 'Drinks & Bars');
  assert.equal(one('drinks at the bar 900').data.categoryName, 'Drinks & Bars');
  assert.equal(one('beer 300').data.categoryName, 'Drinks & Bars');
  for (const text of ['sun lotion 300', 'sat mat 500', 'wed 20 notebook']) {
    t = one(text);
    assert.deepEqual([t.type, t.data.date], ['transaction', TODAY], `${text} is today's payment, not a to-do`);
  }
  assert.equal(one('sat mat 500').data.description, 'Sat mat');
  assert.equal(one('uber 230 sat').data.date, '2026-11-14', 'a trailing weekday on a payment is the most recent one');
  assert.equal(one('uber 230 next sat').type, 'task', '"next" still looks ahead');
  assert.equal(one('dentist fri 5pm').data.dueDate, '2026-11-20');
  assert.equal(one('dentist fri').type, 'task');
  assert.equal(one('remind me to pay rent fri').data.dueDate, '2026-11-20');
  assert.equal(one('paid maid salary 8000').data.direction, 'debit', 'paying a salary is money out');
  assert.equal(one('salary 85000 received').data.direction, 'credit');
  assert.equal(one('got milk from dmart 60').data.direction, 'debit', 'shopping "from" a shop is not income');
  assert.equal(one('got 500 from dad').data.direction, 'credit');
}

// Fix 2: UPI/card/net banking with no bank named gets the person's usual account instead of 'cash'.
async function accountGuess() {
  const addBank = (bank) => db.prepare('INSERT INTO sms_accounts (id, user_id, bank, last4, senders, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(`acct-${bank}`, a, bank, '1234', '[]', nowStamp, nowStamp);
  const nowStamp = '2026-11-01T00:00:00.000Z';
  const bankRow = (account, date, source = 'sms', amount = 5) => insertTransaction(db, a, { date, description: `bank ${account}`, amount, source, account });
  const parse = (text) => parser.parse(text, capture.contextFor(db, a, now)).actions[0].data;
  assert.equal(capture.contextFor(db, a, now).bankAccount, undefined, 'nothing known');
  assert.equal(parse('chai 40 upi').account, undefined);
  assert.equal(capture.commit(a, { text: 'chai 41 upi' }, opts).data.created[0].id && db.prepare("SELECT account FROM transactions WHERE amount_paise = 4100 AND user_id = ?").pluck().get(a), 'cash', 'with nothing better known');

  addBank('sbi');
  assert.equal(parse('chai 40 upi').account, 'sbi', 'the only registered account');
  assert.equal(parse('chai 40 card').account, 'sbi');
  assert.equal(parse('chai 40 neft').account, 'sbi');
  assert.equal(parse('chai 40 cash').account, undefined, 'cash stays cash');
  assert.equal(parse('chai 40').account, undefined, 'no mode, no guess');
  assert.equal(parse('chai 40 kotak upi').account, 'kotak', 'a named bank wins');
  assert.equal(parse('chai 40 upi, samosa 20').account, 'sbi');
  assert.equal(capture.commit(a, { text: 'chai 42 upi' }, opts).data.created.length, 1);
  assert.equal(db.prepare('SELECT account FROM transactions WHERE amount_paise = 4200 AND user_id = ?').pluck().get(a), 'sbi');
  const ctxB = capture.contextFor(db, b, now);
  assert.equal(ctxB.bankAccount, undefined, 'another account\'s bank is never used');

  // Two registered banks: the one with the most SMS/statement rows in the last 90 days (cash and old rows don't count).
  addBank('kotak');
  assert.equal(capture.contextFor(db, a, now).bankAccount, undefined, 'two banks and no history: nothing better is known');
  const made = [bankRow('kotak', '2026-11-01'), bankRow('kotak', '2026-10-01', 'import'), bankRow('sbi', '2026-11-02'),
    bankRow('cash', '2026-11-03'), bankRow('cash', '2026-11-04'), bankRow('cash', '2026-11-05'),
    ...Array.from({ length: 5 }, (_, i) => bankRow('sbi', `2026-0${i + 1}-01`))];
  assert.equal(capture.contextFor(db, a, now).bankAccount, 'kotak');
  assert.equal(parse('chai 40 upi').account, 'kotak');
  db.prepare("UPDATE sms_accounts SET deleted_at = '2026-11-02T00:00:00.000Z' WHERE user_id = ?").run(a);
  for (const id of made) db.prepare("UPDATE transactions SET deleted_at = '2026-11-02T00:00:00.000Z' WHERE id = ?").run(id);
}

// Fix 1b and the undo rules that go with it: a payment the bank already recorded is annotated, not duplicated.
async function bankRowMatching() {
  const category = db.prepare("SELECT id FROM categories WHERE user_id = ? AND name = 'Cafes & Coffee'").pluck().get(a);
  const bankRow = (extra = {}) => insertTransaction(db, a, { date: TODAY, description: 'UPI/DR/123456789012/RAMESH STALL', amount: 313, source: 'sms', account: 'sbi', paymentMode: 'upi', refNo: '123456789012', ...extra });
  const count = (paise) => db.prepare('SELECT count(*) FROM active_transactions WHERE user_id = ? AND amount_paise = ?').pluck().get(a, paise);
  const row = (id) => db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);

  // Preview tells the person; commit merges.
  let sms = bankRow();
  const preview = await capture.preview(a, 'chai 313 upi', opts);
  assert.equal(preview.actions[0].match.description, 'UPI/DR/123456789012/RAMESH STALL');
  assert.equal(preview.actions[0].data.date, TODAY);
  assert.equal(schemas.commit.safeParse({ body: { text: 'x', actions: preview.actions } }).success, true, 'the display-only match never has to be sent back');
  const saved = capture.commit(a, { text: 'chai 313 upi', actions: preview.actions.map(({ type, data }) => ({ type, data })) }, opts).data;
  assert.equal(saved.created[0].id, sms); assert.equal(saved.created[0].matched, true);
  assert.equal(count(31300), 1, 'no duplicate row');
  let r = row(sms);
  assert.deepEqual([r.source, r.account, r.description, r.date, r.notes, r.category_id, r.auto_categorized, r.capture_id], ['sms', 'sbi', 'UPI/DR/123456789012/RAMESH STALL', TODAY, 'Chai', category, 1, saved.capture._id], 'the bank\'s facts stay; the person\'s words are added');
  assert.equal(capture.search(a, '313')[0].id, sms);

  // Undo puts the row back as it was and never archives the bank's record.
  const undone = capture.undo(a, saved.capture._id, opts).data;
  assert.deepEqual(undone.kept, []);
  r = row(sms);
  assert.deepEqual([r.deleted_at, r.notes, r.category_id, r.auto_categorized, r.capture_id, r.source], [null, null, null, 0, null, 'sms']);

  // An annotated row is spoken for: a second identical capture is a new payment, not another match.
  const first = capture.commit(a, { text: 'chai 313 upi' }, opts).data;
  assert.equal(first.created[0].id, sms);
  const second = capture.commit(a, { text: 'chai 313 upi' }, opts).data;
  assert.notEqual(second.created[0].id, sms); assert.ok(!second.created[0].matched);
  assert.equal(count(31300), 2);
  // Undo of the first leaves the person's later edit alone: they changed the note, so only the category goes back.
  db.prepare("UPDATE transactions SET notes = 'my own words' WHERE id = ?").run(sms);
  capture.undo(a, first.capture._id, opts);
  r = row(sms);
  assert.deepEqual([r.notes, r.category_id, r.capture_id], ['my own words', null, null]);
  capture.undo(a, second.capture._id, opts);

  // A day either side matches; two days do not; a row the person already described and sorted does not.
  const near = bankRow({ amount: 321, date: '2026-11-14' });
  assert.equal(capture.commit(a, { text: 'tea 321' }, opts).data.created[0].id, near, 'yesterday is within a day');
  const far = bankRow({ amount: 322, date: '2026-11-12' });
  assert.notEqual(capture.commit(a, { text: 'tea 322' }, opts).data.created[0].id, far);
  const done = bankRow({ amount: 323, notes: 'already said', category, autoCategorized: false });
  assert.notEqual(capture.commit(a, { text: 'tea 323' }, opts).data.created[0].id, done, 'already described and sorted');
  const credit = bankRow({ amount: 324, type: 'credit' });
  assert.notEqual(capture.commit(a, { text: 'tea 324' }, opts).data.created[0].id, credit, 'direction must match');
  const foreign = insertTransaction(db, b, { date: TODAY, description: 'UPI/DR/x', amount: 325, source: 'sms', account: 'sbi' });
  assert.notEqual(capture.commit(a, { text: 'tea 325' }, opts).data.created[0].id, foreign, 'only your own rows');
  assert.equal(row(foreign).capture_id, null);
  const archived = bankRow({ amount: 326 });
  db.prepare("UPDATE transactions SET deleted_at = '2026-11-15T00:00:00.000Z' WHERE id = ?").run(archived);
  assert.notEqual(capture.commit(a, { text: 'tea 326' }, opts).data.created[0].id, archived, 'archived rows are ignored');
  const pair = insertTransaction(db, a, { date: TODAY, description: 'UPI/DR/y', amount: 327, source: 'sms', account: 'sbi' });
  db.prepare("UPDATE transactions SET transfer_id = 'tr-1' WHERE id = ?").run(pair);
  assert.notEqual(capture.commit(a, { text: 'tea 327' }, opts).data.created[0].id, pair, 'a transfer between own accounts is not a purchase');

  // Two candidates: the capture's bank breaks the tie when it names one; otherwise nothing is merged.
  const sbiRow = bankRow({ amount: 414 }); const kotakRow = bankRow({ amount: 414, account: 'kotak', description: 'UPI/DR/2' });
  assert.equal(capture.commit(a, { text: 'lunch 414 kotak upi' }, opts).data.created[0].id, kotakRow);
  const sbiRow2 = bankRow({ amount: 415 }); bankRow({ amount: 415, account: 'kotak', description: 'UPI/DR/3' }); // different accounts: genuinely can't tell (identical rows are covered in the pass-3 block)
  assert.ok(!capture.commit(a, { text: 'lunch 415' }, opts).data.created[0].matched, 'ambiguous: save a separate row');
  assert.ok(sbiRow && sbiRow2);
  // The account the capture guessed is not required to agree with the bank row.
  const guessed = bankRow({ amount: 416, account: 'kotak' });
  assert.equal(capture.commit(a, { text: 'lunch 416 sbi upi' }, opts).data.created[0].id, guessed);

  // One save can use a bank row only once, and a note-only description does not overwrite a default.
  const lone = bankRow({ amount: 417 });
  const twice = capture.commit(a, { text: 'tea 417 and coffee 417' }, opts).data.created;
  assert.deepEqual([twice[0].id, twice[1].matched], [lone, undefined]);
  const bare = bankRow({ amount: 418 });
  capture.commit(a, { text: 'paid 418' }, opts);
  assert.equal(row(bare).notes, null, 'the generic "Quick expense" is not written as a note');
}

// Fix 1a's capture side: a captured row has a capture_id; the undo rules when the SMS merged into it.
async function capturedRowsAndSms() {
  const saved = capture.commit(a, { text: 'coffee 99 upi' }, opts).data;
  const id = saved.created[0].id;
  assert.equal(db.prepare('SELECT capture_id FROM transactions WHERE id = ?').pluck().get(id), saved.capture._id);
  const hand = insertTransaction(db, a, { date: TODAY, description: 'Hand typed coffee', amount: 99, source: 'manual' });
  const doc = { type: 'debit', amount: 99, date: TODAY, account: 'sbi', refNo: '123456789099', paymentMode: 'upi' };
  assert.deepEqual(capturedMatches(db, a, doc).map((x) => x.id), [id], 'only the Quick Capture row is a candidate');
  assert.deepEqual(capturedMatches(db, b, doc), [], 'scoped to the account');
  mergeIntoCaptured(db, a, db.prepare('SELECT * FROM transactions WHERE id = ?').get(id), doc);
  const undone = capture.undo(a, saved.capture._id, opts).data;
  assert.deepEqual(undone.kept.map((k) => k.id), [id], 'a bank-confirmed payment is kept, and reported');
  const r = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  assert.deepEqual([r.deleted_at, r.source, r.account, r.description], [null, 'sms', 'sbi', 'Coffee']);
  assert.equal(db.prepare('SELECT deleted_at FROM transactions WHERE id = ?').pluck().get(hand), null);
  // The ledger API cannot mint a capture_id.
  const { createTransaction } = require('../src/plugins/transactions/transaction.validation');
  const parsed = createTransaction.parse({ body: { date: TODAY, description: 'x', amount: 5, captureId: 'forged', capture_id: 'forged' } });
  assert.equal(parsed.body.captureId, undefined);
}

// Habit saves: a date reaches the check-in; undoing a repeat doesn't delete the earlier check-in.
async function habitDates() {
  const gym = db.prepare("SELECT id FROM habits WHERE user_id = ? AND name = 'Gym'").pluck().get(a);
  const days = () => db.prepare("SELECT date FROM habit_checkins WHERE habit_id = ? ORDER BY date").pluck().all(gym);
  const y = capture.commit(a, { text: 'gym done yesterday' }, opts).data;
  assert.deepEqual(days(), ['2026-11-14']); assert.equal(y.created[0].date, '2026-11-14');
  const stale = await capture.preview(a, 'gym done 3 days ago', opts);
  assert.deepEqual(stale.actions.map((x) => x.type), ['note'], 'too old for the grace window becomes a note');
  capture.undo(a, y.capture._id, opts);
  assert.deepEqual(days(), []);
  const one = capture.commit(a, { text: 'gym done' }, opts).data;
  const again = capture.commit(a, { text: 'gym done' }, opts).data;
  assert.equal(again.created[0].already, true);
  capture.undo(a, again.capture._id, opts);
  assert.deepEqual(days(), [TODAY], 'the first check-in is still there');
  capture.undo(a, one.capture._id, opts);
  assert.deepEqual(days(), []);
  // Several payments in one line really become several rows, in one save.
  const multi = capture.commit(a, { text: 'chai 61 and samosa 22 upi' }, opts).data;
  assert.equal(multi.created.length, 2);
  assert.deepEqual(multi.created.map((c) => c.amount), [61, 22]);
  capture.undo(a, multi.capture._id, opts);
}

// Fix 5: a retried save returns the first result and applies nothing again.
async function idempotency() {
  const txCount = () => db.prepare('SELECT count(*) FROM transactions WHERE user_id = ?').pluck().get(a);
  const capCount = () => db.prepare('SELECT count(*) FROM captures WHERE user_id = ?').pluck().get(a);
  const key = 'client-key-0001';
  const body = { text: 'chai 71; idea: retry me', clientId: key };
  const first = capture.commit(a, body, opts);
  const [tx, caps] = [txCount(), capCount()];
  const again = capture.commit(a, body, opts);
  assert.equal(again.data.replayed, true); assert.deepEqual(again.events, []);
  assert.equal(again.data.capture._id, first.data.capture._id);
  assert.deepEqual(again.data.created, first.data.created);
  assert.deepEqual(again.data.inbox.map((i) => i._id), first.data.inbox.map((i) => i._id));
  assert.deepEqual([txCount(), capCount()], [tx, caps], 'nothing applied twice');
  assert.equal(first.data.replayed, undefined);
  capture.dismiss(a, first.data.inbox[0]._id);

  // Notes only: several inbox rows come back, none duplicated.
  const notes = capture.commit(a, { text: 'idea: one\nidea: two', clientId: 'client-key-0002' }, opts).data;
  assert.equal(notes.capture, null); assert.equal(notes.inbox.length, 2);
  const noteRetry = capture.commit(a, { text: 'idea: one\nidea: two', clientId: 'client-key-0002' }, opts).data;
  assert.deepEqual(noteRetry.inbox.map((i) => i._id), notes.inbox.map((i) => i._id));
  assert.equal(capture.listInbox(a).total, 2, 'no duplicate notes');
  assert.equal(noteRetry.capture, null);
  // A key that merely starts with another key is a different save.
  const other = capture.commit(a, { text: 'idea: three', clientId: 'client-key-00021' }, opts).data;
  assert.equal(other.replayed, undefined); assert.equal(other.inbox.length, 1);
  for (const i of [...notes.inbox, ...other.inbox]) capture.dismiss(a, i._id);

  // Sorting an inbox note: the retry still replays even though the note is now resolved.
  const inboxNote = capture.commit(a, { text: 'idea: file taxes' }, opts).data.inbox[0];
  const sorted = capture.commit(a, { text: 'file taxes next week', inboxId: inboxNote._id, clientId: 'client-key-0003' }, opts).data;
  assert.equal(sorted.capture._id, inboxNote._id);
  const sortedRetry = capture.commit(a, { text: 'file taxes next week', inboxId: inboxNote._id, clientId: 'client-key-0003' }, opts).data;
  assert.equal(sortedRetry.replayed, true); assert.equal(sortedRetry.capture._id, inboxNote._id);
  const taskCount = db.prepare("SELECT count(*) FROM tasks WHERE user_id = ? AND title = 'File taxes'").pluck().get(a);
  assert.equal(taskCount, 1);

  // Keys belong to one account; another account's retry is its own save.
  const mine = capture.commit(a, { text: 'chai 72', clientId: 'client-key-0004' }, opts).data;
  const theirs = capture.commit(b, { text: 'chai 72', clientId: 'client-key-0004' }, opts).data;
  assert.notEqual(theirs.capture._id, mine.capture._id); assert.equal(theirs.replayed, undefined);
  assert.equal(capture.commit(b, { text: 'chai 72', clientId: 'client-key-0004' }, opts).data.capture._id, theirs.capture._id);
  // Without a key every save is new (older clients).
  assert.notEqual(capture.commit(a, { text: 'chai 73' }, opts).data.capture._id, capture.commit(a, { text: 'chai 73' }, opts).data.capture._id);
  // A failed save leaves no key behind, so the retry can succeed.
  const foreign = db.prepare('SELECT id FROM categories WHERE user_id = ? LIMIT 1').pluck().get(b);
  const bad = { text: 'x', clientId: 'client-key-0005', actions: [{ type: 'transaction', data: { date: TODAY, description: 'x', amount: 1, direction: 'debit', category: foreign } }] };
  assert.throws(() => capture.commit(a, bad, opts), /Category not found/);
  assert.equal(db.prepare("SELECT count(*) FROM captures WHERE client_id = 'client-key-0005'").pluck().get(), 0);
  assert.equal(capture.commit(a, { text: 'chai 74', clientId: 'client-key-0005' }, opts).data.created.length, 1);
  // The same key with different text is refused, not answered with the old save (the new text would be lost).
  assert.throws(() => capture.commit(a, { text: 'lunch 500', clientId: 'client-key-0004' }, opts), (e) => e.statusCode === 409 && e.code === 'CAPTURE_CLIENT_ID_REUSED');
  assert.throws(() => capture.commit(a, { text: 'idea: different', clientId: 'client-key-0002' }, opts), /different text/, 'notes-only saves are checked too');
  assert.equal(capture.commit(a, { text: '  chai   72 ', clientId: 'client-key-0004' }, opts).data.replayed, true, 'spacing alone is not a different text');
  // A retry after the save was undone says so: the palette must not toast "Saved" or offer Undo for it.
  const undoable = capture.commit(a, { text: 'chai 75', clientId: 'client-key-0007' }, opts).data;
  capture.undo(a, undoable.capture._id, opts);
  const afterUndo = capture.commit(a, { text: 'chai 75', clientId: 'client-key-0007' }, opts).data;
  assert.deepEqual([afterUndo.replayed, afterUndo.capture.status], [true, 'undone']);
  // The database itself refuses a duplicate key.
  assert.throws(() => insertCaptureRow(a, 'client-key-0004'), /UNIQUE/);
  insertCaptureRow(b, 'client-key-0006'); insertCaptureRow(a, 'client-key-0006');

  // Validation: a key is 8–64 letters, digits, "-" or "_".
  const ok = (clientId) => schemas.commit.safeParse({ body: { text: 'x', clientId } }).success;
  assert.equal(ok('3f2b8c1e-9d4a-4b7e-8c21-0a1b2c3d4e5f'), true);
  assert.equal(ok(undefined), true, 'optional for older clients');
  for (const bad of ['short', '', 'has space 1234', 'pct%wild_card', 'x'.repeat(65), 12345678, 'a#b-12345678', 'semi;colon1']) assert.equal(ok(bad), false, `${bad} is refused`);
}
function insertCaptureRow(userId, clientId) {
  db.prepare("INSERT INTO captures (id, user_id, text, status, engine, client_id, created_at, updated_at) VALUES (?, ?, 'x', 'dismissed', 'rules', ?, 'n', 'n')")
    .run(`row-${Math.random()}`, userId, clientId);
}

// Pass 2 review fixes, each pinned with the reviewer's own inputs.
async function reviewFixes() {
  const ctx = capture.contextFor(db, a, now);
  const all = (text) => parser.parse(text, ctx).actions;
  const one = (text) => all(text)[0];
  const count = (paise) => db.prepare('SELECT count(*) FROM active_transactions WHERE user_id = ? AND amount_paise = ?').pluck().get(a, paise);
  const bankRow = (extra = {}) => insertTransaction(db, a, { date: TODAY, description: 'UPI/DR/123456789012/STALL', amount: 1, source: 'sms', account: 'sbi', paymentMode: 'upi', ...extra });
  const row = (id) => db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  const saveId = (text) => capture.commit(a, { text }, opts).data.created[0];
  const category = db.prepare("SELECT id FROM categories WHERE user_id = ? AND name = 'Cafes & Coffee'").pluck().get(a);

  // 1. Cash never merges with a bank payment (capture side; the SMS side is in test-sms.js).
  const cashBank = bankRow({ amount: 520 });
  assert.equal((await capture.preview(a, 'chai 520 cash', opts)).actions[0].match, undefined, 'cash is not matched in the preview');
  const cashSaved = saveId('chai 520 cash');
  assert.notEqual(cashSaved.id, cashBank); assert.ok(!cashSaved.matched);
  assert.equal(count(52000), 2, 'the cash payment is its own row');
  assert.equal(row(cashBank).capture_id, null, 'the bank row is untouched');
  assert.equal(saveId('chai 520 upi').id, cashBank, 'the same words with a bank mode do match');

  // 2. Two undescribed bank rows of one amount: the capture's own day picks one (a daily chai).
  const y = bankRow({ amount: 530, date: '2026-11-14', description: 'UPI/DR/1/Y' }); const t = bankRow({ amount: 530, description: 'UPI/DR/2/T' });
  assert.equal(saveId('chai 530 upi yesterday').id, y, 'the day before matches the day-before row');
  assert.equal(saveId('chai 530 upi').id, t, 'today matches today\'s row');
  assert.equal(count(53000), 2, 'no third row');
  const same1 = bankRow({ amount: 531, account: 'sbi', description: 'UPI/DR/3/A' }); const same2 = bankRow({ amount: 531, account: 'kotak', description: 'UPI/DR/4/B' });
  assert.equal(saveId('chai 531 kotak upi').id, same2, 'same day: the named bank decides');
  assert.ok(same1);
  const tied = [bankRow({ amount: 532, date: '2026-11-14', description: 'UPI/DR/5/C' }), bankRow({ amount: 532, date: '2026-11-16', description: 'UPI/DR/6/D' })]; // neither on the capture's day
  assert.ok(!saveId('chai 532 upi').matched, 'truly ambiguous: a separate row, nothing merged');
  assert.ok(tied.every((id) => row(id).capture_id === null));

  // 3. A row the person already described is not a match, even when its category was a rule's guess.
  const described = bankRow({ amount: 540, notes: 'metro recharge', category, autoCategorized: true, description: 'UPI/DR/7/E' });
  const tea = saveId('tea 540 upi');
  assert.notEqual(tea.id, described); assert.ok(!tea.matched);
  assert.equal(row(described).notes, 'metro recharge'); assert.equal(row(described).capture_id, null);
  assert.equal(count(54000), 2, 'chai is recorded as its own payment');
  // A bare "paid 550" has nothing to add, but it is still the bank's payment: no duplicate row.
  const plain = bankRow({ amount: 550, description: 'UPI/DR/8/F' });
  const bare = saveId('paid 550');
  assert.equal(bare.id, plain); assert.equal(count(55000), 1);
  assert.deepEqual(bare.applied, {});
  assert.deepEqual(capture.undo(a, db.prepare('SELECT id FROM captures WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').pluck().get(a), opts).data.kept, []);
  assert.equal(row(plain).deleted_at, null); assert.equal(row(plain).capture_id, null);

  // 4. A paid-out verb only counts at the start of the clause: money coming in stays credit.
  for (const text of ['got paid salary 85000', 'company paid salary 85000', 'boss gave bonus 5000', 'client sent bonus 5000']) {
    assert.equal(one(text).data.direction, 'credit', `${text} is income`);
  }
  for (const text of ['paid maid salary 8000', 'I paid maid salary 8000', 'gave maid salary 8000', 'sent mom 5000 salary share']) assert.equal(one(text).data.direction, 'debit', `${text} is money out`);

  // 5. The AI engine's habit dates and payment modes are checked the same way the rules do.
  const gym = ctx.habits.find((h) => h.name === 'Gym');
  const habitAi = (date) => toAction({ type: 'habit', description: '', habit: 'Gym', date, amount: null, direction: null, time: null, quantity: null, category: null, paymentMode: null }, { ...ctx, original: 'orig' });
  assert.deepEqual(habitAi('2026-11-14'), { type: 'habit', data: { habitId: gym.id, name: 'Gym', date: '2026-11-14' } }, 'yesterday reaches the check-in');
  assert.equal(habitAi(null).data.date, undefined);
  assert.equal(habitAi(TODAY).type, 'habit');
  for (const date of ['2026-11-01', '2026-11-16', '2026-10-30']) assert.equal(habitAi(date).type, 'note', `${date} would fail the save`);
  const young = { ...ctx, habits: [{ id: 'h-new', name: 'Gym', startDate: TODAY }] };
  assert.equal(toAction({ type: 'habit', habit: 'Gym', date: '2026-11-14' }, { ...young, original: 'o' }).type, 'note', 'before the habit started');
  const payAi = (paymentMode, extra = {}) => toAction({ type: 'transaction', description: 'Chai', amount: 40, direction: 'debit', paymentMode }, { ...ctx, bankAccount: undefined, original: 'o', ...extra }).data;
  assert.deepEqual([payAi('upi', { bankAccount: 'sbi' }).paymentMode, payAi('upi', { bankAccount: 'sbi' }).account], ['upi', 'sbi']);
  assert.equal(payAi('cash', { bankAccount: 'sbi' }).account, undefined, 'cash is not a bank payment');
  assert.equal(payAi('bitcoin').paymentMode, undefined, 'an unknown mode is dropped');
  assert.equal(payAi('upi').account, undefined, 'no usual bank known');

  // 6. A short weekday after the amount is a date; one that is just a word is not.
  let r = one('uber 230 sat upi');
  assert.deepEqual([r.type, r.data.date, r.data.description, r.data.paymentMode], ['transaction', '2026-11-14', 'Uber', 'upi']);
  r = one('chai 40 sat cash');
  assert.deepEqual([r.data.date, r.data.description, r.data.paymentMode], ['2026-11-14', 'Chai', 'cash']);
  r = one('sun lotion 300 on sat');
  assert.deepEqual([r.type, r.data.date, r.data.description], ['transaction', '2026-11-14', 'Sun lotion']);
  assert.equal(one('sun lotion 300').data.date, TODAY, 'still just a word when nothing marks it as a day');

  // 7. Recent payment dates and explicit past-tense payments stay in the past; tasks still look ahead.
  r = one('paid 500 on 3 nov');
  assert.deepEqual([r.type, r.data.date, r.data.amount], ['transaction', '2026-11-03', 500]);
  assert.equal(one('uber 230 on 25 oct').data.date, '2026-10-25');
  r = one('paid 500 on 3 mar');
  assert.deepEqual([r.type, r.data.date, r.data.amount, r.data.direction], ['transaction', '2026-03-03', 500, 'debit'], 'an explicit past-tense payment keeps its historical date');
  r = one('received 500 on 3 mar');
  assert.deepEqual([r.type, r.data.date, r.data.direction], ['transaction', '2026-03-03', 'credit'], 'a past receipt also keeps its historical date');
  for (const text of ['500 on 3 mar', 'pay 500 on 3 mar', 'remind me to pay 500 on 3 mar']) {
    r = one(text);
    assert.deepEqual([r.type, r.data.dueDate], ['task', '2027-03-03'], `${text} keeps the future reading`);
  }
  r = parser.parse('paid 500 on 3 dec', { ...ctx, today: '2027-01-15' }).actions[0];
  assert.deepEqual([r.type, r.data.date], ['transaction', '2026-12-03'], 'a completed payment can belong to the previous year');
  assert.equal(one('submit report 3 nov').data.dueDate, '2027-11-03', 'a task keeps the future reading');
  assert.equal(one('pay rent 15000 on 1st').type, 'task');
  assert.equal(one('gym done 3 nov').type, 'note', 'a past check-in outside the grace window is a note');

  // 8. "and" splits only parts of the same shape: a quantity is not a second price.
  assert.deepEqual(all('chai 40 and 2 samosas').map((x) => x.data.amount), [40], '"2 samosas" is a quantity, so no split');
  assert.deepEqual(all('40 chai and 20 samosa').map((x) => [x.data.amount, x.data.description]), [[40, 'Chai'], [20, 'Samosa']]);
  assert.deepEqual(all('chai 40 and ₹20 samosa').map((x) => x.data.amount), [40, 20], 'a ₹ amount fits either shape');
  assert.deepEqual(all('chai 40 upi and samosa 20').map((x) => x.data.amount), [40, 20]);

  // 11. Undoing a repeat check-in goes through the habit service: the XP the repeat paid is taken back.
  const water = ctx.habits.find((h) => h.name === 'Drink water');
  const waterXp = () => db.prepare('SELECT ifnull(sum(amount), 0) FROM xp_events WHERE user_id = ? AND source_id = ?').pluck().get(a, water.id);
  const first = capture.commit(a, { text: 'water 3 glasses' }, opts).data;
  const afterFirst = waterXp();
  const second = capture.commit(a, { text: 'water 8 glasses' }, opts);
  assert.equal(second.data.created[0].already, true);
  assert.ok(waterXp() > afterFirst, 'reaching the target paid XP');
  assert.equal(db.prepare('SELECT current_streak FROM habits WHERE id = ?').pluck().get(water.id), 1);
  capture.undo(a, second.data.capture._id, opts);
  assert.equal(waterXp(), afterFirst, 'the repeat\'s XP is reversed');
  assert.equal(db.prepare("SELECT quantity FROM habit_checkins WHERE habit_id = ? AND date = ?").pluck().get(water.id, TODAY), 3, 'quantity put back');
  assert.equal(db.prepare('SELECT current_streak FROM habits WHERE id = ?').pluck().get(water.id), 0, 'the streak is re-evaluated');
  capture.undo(a, first.capture._id, opts);
  assert.equal(db.prepare('SELECT count(*) FROM habit_checkins WHERE habit_id = ?').pluck().get(water.id), 0);

  // 12. A habit whose schedule skips the day becomes a note instead of failing the whole save.
  run(a, (c) => habitService.createHabit(c, { name: 'Standup', cadence: 'weekdays', daysMask: 31, startDate: '2026-11-01' }), opts);
  const sched = capture.contextFor(db, a, now);
  assert.deepEqual(sched.habits.find((h) => h.name === 'Standup').unscheduled, ['2026-11-14', TODAY], 'Saturday and Sunday');
  assert.equal(parser.parse('standup done', sched).actions[0].type, 'note');
  assert.equal(parser.parse('standup done yesterday', sched).actions[0].type, 'note');
  assert.equal(parser.parse('gym done', sched).actions[0].type, 'habit', 'other habits are unaffected');
  const standup = sched.habits.find((h) => h.name === 'Standup');
  assert.equal(toAction({ type: 'habit', habit: 'Standup' }, { ...sched, original: 'o' }).type, 'note');
  assert.ok(standup);
  const withNote = capture.commit(a, { text: 'standup done; chai 77' }, opts).data;
  assert.equal(withNote.created.length, 1, 'the payment saves even though the check-in became a note');
  assert.equal(withNote.inbox[0].text, 'standup done');
  capture.dismiss(a, withNote.inbox[0]._id);
}

// Pass 3: dates, directions and quantities in multi-part lines, named banks, and how duplicate-prone bank rows pair up.
async function passThree() {
  const ctx = { ...capture.contextFor(db, a, now), bankAccount: 'kotak' }; // "kotak" = the usual-bank guess
  const all = (text) => parser.parse(text, ctx).actions;
  const one = (text) => all(text)[0];
  const summary = (text) => all(text).map((x) => [x.type, x.data.direction, x.data.amount, x.data.description]);
  const bankRow = (extra = {}) => insertTransaction(db, a, { date: TODAY, description: 'UPI/DR/123456789012/STALL', amount: 1, source: 'sms', account: 'sbi', paymentMode: 'upi', ...extra });
  const row = (id) => db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  const count = (paise) => db.prepare('SELECT count(*) FROM active_transactions WHERE user_id = ? AND amount_paise = ?').pluck().get(a, paise);
  const lastCapture = () => db.prepare('SELECT id FROM captures WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').pluck().get(a);

  // 1. Money still to be paid looks ahead; a past-tense verb or a plain purchase names a day that has gone by.
  for (const [text, due] of [['pay rent 15000 fri', '2026-11-20'], ['electricity bill 1840 due fri', '2026-11-20'], ['school fees 40000 due monday', '2026-11-16'], ['buy gift 500 sat', '2026-11-21']]) {
    const r = one(text);
    assert.deepEqual([r.type, r.data.dueDate], ['task', due], `${text} is still to do`);
  }
  assert.deepEqual([one('paid rent 15000 fri').type, one('paid rent 15000 fri').data.date], ['transaction', '2026-11-13']);
  assert.equal(one('uber 230 sat').data.date, '2026-11-14');
  assert.deepEqual([one('paid school fees 40000 monday').type, one('paid school fees 40000 monday').data.date], ['transaction', '2026-11-09']);

  // 2. Later parts without a verb of their own keep the sentence's direction.
  assert.deepEqual(summary('got 500 from dad and 300 from mom').map((x) => [x[1], x[2]]), [['credit', 500], ['credit', 300]]);
  assert.deepEqual(summary('received 500 from raj and 300 from amit').map((x) => [x[1], x[2]]), [['credit', 500], ['credit', 300]]);
  assert.deepEqual(summary('paid maid salary 8000 and driver salary 10000').map((x) => [x[1], x[2]]), [['debit', 8000], ['debit', 10000]]);
  assert.deepEqual(summary('got 500 from dad and paid 300 to mom').map((x) => x[1]), ['credit', 'debit'], 'a part with its own verb keeps it');
  assert.deepEqual(summary('chai 40 and samosa 20').map((x) => x[1]), ['debit', 'debit']);

  // 3. A count after the comma is a quantity, not a second payment; real second payments still split.
  for (const [text, amount] of [['paid 500 for lunch, 2 people', 500], ['spent 1200 at dmart, 3 bags', 1200], ['500 lunch, 2 beers', 500]]) {
    assert.deepEqual(all(text).map((x) => x.data.amount), [amount], `${text} is one payment`);
  }
  assert.deepEqual(all('40 chai and 20 samosa').map((x) => x.data.amount), [40, 20]);
  assert.deepEqual(all('paid 500 to ravi and 300 to amit').map((x) => x.data.amount), [500, 300]);
  assert.deepEqual(all('chai 40, samosa 20 upi').map((x) => [x.data.amount, x.data.paymentMode]), [[40, 'upi'], [20, 'upi']]);
  assert.deepEqual(all('bread and butter 60').map((x) => x.data.amount), [60]);

  // 6. A bank named in the text is that payment's account; the usual-bank guess only fills a gap.
  for (const [text, bank, mode, description] of [['petrol 2000 hdfc card', 'hdfc', 'card', 'Petrol'], ['petrol 2000 icici upi', 'icici', 'upi', 'Petrol'],
    ['amazon 1299 axis credit card', 'axis', 'card', 'Amazon'], ['lunch 300 pnb upi', 'pnb', 'upi', 'Lunch'], ['dinner 900 yes bank card', 'yes', 'card', 'Dinner']]) {
    const r = one(text);
    assert.deepEqual([r.data.account, r.data.paymentMode, r.data.description], [bank, mode, description], text);
  }
  assert.equal(one('petrol 2000 upi').data.account, 'kotak', 'no bank named: the guess applies');
  assert.equal(one('petrol 2000 sbi upi').data.account, 'sbi');
  assert.deepEqual([one('yes 40 chai').type, one('yes 40 chai').data.account], ['transaction', undefined], '"yes" alone is just a word');
  assert.equal(one('birthday card 100').data.paymentMode, undefined, 'still not a card payment');
  assert.equal(one('chai 40 and samosa 20 hdfc upi').data.account, 'hdfc');

  // 7. mon/tue/thu/fri are always days; only sun/sat/wed can be ordinary words.
  for (const [text, date, description] of [['tue lunch 200', '2026-11-10', 'Lunch'], ['fri dinner 900 card', '2026-11-13', 'Dinner'], ['dinner fri 900', '2026-11-13', 'Dinner'], ['uber 230 sat night', '2026-11-14', 'Uber']]) {
    const r = one(text);
    assert.deepEqual([r.type, r.data.date, r.data.description], ['transaction', date, description], text);
  }
  assert.equal(one('sun lotion 300').data.date, TODAY); assert.equal(one('sat mat 500').data.date, TODAY);
  assert.equal(one('sun lotion 300').data.description, 'Sun lotion');

  // 8. More ways to say a past day; and a bare habit name naming a past day is a check-in.
  assert.equal(one('paid 500 on 10 sep').data.date, '2026-09-10');
  assert.equal(one('lunch 300 on 14th').data.date, '2026-11-14');
  assert.deepEqual([one('chai 40 day before yesterday').data.date, one('chai 40 day before yesterday').data.description], ['2026-11-13', 'Chai']);
  assert.deepEqual([one('dinner 800 last night').data.date, one('dinner 800 last night').data.description], ['2026-11-14', 'Dinner']);
  assert.deepEqual([one('gym yesterday').type, one('gym yesterday').data.date], ['habit', '2026-11-14']);
  assert.equal(one('gym tomorrow').type, 'task'); assert.equal(one('gym today 6pm').type, 'task');
  assert.deepEqual([one('submit report on 14th').type, one('submit report on 14th').data.dueDate], ['task', '2026-12-14'], 'a to-do on "14th" still looks ahead');

  // 4. A bare amount claims a bank row without changing it; a later description of the same payment still
  // lands on that row (no duplicate), and each undo leaves the bank's record in place.
  const plain = bankRow({ amount: 560, description: 'UPI/DR/21/P' });
  const bare = capture.commit(a, { text: 'paid 560 upi' }, opts).data;
  assert.equal(bare.created[0].id, plain); assert.deepEqual(bare.created[0].applied, {});
  const lunch = capture.commit(a, { text: 'lunch 560 upi' }, opts).data;
  assert.equal(lunch.created[0].id, plain, 'the claimed row is still the bank payment, so no second row');
  assert.equal(count(56000), 1);
  assert.equal(row(plain).notes, 'Lunch');
  assert.deepEqual(capture.undo(a, lunch.capture._id, opts).data.kept, []);
  assert.deepEqual([row(plain).notes, row(plain).category_id, row(plain).deleted_at], [null, null, null]);
  assert.deepEqual(capture.undo(a, bare.capture._id, opts).data.kept, []);
  assert.deepEqual([count(56000), row(plain).source], [1, 'sms'], 'the bank row survives both undos');
  // An untouched row wins over one an earlier capture already claimed.
  const claimed = bankRow({ amount: 561, description: 'UPI/DR/22/Q' });
  const first = capture.commit(a, { text: 'paid 561 upi' }, opts).data;
  assert.equal(first.created[0].id, claimed);
  const fresh = bankRow({ amount: 561, description: 'UPI/DR/23/R' });
  const second = capture.commit(a, { text: 'lunch 561 upi' }, opts).data;
  assert.equal(second.created[0].id, fresh, 'the unclaimed row is preferred');
  assert.deepEqual([count(56100), row(fresh).notes, row(claimed).notes], [2, 'Lunch', null]);
  capture.undo(a, second.capture._id, opts); capture.undo(a, first.capture._id, opts);
  assert.deepEqual([row(fresh).notes, row(claimed).deleted_at, row(fresh).deleted_at], [null, null, null]);
  // A merged-by-SMS row (the person's description is final) is never annotated again.
  const typedRow = capture.commit(a, { text: 'coffee 562 upi' }, opts).data.created[0].id;
  const { mergeIntoCaptured: merge } = require('../src/plugins/sms/sms.reconcile');
  merge(db, a, row(typedRow), { type: 'debit', amount: 562, date: TODAY, account: 'sbi', refNo: '123456789562', paymentMode: 'upi' });
  assert.equal(row(typedRow).description_kept, 1);
  assert.notEqual(capture.commit(a, { text: 'coffee 562 upi' }, opts).data.created[0].id, typedRow);
  assert.equal(count(56200), 2);

  // 5. Identical bank rows (a daily chai) pair with identical captures one-to-one, earliest first.
  const twin1 = bankRow({ amount: 21, description: 'UPI/DR/24/S' }); const twin2 = bankRow({ amount: 21, description: 'UPI/DR/25/S' });
  const c1 = capture.commit(a, { text: 'chai 21 upi' }, opts).data.created[0];
  const c2 = capture.commit(a, { text: 'chai 21 upi' }, opts).data.created[0];
  assert.deepEqual([c1.id, c2.id], [twin1, twin2], 'each capture takes its own bank row, earliest first');
  assert.equal(count(2100), 2, 'two payments, two rows');
  // One save with two identical payments claims two different rows.
  const t1 = bankRow({ amount: 22, description: 'UPI/DR/26/T' }); const t2 = bankRow({ amount: 22, description: 'UPI/DR/27/T' });
  const both = capture.commit(a, { text: 'chai 22 upi and tea 22 upi' }, opts).data.created;
  assert.deepEqual(both.map((x) => x.id), [t1, t2]);
  // A different day or account is still ambiguous, never a coin flip.
  bankRow({ amount: 23, account: 'sbi', description: 'UPI/DR/28/U' }); bankRow({ amount: 23, account: 'kotak', description: 'UPI/DR/29/U' });
  assert.ok(!capture.commit(a, { text: 'chai 23' }, opts).data.created[0].matched);

  // 10. Undoing a repeat check-in for a day that has left the grace window reports it as kept instead of failing.
  const water = ctx.habits.find((h) => h.name === 'Drink water');
  const slot = capture.commit(a, { text: 'water 3 glasses' }, opts).data;
  const repeat = capture.commit(a, { text: 'water 8 glasses' }, opts).data;
  assert.equal(repeat.created[0].already, true);
  const later = { now: new Date('2026-11-18T12:00:00+05:30') };
  assert.throws(() => run(a, (c) => habitService.restoreQuantity(c, water.id, TODAY, 3), later), (err) => err.code === 'OUTSIDE_GRACE', 'the service itself refuses an old day');
  const undone = capture.undo(a, repeat.capture._id, later).data;
  assert.deepEqual(undone.kept.map((k) => k.id), [water.id], 'reported as kept');
  assert.equal(db.prepare('SELECT quantity FROM habit_checkins WHERE habit_id = ? AND date = ?').pluck().get(water.id, TODAY), 8, 'the old day is left alone');
  assert.equal(db.prepare("SELECT status FROM captures WHERE id = ?").pluck().get(repeat.capture._id), 'undone');
  capture.undo(a, slot.capture._id, opts); // in the window again: removes the check-in and its XP
  assert.equal(db.prepare('SELECT count(*) FROM habit_checkins WHERE habit_id = ?').pluck().get(water.id), 0);
  assert.ok(lastCapture());
}

// The final review's findings: a described bank row is never re-used by a different payment, a similar-sized
// second payment still splits, only verbs set a split sentence's direction, future intent vs past verbs, and
// company names that start with a bank's name.
async function finalReview() {
  const ctx = { ...capture.contextFor(db, a, now), bankAccount: 'kotak' };
  const all = (text) => parser.parse(text, ctx).actions;
  const one = (text) => all(text)[0];
  const count = (paise) => db.prepare('SELECT count(*) FROM active_transactions WHERE user_id = ? AND amount_paise = ?').pluck().get(a, paise);
  const bankRow = (amount, payee) => insertTransaction(db, a, { date: TODAY, description: `UPI/DR/223344556677/${payee}`, amount, source: 'sms', account: 'sbi', paymentMode: 'upi' });

  // Raj's payment is described by its capture; "petrol 507 upi" typed before its own SMS is a new payment.
  const raj = bankRow(507, 'RAJ KUMAR');
  capture.commit(a, { text: 'raj 507 upi' }, opts);
  assert.equal(db.prepare('SELECT notes FROM transactions WHERE id = ?').pluck().get(raj), 'Raj');
  capture.commit(a, { text: 'petrol 507 upi' }, opts);
  assert.equal(count(50700), 2, 'petrol is its own row, not filed onto Raj’s');
  assert.equal(db.prepare('SELECT category_id FROM transactions WHERE id = ?').pluck().get(raj), null, 'Raj’s row did not get Fuel');

  // Two bare amounts against one bank row: the second is a second payment, recorded somewhere.
  bankRow(563, 'STALL');
  capture.commit(a, { text: 'paid 563 upi' }, opts);
  capture.commit(a, { text: 'paid 563 upi' }, opts);
  assert.equal(count(56300), 2);

  // Similar-sized second payments still split; small counts stay quantities.
  assert.deepEqual(all('paid 200 auto and 300 lunch').map((x) => x.data.amount), [200, 300]);
  assert.deepEqual(all('paid 500 for lunch, 200 tip').map((x) => x.data.amount), [500, 200]);
  assert.deepEqual(all('paid 5000 for dinner, 12 people').map((x) => x.data.amount), [5000]);
  assert.deepEqual(all('500 dinner, 10 tip').map((x) => x.data.amount), [500, 10], '₹10 is a real amount');
  assert.deepEqual(all('500 dinner, 2 beers').map((x) => x.data.amount), [500]);

  // Nouns don't set a split sentence's direction; verbs do.
  assert.deepEqual(all('refund 200 and chai 40').map((x) => x.data.direction), ['credit', 'debit']);
  assert.deepEqual(all('cashback 50 and recharge 299').map((x) => x.data.direction), ['credit', 'debit']);
  assert.deepEqual(all('got refund 200 and cashback 30').map((x) => x.data.direction), ['credit', 'credit']);

  // Future intent vs past verbs.
  for (const text of ['to pay 500 fri', 'will pay rent 15000 fri', 'must pay 500 fri', 'need to buy gift 800 sat']) {
    assert.equal(one(text).type, 'task', `${text} is still to do`);
  }
  for (const text of ['paid electricity due 1840 fri', 'paid due amount 500 fri']) {
    assert.deepEqual([one(text).type, one(text).data.date], ['transaction', '2026-11-13'], `${text} already happened`);
  }
  assert.equal(one('pay rent 15000 fri').type, 'task', 'still a task');

  // A company named after a bank is not the paying account.
  assert.notEqual(one('hdfc life premium 15000').data.account, 'hdfc');
  assert.match(one('hdfc life premium 15000').data.description, /hdfc life/i);
  assert.notEqual(one('icici lombard insurance 9000').data.account, 'icici');
  assert.equal(one('petrol 2000 hdfc card').data.account, 'hdfc', 'a plain bank name still counts');
}

async function inboxAndSearch() {
  const saved = capture.commit(a, { text: 'idea: weekend trip to Coorg' }, opts).data;
  assert.equal(saved.capture, null); assert.equal(saved.inbox.length, 1);
  const id = saved.inbox[0]._id;
  assert.deepEqual(capture.listInbox(a).items.map((i) => i.text), ['idea: weekend trip to Coorg']);
  assert.equal(capture.listInbox(b).total, 0, 'inbox is per account');

  // Re-reading an inbox note into a task resolves it; it can't be resolved twice.
  const resolved = capture.commit(a, { text: 'plan Coorg trip next week', inboxId: id }, opts).data;
  assert.equal(resolved.capture._id, id); assert.equal(resolved.capture.status, 'done');
  assert.equal(capture.listInbox(a).total, 0);
  assert.throws(() => capture.commit(a, { text: 'again', inboxId: id }, opts), /already sorted/);
  assert.throws(() => capture.commit(b, { text: 'steal', inboxId: id }, opts), /not found/);

  const other = capture.commit(a, { text: 'something vague' }, opts).data.inbox[0];
  assert.throws(() => capture.dismiss(b, other._id), /not found/);
  assert.equal(capture.dismiss(a, other._id).status, 'dismissed');

  // Search across modules, scoped to the account; a number matches an exact amount; % is literal.
  capture.commit(a, { text: 'swiggy biryani 450' }, opts);
  capture.commit(b, { text: 'swiggy pizza 999' }, opts);
  const found = capture.search(a, 'swiggy');
  assert.deepEqual(found.map((r) => r.kind), ['transaction']); assert.equal(found[0].amount, 450);
  assert.equal(capture.search(a, '450')[0].title, 'Swiggy biryani');
  assert.ok(capture.search(a, 'coorg').some((r) => r.kind === 'task'));
  assert.ok(capture.search(a, 'gym').some((r) => r.kind === 'habit'));
  assert.deepEqual(capture.search(a, '100%'), []);
}

async function aiCases() {
  const ctx = capture.contextFor(db, a, now);
  aiAnswer = { actions: [
    { type: 'transaction', description: 'Lent Arjun for trip', amount: 500, direction: 'debit', date: '2030-01-01', time: null, habit: null, quantity: null, category: 'Lent to Someone' },
    { type: 'habit', description: '', amount: null, direction: null, date: null, time: null, habit: 'Made up habit', quantity: null, category: null },
    { type: 'task', description: 'Ask Arjun to pay back', amount: null, direction: null, date: '2026-12-15', time: '25:99', habit: null, quantity: null, category: null },
  ] };
  const r = await capture.preview(a, 'lent arjun 500 for the trip, ask him to pay back mid dec', { useAi: true, now });
  assert.equal(r.engine, 'ai');
  assert.equal(r.actions[0].data.date, TODAY, 'a future payment date falls back to today');
  assert.equal(r.actions[0].data.categoryName, 'Lent to Someone');
  assert.equal(r.actions[1].type, 'note', 'an invented habit becomes a note, never a check-in');
  assert.deepEqual([r.actions[2].data.dueDate, r.actions[2].data.dueTime], ['2026-12-15', null], 'a bad time is dropped');
  assert.equal(toAction({ type: 'transaction', description: 'x', amount: -5 }, { ...ctx, original: 'orig' }).type, 'note');
  aiAnswer = { actions: [] };
  await assert.rejects(capture.preview(a, 'anything', { useAi: true, now }), /couldn’t read/);
}

async function categoryHelp() {
  const cats = db.prepare('SELECT id, name, type FROM categories WHERE user_id = ? AND deleted_at IS NULL').all(a);
  const food = cats.find((c) => c.type !== 'income' && /food|dining/i.test(c.name)) || cats.find((c) => c.type !== 'income');
  const income = cats.find((c) => c.type === 'income');
  const useCloud = (on) => db.prepare('UPDATE users SET ai_settings = ? WHERE id = ?').run(on ? JSON.stringify({ mode: 'api', provider: 'groq', keys: { groq: 'gsk_test' } }) : null, a);
  const rulesOnly = await capture.preview(a, 'California burrito 200', { now });
  assert.equal(rulesOnly.actions[0].data.category, undefined, 'precondition: the rules have no word for burrito');

  // Local model (the default): no model call at all, the rules' answer comes back as it is.
  lastAiRequest = null;
  aiAnswer = { items: [{ index: 0, category: food.name }] };
  let r = await capture.categorise(a, 'California burrito 200', { now });
  assert.equal(lastAiRequest, null, 'a person without a cloud model never triggers a call');
  assert.equal(r.actions[0].data.category, undefined);
  assert.equal(r.aiCategories, 0);

  // Cloud model chosen: the category is filled, and nothing else about the payment changes.
  useCloud(true);
  r = await capture.categorise(a, 'California burrito 200', { now });
  assert.equal(r.actions[0].data.category, food.id);
  assert.equal(r.actions[0].data.categoryName, food.name);
  assert.equal(r.actions[0].aiCategory, true, 'the palette can say the category came from the AI');
  assert.equal(r.aiCategories, 1);
  assert.deepEqual({ ...r.actions[0].data, category: undefined, categoryName: undefined }, { ...rulesOnly.actions[0].data, category: undefined, categoryName: undefined }, 'amount, date, account and description are the rules\' own');
  assert.doesNotMatch(lastAiRequest.prompt, /200|upi|20\d\d-/i, 'only the description and the category names are sent');
  assert.match(lastAiRequest.prompt, /California burrito/);
  assert.equal(lastAiRequest.webSearch, false);

  // The rules' category always wins; no uncategorised payment means no call at all.
  lastAiRequest = null;
  r = await capture.categorise(a, 'swiggy 300', { now });
  assert.equal(lastAiRequest, null);
  assert.equal(r.actions[0].aiCategory, undefined);
  r = await capture.categorise(a, 'remind me to call mom', { now });
  assert.equal(lastAiRequest, null, 'tasks never go to the model');

  // Several payments: only the uncategorised ones are asked about, and answers land on the right row.
  r = await capture.categorise(a, 'swiggy 300; california burrito 200', { now });
  assert.equal(r.actions[0].aiCategory, undefined);
  assert.equal(r.actions[1].data.category, food.id);
  assert.equal(JSON.parse(lastAiRequest.prompt).payments.length, 1);

  // A bad answer is ignored: an invented name, a wrong-side category, a bad index, null, or junk.
  for (const answer of [
    { items: [{ index: 0, category: 'Made Up Category' }] },
    { items: [{ index: 0, category: income.name }] },
    { items: [{ index: 7, category: food.name }] },
    { items: [{ index: 0, category: null }] },
    { items: 'nope' },
    {},
  ]) {
    aiAnswer = answer;
    r = await capture.categorise(a, 'California burrito 200', { now });
    assert.equal(r.actions[0].data.category, undefined, JSON.stringify(answer));
    assert.equal(r.actions[0].type, 'transaction', 'the payment itself is still previewed');
  }

  // A model that is down, a rate limit, or the prompt guard blocking it never fails the preview.
  aiAnswer = new Error('boom');
  r = await capture.categorise(a, 'California burrito 200', { now });
  assert.equal(r.actions[0].data.amount, 200);
  aiAnswer = { items: [{ index: 0, category: food.name }] };
  r = await capture.categorise(a, 'California burrito 200', { now, limiter: async () => { throw new Error('Too many attempts'); } });
  assert.equal(r.actions[0].data.category, undefined, 'rate-limited: rules only');

  // Saving the suggestion works like any category, and shows up in Sort out as automatic.
  aiAnswer = { items: [{ index: 0, category: food.name }] };
  r = await capture.categorise(a, 'California burrito 200', { now });
  const saved = capture.commit(a, { text: 'California burrito 200', actions: r.actions.map(({ type, data }) => ({ type, data })), engine: 'ai' }, opts);
  const row = db.prepare('SELECT category_id, auto_categorized FROM transactions WHERE capture_id = ?').get(saved.data.capture._id);
  assert.deepEqual({ ...row }, { category_id: food.id, auto_categorized: 1 });
  useCloud(false);
  assert.equal(schemas.categorise.safeParse({ body: { text: 'x' } }).success, true);
  assert.equal(schemas.categorise.safeParse({ body: { text: 'x', ai: true } }).success, false, 'unknown fields are refused');
}

function validation() {
  const ok = (body) => schemas.commit.safeParse({ body }).success;
  assert.equal(ok({ text: 'chai 40' }), true);
  assert.equal(ok({ text: '' }), false);
  assert.equal(ok({ text: 'x', actions: [{ type: 'transaction', data: { date: TODAY, description: 'x', amount: -1, direction: 'debit' } }] }), false);
  assert.equal(ok({ text: 'x', actions: [{ type: 'task', data: { title: 'x', userId: 'smuggled' } }] }), false, 'unknown fields are refused');
  assert.equal(ok({ text: 'x', actions: [{ type: 'delete_everything', data: {} }] }), false);
  assert.equal(ok({ text: 'x', actions: Array(11).fill({ type: 'note', data: { text: 'x' } }) }), false);
  assert.equal(schemas.search.safeParse({ query: { q: 'a' } }).success, false, 'search needs two characters');
}

async function notifications() {
  const prefs = { ...DEFAULT_PREFERENCES };
  const evening = new Date(`${TODAY}T20:00:00+05:30`);
  const kinds = async (p, when = evening) => (await remindersFor(db, a, p, DEFAULT_SETTINGS, when)).filter((m) => m.kind === 'captures');
  assert.deepEqual(await kinds(prefs), [], 'an empty inbox sends nothing');
  capture.commit(a, { text: 'look into term insurance options' }, opts);
  capture.commit(a, { text: 'birthday gift ideas for priya' }, opts);
  const [msg] = await kinds(prefs);
  assert.deepEqual(msg.detail, { count: 2, first: 'look into term insurance options' });
  assert.equal(msg.key, `captures:${TODAY}`, 'once a day');
  assert.equal((await kinds({ ...prefs, details: false }))[0].detail, undefined, 'no text when details are off');
  assert.deepEqual(await kinds({ ...prefs, captures: false }), []);
  const { captures, ...older } = prefs;
  assert.equal((await kinds(older)).length, 1, 'devices saved before this option get it by default');
  assert.deepEqual(await kinds(prefs, new Date(`${TODAY}T08:00:00+05:30`)), [], 'not before the daily reminder time');
  assert.equal((await remindersFor(db, b, prefs, DEFAULT_SETTINGS, evening)).some((m) => m.kind === 'captures'), false, 'per account');

  // A financial reset archives the capture log too (it holds amounts and payees).
  await userService.resetFinancialData(a);
  assert.equal(capture.listInbox(a).total, 0);
}

(async () => {
  await parserCases();
  await habitsAndCommit();
  await parserFixes();
  await accountGuess();
  await bankRowMatching();
  await capturedRowsAndSms();
  await habitDates();
  await inboxAndSearch();
  await reviewFixes();
  await passThree();
  await finalReview();
  await idempotency();
  await aiCases();
  await categoryHelp();
  validation();
  await notifications();
  console.log('capture tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
