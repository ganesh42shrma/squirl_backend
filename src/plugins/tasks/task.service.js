// Lists, tasks, subtasks and checklists. Every function takes the request context
// ({ db, userId, settings, clock, events }) built by context.js and runs inside its transaction,
// so a completion and the XP it pays are one atomic change.
const AppError = require('../../core/AppError');
const { newId, nowIso, insertRow, updateRow, placeholders } = require('../../core/sql');
const xp = require('./xp.engine');
const progress = require('./progress');
const { addDays, daysBetween, isoWeekday, weekStart, monthEnd, localHour } = require('./day');
const { toList, toChecklistItem, toTask, toTaskColumns, parseJson } = require('./task.model');
const { writeSettings } = require('./settings');

const MAX_CHECKLIST_ITEMS = 30;

// --- Shared lookups ---------------------------------------------------------------------------

function findTaskRow(db, userId, id) {
  const row = db.prepare('SELECT * FROM active_tasks WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) throw AppError.notFound('Task not found');
  return row;
}

function assertListOwned(db, userId, listId) {
  if (listId && !db.prepare('SELECT 1 FROM active_task_lists WHERE id = ? AND user_id = ?').get(listId, userId)) {
    throw AppError.notFound('List not found');
  }
}

/** Attaches subtasks and checklist items to task rows (two queries however many tasks). */
function hydrate(db, userId, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const subtasks = db
    .prepare(`SELECT * FROM active_tasks WHERE user_id = ? AND parent_id IN (${placeholders(ids)}) ORDER BY position, rowid`)
    .all(userId, ...ids);
  const checklist = db
    .prepare(`SELECT * FROM task_checklist_items WHERE user_id = ? AND task_id IN (${placeholders(ids)}) ORDER BY position, rowid`)
    .all(userId, ...ids);
  const subsBy = new Map();
  for (const s of subtasks) subsBy.set(s.parent_id, [...(subsBy.get(s.parent_id) || []), toTask(s)]);
  const checkBy = new Map();
  for (const c of checklist) checkBy.set(c.task_id, [...(checkBy.get(c.task_id) || []), toChecklistItem(c)]);
  return rows.map((r) => toTask(r, { subtasks: subsBy.get(r.id) || [], checklist: checkBy.get(r.id) || [] }));
}

const hydrateOne = (ctx, row) => hydrate(ctx.db, ctx.userId, [row])[0];

function nextPosition(db, userId, listId) {
  return db
    .prepare('SELECT ifnull(max(position), 0) + 1 FROM active_tasks WHERE user_id = ? AND parent_id IS NULL AND list_id IS ?')
    .pluck()
    .get(userId, listId ?? null);
}

// --- Lists ------------------------------------------------------------------------------------

function listLists({ db, userId }) {
  const counts = new Map(
    db
      .prepare(`SELECT list_id, status, count(*) AS n FROM active_tasks WHERE user_id = ? AND parent_id IS NULL AND list_id IS NOT NULL GROUP BY list_id, status`)
      .all(userId)
      .map((r) => [`${r.list_id}:${r.status}`, r.n]),
  );
  const lists = db.prepare('SELECT * FROM active_task_lists WHERE user_id = ? ORDER BY position, rowid').all(userId);
  const inbox = db.prepare("SELECT status, count(*) AS n FROM active_tasks WHERE user_id = ? AND parent_id IS NULL AND list_id IS NULL GROUP BY status").all(userId);
  return {
    inbox: { open: inbox.find((r) => r.status === 'open')?.n ?? 0, done: inbox.find((r) => r.status === 'done')?.n ?? 0 },
    lists: lists.map((l) => toList(l, { open: counts.get(`${l.id}:open`), done: counts.get(`${l.id}:done`) })),
  };
}

function createList({ db, userId }, data) {
  const now = nowIso();
  const id = newId();
  const position = db.prepare('SELECT ifnull(max(position), 0) + 1 FROM active_task_lists WHERE user_id = ?').pluck().get(userId);
  insertRow(db, 'task_lists', { id, user_id: userId, name: data.name, color: data.color ?? null, position, created_at: now, updated_at: now });
  return toList(db.prepare('SELECT * FROM task_lists WHERE id = ?').get(id));
}

function updateList({ db, userId }, id, data) {
  const row = db.prepare('SELECT * FROM active_task_lists WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) throw AppError.notFound('List not found');
  const changes = {};
  if (data.name !== undefined) changes.name = data.name;
  if (data.color !== undefined) changes.color = data.color;
  updateRow(db, 'task_lists', id, { ...changes, updated_at: nowIso() });
  return toList(db.prepare('SELECT * FROM task_lists WHERE id = ?').get(id));
}

function deleteList({ db, userId }, id) {
  if (!db.prepare('SELECT 1 FROM active_task_lists WHERE id = ? AND user_id = ?').get(id, userId)) throw AppError.notFound('List not found');
  const now = nowIso();
  // Its tasks aren't deleted: they go back to the inbox.
  db.prepare('UPDATE tasks SET list_id = NULL, updated_at = ? WHERE list_id = ? AND user_id = ?').run(now, id, userId);
  db.prepare('UPDATE task_lists SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(now, now, id, userId);
  return { _id: id };
}

// --- Reading tasks ----------------------------------------------------------------------------

const OPEN_ORDER = 'due_date IS NULL, due_date, priority DESC, position, rowid';

function listTasks(ctx, query) {
  const { db, userId, clock } = ctx;
  const where = ['user_id = ?', 'parent_id IS NULL'];
  const params = [userId];
  const status = query.status || 'open';
  if (status !== 'all') { where.push('status = ?'); params.push(status); }
  if (query.list === 'inbox') where.push('list_id IS NULL');
  else if (query.list) { where.push('list_id = ?'); params.push(query.list); }
  if (query.due === 'today') { where.push('due_date = ?'); params.push(clock.today); }
  else if (query.due === 'overdue') { where.push('due_date < ?'); params.push(clock.today); }
  else if (query.due === 'upcoming') { where.push('due_date > ?'); params.push(clock.today); }
  else if (query.due === 'none') where.push('due_date IS NULL');
  if (query.search) { where.push('instr(lower(title), ?) > 0'); params.push(query.search.toLowerCase()); }
  const { page, limit } = query;
  const clause = `WHERE ${where.join(' AND ')}`;
  const order = status === 'done' ? 'completed_at DESC, rowid DESC' : OPEN_ORDER;
  const rows = db.prepare(`SELECT * FROM active_tasks ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit);
  const total = db.prepare(`SELECT count(*) FROM active_tasks ${clause}`).pluck().get(...params);
  return { items: hydrate(db, userId, rows), meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

/** Everything the Today screen needs in one read. */
function todayView(ctx) {
  const { db, userId, clock } = ctx;
  const { today } = clock;
  const open = (extra, ...args) =>
    hydrate(db, userId, db.prepare(`SELECT * FROM active_tasks WHERE user_id = ? AND parent_id IS NULL AND status = 'open' AND ${extra} ORDER BY ${OPEN_ORDER}`).all(userId, ...args));
  const somedayRows = db.prepare(`SELECT * FROM active_tasks WHERE user_id = ? AND parent_id IS NULL AND status = 'open' AND due_date IS NULL ORDER BY ${OPEN_ORDER} LIMIT 30`).all(userId);
  const somedayTotal = db.prepare("SELECT count(*) FROM active_tasks WHERE user_id = ? AND parent_id IS NULL AND status = 'open' AND due_date IS NULL").pluck().get(userId);
  const doneRows = db.prepare('SELECT * FROM active_tasks WHERE user_id = ? AND parent_id IS NULL AND completed_on = ? ORDER BY completed_at DESC').all(userId, today);
  return {
    date: today,
    overdue: open('due_date < ?', today),
    today: open('due_date = ?', today),
    upcoming: open('due_date > ? AND due_date <= ?', today, addDays(today, 7)),
    someday: { items: hydrate(db, userId, somedayRows), total: somedayTotal },
    doneToday: hydrate(db, userId, doneRows),
  };
}

function getTask(ctx, id) {
  return hydrateOne(ctx, findTaskRow(ctx.db, ctx.userId, id));
}

// --- Writing tasks ----------------------------------------------------------------------------

function createTask(ctx, data) {
  const { db, userId } = ctx;
  let parent = null;
  if (data.parentId) {
    parent = findTaskRow(db, userId, data.parentId);
    if (parent.parent_id) throw AppError.badRequest('Subtasks can’t have subtasks', 'SUBTASK_DEPTH');
    if (parent.status === 'done') throw AppError.conflict('Reopen the task before adding subtasks', 'TASK_DONE');
    if (data.repeat) throw AppError.badRequest('A subtask can’t repeat on its own', 'SUBTASK_REPEAT');
  }
  const listId = parent ? parent.list_id : data.listId ?? null;
  assertListOwned(db, userId, listId);
  const now = nowIso();
  const id = newId();
  const columns = toTaskColumns({ ...data, listId });
  const position = parent
    ? db.prepare('SELECT ifnull(max(position), 0) + 1 FROM active_tasks WHERE parent_id = ?').pluck().get(parent.id)
    : nextPosition(db, userId, listId);
  insertRow(db, 'tasks', {
    difficulty: parent ? 'trivial' : 'normal', priority: 0, ...columns, id, user_id: userId, parent_id: parent?.id ?? null,
    position, created_at: now, updated_at: now,
  });
  return hydrateOne(ctx, findTaskRow(db, userId, id));
}

function updateTask(ctx, id, data) {
  const { db, userId } = ctx;
  const row = findTaskRow(db, userId, id);
  if (data.difficulty !== undefined && data.difficulty !== row.difficulty && row.status === 'done') {
    throw AppError.conflict('Difficulty is locked once a task is done', 'DIFFICULTY_LOCKED');
  }
  if (data.repeat && row.parent_id) throw AppError.badRequest('A subtask can’t repeat on its own', 'SUBTASK_REPEAT');
  if (data.listId !== undefined) {
    if (row.parent_id) throw AppError.badRequest('A subtask stays in its task’s list', 'SUBTASK_LIST');
    assertListOwned(db, userId, data.listId);
  }
  const columns = toTaskColumns(data);
  if (data.listId !== undefined && data.listId !== row.list_id) columns.position = nextPosition(db, userId, data.listId);
  updateRow(db, 'tasks', id, { ...columns, updated_at: nowIso() });
  return hydrateOne(ctx, findTaskRow(db, userId, id));
}

function deleteTask({ db, userId }, id) {
  findTaskRow(db, userId, id);
  const now = nowIso();
  db.prepare('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND (id = ? OR parent_id = ?) AND deleted_at IS NULL').run(now, now, userId, id, id);
  return { _id: id };
}

function reorderTasks({ db, userId }, ids) {
  const update = db.prepare('UPDATE tasks SET position = ? WHERE id = ? AND user_id = ?');
  ids.forEach((id, index) => update.run(index + 1, id, userId));
  return { count: ids.length };
}

// --- Recurrence -------------------------------------------------------------------------------

/** The day after `base` that the rule lands on. */
function nextOccurrence(rule, base) {
  const interval = rule.interval || 1;
  if (rule.freq === 'daily') return addDays(base, interval);
  if (rule.freq === 'weekly') {
    if (!rule.days?.length) return addDays(base, 7 * interval);
    for (let i = 1; i <= 7 * interval + 7; i += 1) {
      const d = addDays(base, i);
      const weeks = daysBetween(weekStart(base), weekStart(d)) / 7;
      if (rule.days.includes(isoWeekday(d)) && weeks % interval === 0) return d;
    }
    return addDays(base, 7 * interval);
  }
  // monthly: the same day of the month (or the chosen one), clamped to short months
  const [y, m, day] = base.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + interval, 1)).toISOString().slice(0, 7);
  const want = rule.monthDay || day;
  return `${target}-${String(Math.min(want, Number(monthEnd(`${target}-01`).slice(8)))).padStart(2, '0')}`;
}

function spawnNextOccurrence(ctx, row) {
  const { db, userId, clock } = ctx;
  const rule = parseJson(row.repeat_rule, null);
  if (!rule) return null;
  let due = nextOccurrence(rule, row.due_date || clock.today);
  for (let guard = 0; due < clock.today && guard < 400; guard += 1) due = nextOccurrence(rule, due);
  const seriesId = row.series_id || row.id;
  if (!row.series_id) db.prepare('UPDATE tasks SET series_id = ? WHERE id = ?').run(seriesId, row.id);
  const now = nowIso();
  const id = newId();
  insertRow(db, 'tasks', {
    id, user_id: userId, list_id: row.list_id, parent_id: null, title: row.title, notes: row.notes, difficulty: row.difficulty, stat: row.stat,
    priority: row.priority, due_date: due, due_time: row.due_time, repeat_rule: row.repeat_rule, series_id: seriesId,
    position: nextPosition(db, userId, row.list_id), created_at: now, updated_at: now,
  });
  // The next one starts fresh: same checklist, unticked, and the same subtasks, open.
  for (const c of db.prepare('SELECT * FROM task_checklist_items WHERE task_id = ? ORDER BY position, rowid').all(row.id)) {
    insertRow(db, 'task_checklist_items', { id: newId(), task_id: id, user_id: userId, text: c.text, done: 0, position: c.position, created_at: now, updated_at: now });
  }
  for (const s of db.prepare('SELECT * FROM active_tasks WHERE parent_id = ? ORDER BY position, rowid').all(row.id)) {
    insertRow(db, 'tasks', {
      id: newId(), user_id: userId, list_id: row.list_id, parent_id: id, title: s.title, difficulty: s.difficulty, stat: s.stat,
      priority: s.priority, position: s.position, created_at: now, updated_at: now,
    });
  }
  return id;
}

// --- Completing and reopening -----------------------------------------------------------------

function completeTask(ctx, id) {
  const { db, userId, settings, clock, events } = ctx;
  const row = findTaskRow(db, userId, id);
  if (row.status === 'done') return hydrateOne(ctx, row);

  const isSubtask = Boolean(row.parent_id);
  const subtaskCount = isSubtask ? 0 : db.prepare('SELECT count(*) FROM active_tasks WHERE parent_id = ?').pluck().get(id);
  const raw = xp.taskAward({
    difficulty: row.difficulty, isSubtask, dueDate: row.due_date, completedOn: clock.today,
    createdAt: Date.parse(row.created_at), completedAt: clock.now.getTime(), subtaskCount, echoCount: progress.echoCount(db, userId),
  });
  const award = xp.applyDailyLimits(raw, { ...progress.dayLedger(db, userId, clock.today), cap: settings.dailyCap });
  const paid = progress.awardXp(db, userId, {
    reason: isSubtask ? 'subtask' : 'task', amount: award.amount, sourceId: id, dedupeKey: `task:${id}`, stat: row.stat, tier: award.tier,
    occurredOn: clock.today, meta: { base: award.base, factor: award.factor, echo: award.echo, notes: award.notes },
  }, events);
  if (award.crossedCap) events.push({ type: 'warning', code: 'daily_cap' });
  const lastEvent = events[events.length - 1];
  if (lastEvent?.type === 'xp') { lastEvent.label = row.title; lastEvent.tier = award.tier; lastEvent.notes = award.notes; }

  db.prepare(`UPDATE tasks SET status = 'done', completed_at = ?, completed_on = ?, completed_hour = ?, xp_awarded = ?, updated_at = ? WHERE id = ?`)
    .run(clock.now.toISOString(), clock.today, localHour(clock.now, settings.timezone), paid, nowIso(), id);
  const spawned = isSubtask ? null : spawnNextOccurrence(ctx, row);
  if (spawned) events.push({ type: 'recurring', taskId: spawned, title: row.title });
  progress.settle(db, userId, clock.today, events);
  return hydrateOne(ctx, findTaskRow(db, userId, id));
}

function reopenTask(ctx, id) {
  const { db, userId, clock, events } = ctx;
  const row = findTaskRow(db, userId, id);
  if (row.status !== 'done') return hydrateOne(ctx, row);
  progress.reverseXp(db, userId, `task:${id}`, events);
  db.prepare("UPDATE tasks SET status = 'open', completed_at = NULL, completed_on = NULL, completed_hour = NULL, xp_awarded = 0, updated_at = ? WHERE id = ?").run(nowIso(), id);
  progress.settle(db, userId, clock.today, events);
  return hydrateOne(ctx, findTaskRow(db, userId, id));
}

// --- Checklist --------------------------------------------------------------------------------

function addChecklistItem(ctx, taskId, { text }) {
  const { db, userId } = ctx;
  const task = findTaskRow(db, userId, taskId);
  const count = db.prepare('SELECT count(*) FROM task_checklist_items WHERE task_id = ?').pluck().get(taskId);
  if (count >= MAX_CHECKLIST_ITEMS) throw AppError.badRequest(`A checklist holds up to ${MAX_CHECKLIST_ITEMS} items`, 'CHECKLIST_FULL');
  const now = nowIso();
  insertRow(db, 'task_checklist_items', { id: newId(), task_id: task.id, user_id: userId, text, done: 0, position: count + 1, created_at: now, updated_at: now });
  return hydrateOne(ctx, findTaskRow(db, userId, taskId));
}

function findChecklistItem(db, userId, itemId) {
  const item = db.prepare('SELECT * FROM task_checklist_items WHERE id = ? AND user_id = ?').get(itemId, userId);
  if (!item || !db.prepare('SELECT 1 FROM active_tasks WHERE id = ?').get(item.task_id)) throw AppError.notFound('Checklist item not found');
  return item;
}

function updateChecklistItem(ctx, itemId, data) {
  const { db, userId, clock, events } = ctx;
  const item = findChecklistItem(db, userId, itemId);
  const changes = {};
  if (data.text !== undefined) changes.text = data.text;
  if (data.done !== undefined) changes.done = data.done ? 1 : 0;
  updateRow(db, 'task_checklist_items', itemId, { ...changes, updated_at: nowIso() });
  if (data.done !== undefined && Boolean(item.done) !== data.done) {
    if (data.done) {
      // 1 XP per ticked item, for the first ten on a task.
      const paidOnTask = db
        .prepare(`SELECT count(*) FROM xp_events e WHERE e.user_id = ? AND e.reason = 'checklist' AND e.source_id = ?
                  AND NOT EXISTS (SELECT 1 FROM xp_events r WHERE r.user_id = e.user_id AND r.dedupe_key = 'rev:' || e.id)`)
        .pluck().get(userId, item.task_id);
      if (paidOnTask < xp.CHECKLIST_MAX_PER_TASK) {
        progress.awardXp(db, userId, { reason: 'checklist', amount: xp.CHECKLIST_XP, sourceId: item.task_id, dedupeKey: `check:${itemId}`, occurredOn: clock.today }, events);
      }
    } else {
      progress.reverseXp(db, userId, `check:${itemId}`, events);
    }
    progress.settle(db, userId, clock.today, events);
  }
  return hydrateOne(ctx, findTaskRow(db, userId, item.task_id));
}

function removeChecklistItem(ctx, itemId) {
  const { db, userId } = ctx;
  const item = findChecklistItem(db, userId, itemId);
  db.prepare('DELETE FROM task_checklist_items WHERE id = ?').run(itemId);
  return hydrateOne(ctx, findTaskRow(db, userId, item.task_id));
}

// --- Settings ---------------------------------------------------------------------------------

function getSettings({ settings }) {
  const { lastClosedOn, vacationFrom, ...rest } = settings;
  return { ...rest, onVacation: Boolean(vacationFrom && rest.vacationUntil) };
}

function updateSettings(ctx, patch) {
  const { db, userId, clock } = ctx;
  const next = { ...ctx.settings };
  for (const key of ['timezone', 'dayStartHour', 'dailyCap', 'penaltyTask', 'dailyQuestTemplate']) if (patch[key] !== undefined) next[key] = patch[key];
  if (patch.vacationUntil !== undefined) {
    next.vacationUntil = patch.vacationUntil;
    next.vacationFrom = patch.vacationUntil ? (ctx.settings.vacationFrom && ctx.settings.vacationUntil ? ctx.settings.vacationFrom : clock.today) : null;
  }
  const habitItems = db.prepare('SELECT count(*) FROM active_habits WHERE user_id = ? AND archived_at IS NULL AND in_daily_quest = 1').pluck().get(userId);
  if (next.dailyQuestTemplate.length + habitItems > 5) throw AppError.badRequest('The Daily Quest holds up to five items, counting habits you’ve added to it', 'QUEST_FULL');
  ctx.settings = writeSettings(db, userId, next);
  return getSettings(ctx);
}

module.exports = {
  listLists, createList, updateList, deleteList, listTasks, todayView, getTask, createTask, updateTask, deleteTask, reorderTasks,
  completeTask, reopenTask, addChecklistItem, updateChecklistItem, removeChecklistItem, getSettings, updateSettings, nextOccurrence,
};
