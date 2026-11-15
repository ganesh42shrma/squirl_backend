// Quick Capture: type one line anywhere in Squirl, and it becomes a ledger row, a task, a habit
// check-in, or a note in the capture inbox.
//
//   preview  → reads the text (rules, or the AI when asked) and proposes actions. Saves nothing.
//   commit   → saves the confirmed actions through the owning modules' own code, in ONE database
//              transaction: a ledger row via the transactions model, a task via task.service, a
//              check-in via habit.service (so XP, streaks and the Daily Quest behave exactly as if
//              the person had used those pages). Every capture is logged in `captures`.
//   undo     → reverses what a capture created (a toast offers this right after saving).
//
// Two guards keep the ledger honest. A payment typed here that the bank's SMS/statement already
// recorded annotates that row instead of adding a twin (and the reverse is handled by the SMS code, which
// finds rows by `transactions.capture_id`). And every save carries the palette's `clientId`, so a retry
// after a dropped connection returns the first result instead of saving twice.
//   inbox    → notes the person hasn't sorted yet; a daily push reminds them (see reminders.js).
//   search   → the command palette's "find anything" across ledger, tasks, habits, goals, bills.
const { getDb } = require('../../config/db');
const { createHash } = require('node:crypto');
const AppError = require('../../core/AppError');
const { newId, nowIso, toPaise, fromPaise } = require('../../core/sql');
const { insertTransaction } = require('../transactions/transaction.model');
const { run } = require('../tasks/context');
const { addDays } = require('../tasks/day');
const { readSettings, clockFor } = require('../tasks/settings');
const tasks = require('../tasks/task.service');
const habits = require('../tasks/habit.service');
const { isDayBased, isScheduled } = require('../tasks/streak.engine');
const { narrow } = require('../sms/sms.reconcile');
const { DEFAULT_DESCRIPTIONS } = require('./capture.parser');
const parser = require('./capture.parser');
const ai = require('./capture.ai');

const INBOX_LIMIT = 50;
const BANK_ACCOUNT_DAYS = 90; // how far back "the bank you usually use" looks
const BANK_MATCH_DAYS = 1; // a captured payment and its bank record can differ by a day

/**
 * The bank a UPI/card payment most likely came from when the text names none: the person's only registered
 * SMS account, else the non-cash account their bank rows (SMS/statements) used most in the last ~90 days.
 */
function usualBank(db, userId, today) {
  const registered = db.prepare('SELECT bank FROM sms_accounts WHERE user_id = ? AND deleted_at IS NULL').pluck().all(userId);
  if (registered.length === 1) return registered[0];
  return db.prepare(`SELECT account FROM active_transactions WHERE user_id = ? AND source IN ('sms', 'import')
    AND account != 'cash' AND date >= ? GROUP BY account ORDER BY count(*) DESC, max(date) DESC LIMIT 1`)
    .pluck().get(userId, addDays(today, -BANK_ACCOUNT_DAYS));
}

/** What the parser needs to know about this person: their day, habits, categories and usual bank. */
function contextFor(db, userId, now) {
  const { today } = clockFor(readSettings(db, userId), now);
  const habitRows = db.prepare('SELECT * FROM active_habits WHERE user_id = ? AND archived_at IS NULL ORDER BY position, rowid').all(userId);
  const categoryRows = db.prepare('SELECT id, name, type, parent_id FROM active_categories WHERE user_id = ?').all(userId);
  // The oldest day the habit service still accepts, so the parser never proposes a check-in that would fail the save.
  const checkinFrom = addDays(today, -habits.GRACE_DAYS);
  const days = [...new Set([checkinFrom, today])];
  return {
    today,
    checkinFrom,
    bankAccount: usualBank(db, userId, today) || undefined,
    habits: habitRows.map((h) => ({
      id: h.id, name: h.name, unit: h.unit, targetQuantity: h.target_quantity, startDate: h.start_date,
      unscheduled: days.filter((day) => isDayBased(h) && !isScheduled(h, day)),
    })),
    categories: categoryRows.map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parent_id })),
  };
}

const toCapture = (row) => ({
  _id: row.id,
  text: row.text,
  status: row.status,
  engine: row.engine,
  created: row.result ? JSON.parse(row.result) : [],
  createdAt: row.created_at,
  resolvedAt: row.resolved_at ?? undefined,
});

/**
 * A bank (SMS or statement) row that this captured payment is almost certainly the same as: same direction
 * and amount, a day either side, and the person hasn't said anything about it yet (no note, or no category).
 * Exactly one qualifies, or none does. Cash never matches (the bank has no record of cash). The account is
 * NOT required to match (the capture may have guessed it). With several candidates the one on the same day
 * wins, then the one in the named account; only then is it ambiguous. `claimed` holds rows an earlier action
 * of the same save already used.
 */
function findBankPayment(db, userId, data, claimed = new Set()) {
  if (String(data.paymentMode || '').toLowerCase() === 'cash') return null;
  const rows = db.prepare(`SELECT * FROM active_transactions WHERE user_id = ? AND source IN ('sms', 'import') AND capture_id IS NULL
    AND transfer_id IS NULL AND type = ? AND amount_paise = ?
    AND date BETWEEN date(?, '-${BANK_MATCH_DAYS} day') AND date(?, '+${BANK_MATCH_DAYS} day')
    AND (COALESCE(notes, '') = '' OR category_id IS NULL)`)
    .all(userId, data.direction, toPaise(data.amount), data.date, data.date).filter((r) => !claimed.has(r.id));
  const left = narrow(rows, [(r) => r.date === data.date, (r) => Boolean(data.account) && r.account === data.account.toLowerCase()]);
  return left.length === 1 ? left[0] : null;
}

/** Adds `match` (display only; commit looks again) to payments that will be merged into a bank row. */
function withBankMatches(db, userId, actions) {
  const claimed = new Set();
  return actions.map((action) => {
    if (action.type !== 'transaction') return action;
    const row = findBankPayment(db, userId, action.data, claimed);
    if (!row) return action;
    claimed.add(row.id);
    return { ...action, match: { description: row.description.slice(0, 80), date: row.date, account: row.account } };
  });
}

async function preview(userId, text, { useAi = false, now } = {}) {
  const db = getDb();
  const ctx = contextFor(db, userId, now);
  const result = useAi ? { ...(await ai.parseWithAi(userId, text, ctx)), engine: 'ai' } : { ...parser.parse(text, ctx), engine: 'rules' };
  return { ...result, actions: withBankMatches(db, userId, result.actions), today: ctx.today };
}

// Ownership checks: a category or habit id from the client must belong to this account.
function assertCategory(db, userId, id) {
  if (id && !db.prepare('SELECT 1 FROM active_categories WHERE id = ? AND user_id = ?').get(id, userId)) {
    throw AppError.badRequest('Category not found', 'INVALID_CATEGORY');
  }
}

// What a save was for, so a client id re-used with different text is noticed (see replayOf).
const requestHash = (text, inboxId) => createHash('sha256').update(`${String(text).replace(/\s+/g, ' ').trim()}|${inboxId || ''}`).digest('hex').slice(0, 32);

function insertCapture(db, userId, { id = newId(), text, status, engine, created = [], clientId = null, hash = null }) {
  const now = nowIso();
  db.prepare(`INSERT INTO captures (id, user_id, text, status, engine, result, client_id, request_hash, created_at, updated_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, text, status, engine, JSON.stringify(created), clientId, hash, now, now, status === 'inbox' ? null : now);
  return toCapture(db.prepare('SELECT * FROM captures WHERE id = ?').get(id));
}

/**
 * What a retried save returns: the first attempt's rows, found by the palette's key. The capture row holds
 * the key itself; each inbox note holds "key#0", "key#1"… ('#' and '$' bracket that range without LIKE).
 * The same key with different text is a client bug, not a retry: refuse it rather than lose the new text.
 */
function replayOf(db, userId, clientId, hash) {
  const rows = db.prepare(`SELECT * FROM captures WHERE user_id = ? AND (client_id = ? OR (client_id > ? AND client_id < ?))
    ORDER BY created_at, rowid`).all(userId, clientId, `${clientId}#`, `${clientId}$`);
  if (!rows.length) return null;
  if (rows.some((r) => r.request_hash && r.request_hash !== hash)) {
    throw AppError.conflict('That save id was already used for different text. Please try again.', 'CAPTURE_CLIENT_ID_REUSED');
  }
  const main = rows.find((r) => r.client_id === clientId);
  const capture = main ? toCapture(main) : null;
  return { capture, inbox: rows.filter((r) => r !== main).map(toCapture), created: capture?.created ?? [], replayed: true };
}

function findCapture(db, userId, id) {
  const row = db.prepare('SELECT * FROM captures WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, userId);
  if (!row) throw AppError.notFound('Capture not found');
  return row;
}

/**
 * A captured payment the bank already recorded: fill in what the person hasn't (a category when there is
 * none, their words as the note) and mark the row as described. The bank's own date, amount, account and
 * wording are never touched. What changed is returned so undo can put it back.
 */
function annotateBankPayment(db, userId, row, data, captureId) {
  const now = nowIso();
  const prior = {};
  const applied = {};
  if (data.category && !row.category_id) {
    Object.assign(prior, { category_id: row.category_id, auto_categorized: row.auto_categorized });
    Object.assign(applied, { category_id: data.category, auto_categorized: data.autoCategorized === false ? 0 : 1 });
  }
  if (!row.notes && data.description !== DEFAULT_DESCRIPTIONS[data.direction]) {
    prior.notes = row.notes;
    applied.notes = data.description;
  }
  db.prepare(`UPDATE transactions SET category_id = COALESCE(@category_id, category_id), auto_categorized = COALESCE(@auto_categorized, auto_categorized),
    notes = COALESCE(@notes, notes), capture_id = @captureId, updated_at = @now WHERE id = @id AND user_id = @userId`)
    .run({ category_id: applied.category_id ?? null, auto_categorized: applied.auto_categorized ?? null, notes: applied.notes ?? null, captureId, now, id: row.id, userId });
  return { type: 'transaction', id: row.id, label: data.description, amount: data.amount, direction: data.direction, matched: true, prior, applied };
}

/** Saves one confirmed action inside the shared transaction; returns what it created, if anything. */
function apply(ctx, action, { captureId, claimed }) {
  const { db, userId } = ctx;
  const { data } = action;
  if (action.type === 'transaction') {
    assertCategory(db, userId, data.category);
    const bankRow = findBankPayment(db, userId, data, claimed);
    if (bankRow) {
      claimed.add(bankRow.id);
      return annotateBankPayment(db, userId, bankRow, data, captureId);
    }
    const id = insertTransaction(db, userId, {
      date: data.date,
      description: data.description,
      amount: data.amount,
      type: data.direction,
      category: data.category || null,
      account: data.account,
      paymentMode: data.paymentMode,
      source: 'manual',
      captureId, // lets a later bank SMS recognise this row as the same payment
      // A guessed category shows up in Sort out as "automatic" until the person confirms it.
      autoCategorized: Boolean(data.category && data.autoCategorized !== false),
    });
    return { type: 'transaction', id, label: data.description, amount: data.amount, direction: data.direction };
  }
  if (action.type === 'task') {
    const task = tasks.createTask(ctx, { title: data.title, dueDate: data.dueDate ?? null, dueTime: data.dueTime ?? null });
    return { type: 'task', id: task._id, label: task.title, dueDate: data.dueDate ?? null, dueTime: data.dueTime ?? null };
  }
  if (action.type === 'habit') {
    const day = data.date || ctx.clock.today;
    // A day that was already checked in is only re-saved, so undo must not delete the earlier check-in.
    const before = db.prepare("SELECT quantity FROM habit_checkins WHERE habit_id = ? AND user_id = ? AND date = ? AND kind = 'done'").get(data.habitId, userId, day);
    const habit = habits.checkIn(ctx, data.habitId, { date: data.date, quantity: data.quantity });
    return { type: 'habit', id: data.habitId, label: habit.name, date: day, ...(before && { already: true, previousQuantity: before.quantity }) };
  }
  return null; // notes create nothing; they wait in the inbox
}

/**
 * Saves a capture. `actions` are the ones the palette previewed (validated by capture.validation);
 * without them the rules read `text` here. `inboxId` resolves an inbox note the person re-read.
 * Returns { capture, inbox, created } and the XP/streak `events` the Tasks code produced.
 */
function commit(userId, { text, actions, inboxId, engine = 'rules', clientId }, { now } = {}) {
  const db = getDb();
  // A retry of a save that already went through returns that save (synchronous code: nothing can slip in between).
  const hash = clientId ? requestHash(text, inboxId) : null;
  const replay = clientId && replayOf(db, userId, clientId, hash);
  if (replay) return { data: replay, events: [] };
  const proposed = actions || parser.parse(text, contextFor(db, userId, now)).actions;
  if (!proposed.length) throw AppError.badRequest('Nothing to capture', 'CAPTURE_EMPTY');
  return run(userId, (ctx) => {
    const source = inboxId ? findCapture(db, userId, inboxId) : null;
    if (source && source.status !== 'inbox') throw AppError.conflict('That inbox item was already sorted', 'CAPTURE_RESOLVED');

    // The id exists before the actions run so ledger rows can carry it (see transactions.capture_id).
    const captureId = source ? source.id : newId();
    const claimed = new Set();
    const created = proposed.map((action) => apply(ctx, action, { captureId, claimed })).filter(Boolean);
    const notes = proposed.filter((a) => a.type === 'note');
    let capture = null;
    const inbox = [];

    if (created.length) {
      if (source) {
        const stamp = nowIso();
        db.prepare("UPDATE captures SET status = 'done', text = ?, engine = ?, result = ?, client_id = ?, request_hash = ?, updated_at = ?, resolved_at = ? WHERE id = ?")
          .run(text, engine, JSON.stringify(created), clientId ?? null, hash, stamp, stamp, source.id);
        capture = toCapture(db.prepare('SELECT * FROM captures WHERE id = ?').get(source.id));
      } else {
        capture = insertCapture(db, userId, { id: captureId, text, status: 'done', engine, created, clientId, hash });
      }
    }
    // Each unread part becomes its own inbox note. Re-saving an inbox item as a note keeps that item.
    notes.forEach((note, i) => {
      const noteKey = clientId ? `${clientId}#${i}` : null;
      if (source && !created.length && i === 0) {
        db.prepare('UPDATE captures SET text = ?, client_id = ?, request_hash = ?, updated_at = ? WHERE id = ?').run(note.data.text, noteKey, hash, nowIso(), source.id);
        inbox.push(toCapture(db.prepare('SELECT * FROM captures WHERE id = ?').get(source.id)));
      } else {
        inbox.push(insertCapture(db, userId, { text: note.data.text, status: 'inbox', engine, clientId: noteKey, hash }));
      }
    });
    return { capture, inbox, created };
  }, { now });
}

/** Puts back what annotateBankPayment changed, field by field, unless the person has edited it since. */
function restoreBankPayment(db, userId, item, captureId) {
  const row = db.prepare('SELECT * FROM active_transactions WHERE id = ? AND user_id = ?').get(item.id, userId);
  if (!row) return; // deleted in the ledger since: nothing left to restore
  const back = {};
  for (const [field, value] of Object.entries(item.applied || {})) if (row[field] === value) back[field] = item.prior[field];
  if (row.capture_id === captureId) back.capture_id = null;
  if (!Object.keys(back).length) return;
  const sets = Object.keys(back).map((c) => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE transactions SET ${sets}, updated_at = @now WHERE id = @id AND user_id = @userId`).run({ ...back, now: nowIso(), id: row.id, userId });
}

/**
 * Reverses a saved capture: ledger rows are archived (like deleting them in the ledger), open tasks
 * are deleted, and check-ins are undone (which also reverses their XP). A task already completed
 * is left alone, since undoing it would silently take back XP the person saw being paid. A payment
 * the bank's SMS has since confirmed is kept too: it is the bank's record now. A payment that was
 * merged into a bank row on save is not archived; its category and note are removed again.
 */
function undo(userId, id, { now } = {}) {
  const db = getDb();
  return run(userId, (ctx) => {
    const row = findCapture(db, userId, id);
    if (row.status !== 'done') throw AppError.conflict('Only a saved capture can be undone', 'CAPTURE_NOT_DONE');
    const kept = [];
    for (const item of JSON.parse(row.result || '[]')) {
      if (item.type === 'transaction' && item.matched) {
        restoreBankPayment(db, userId, item, row.id); // the bank's row stays; only the person's additions go
      } else if (item.type === 'transaction') {
        const stamp = nowIso();
        const changed = db.prepare("UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND source = 'manual' AND deleted_at IS NULL")
          .run(stamp, stamp, item.id, userId).changes;
        if (!changed) kept.push(item);
      } else if (item.type === 'task') {
        const task = db.prepare('SELECT status FROM active_tasks WHERE id = ? AND user_id = ?').get(item.id, userId);
        if (task?.status === 'open') tasks.deleteTask(ctx, item.id);
        else if (task) kept.push(item);
      } else if (item.type === 'habit') {
        // Already checked in before this capture: nothing here to take back (just the quantity it overwrote).
        if (item.already) {
          // Through the habit service, so XP the repeat paid by crossing the target is taken back too.
          try { habits.restoreQuantity(ctx, item.id, item.date, item.previousQuantity); } catch (err) {
            if (err.statusCode !== 404) throw err;
            kept.push(item); // the habit was deleted since
          }
          continue;
        }
        try { habits.undoCheckIn(ctx, item.id, item.date); } catch (err) {
          if (err.statusCode !== 404 && err.statusCode !== 400) throw err;
          kept.push(item); // archived, deleted, or too old to change
        }
      }
    }
    const stamp = nowIso();
    db.prepare("UPDATE captures SET status = 'undone', updated_at = ? WHERE id = ?").run(stamp, row.id);
    return { _id: row.id, status: 'undone', kept };
  }, { now });
}

function listInbox(userId) {
  const db = getDb();
  const items = db.prepare(`SELECT * FROM captures WHERE user_id = ? AND status = 'inbox' AND deleted_at IS NULL
    ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(userId, INBOX_LIMIT).map(toCapture);
  const total = db.prepare("SELECT count(*) FROM captures WHERE user_id = ? AND status = 'inbox' AND deleted_at IS NULL").pluck().get(userId);
  return { items, total };
}

function dismiss(userId, id) {
  const db = getDb();
  const row = findCapture(db, userId, id);
  if (row.status !== 'inbox') throw AppError.conflict('Only inbox items can be dismissed', 'CAPTURE_NOT_INBOX');
  const stamp = nowIso();
  db.prepare("UPDATE captures SET status = 'dismissed', updated_at = ?, resolved_at = ? WHERE id = ?").run(stamp, stamp, id);
  return { _id: id, status: 'dismissed' };
}

/** Pending inbox notes, for the daily reminder. Read-only. */
function inboxSummary(db, userId) {
  const rows = db.prepare(`SELECT text FROM captures WHERE user_id = ? AND status = 'inbox' AND deleted_at IS NULL
    ORDER BY created_at, rowid`).pluck().all(userId);
  return { count: rows.length, first: rows[0] || null };
}

// LIKE with the person's text taken literally: % and _ are escaped.
const like = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * One query across the modules for the command palette. Every query is scoped to the user.
 * A number also matches transaction amounts exactly ("450" finds the ₹450 payment).
 */
function search(userId, q) {
  const db = getDb();
  const pattern = like(q);
  const amount = /^\d+(?:\.\d{1,2})?$/.test(q) ? toPaise(Number(q)) : null;
  const transactions = db.prepare(`SELECT id, date, description, amount_paise, type FROM active_transactions
    WHERE user_id = ? AND (description LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' ${amount ? 'OR amount_paise = ?' : ''})
    ORDER BY date DESC, rowid DESC LIMIT 5`).all(userId, pattern, pattern, ...(amount ? [amount] : []))
    .map((t) => ({ kind: 'transaction', id: t.id, title: t.description, date: t.date, amount: fromPaise(t.amount_paise), direction: t.type }));
  const taskRows = db.prepare(`SELECT id, title, status, due_date FROM active_tasks
    WHERE user_id = ? AND parent_id IS NULL AND title LIKE ? ESCAPE '\\'
    ORDER BY status = 'open' DESC, due_date IS NULL, due_date, rowid DESC LIMIT 5`).all(userId, pattern)
    .map((t) => ({ kind: 'task', id: t.id, title: t.title, status: t.status, dueDate: t.due_date }));
  const habitRows = db.prepare(`SELECT id, name, current_streak FROM active_habits
    WHERE user_id = ? AND archived_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY position LIMIT 4`).all(userId, pattern)
    .map((h) => ({ kind: 'habit', id: h.id, title: h.name, streak: h.current_streak }));
  const goals = db.prepare(`SELECT id, name, status FROM active_goals WHERE user_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY status = 'active' DESC LIMIT 3`)
    .all(userId, pattern).map((g) => ({ kind: 'goal', id: g.id, title: g.name, status: g.status }));
  const bills = db.prepare(`SELECT id, name, kind, amount_paise FROM active_commitments WHERE user_id = ? AND active = 1 AND name LIKE ? ESCAPE '\\' LIMIT 3`)
    .all(userId, pattern).map((c) => ({ kind: 'commitment', id: c.id, title: c.name, type: c.kind, amount: fromPaise(c.amount_paise) }));
  const inbox = db.prepare(`SELECT id, text FROM captures WHERE user_id = ? AND status = 'inbox' AND deleted_at IS NULL AND text LIKE ? ESCAPE '\\' LIMIT 3`)
    .all(userId, pattern).map((c) => ({ kind: 'capture', id: c.id, title: c.text }));
  return [...taskRows, ...habitRows, ...transactions, ...goals, ...bills, ...inbox];
}

module.exports = { preview, commit, undo, listInbox, dismiss, inboxSummary, search, contextFor, INBOX_LIMIT };
