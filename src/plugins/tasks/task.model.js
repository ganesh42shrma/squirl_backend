// Row <-> API shapes for Tasks. Days are plain 'YYYY-MM-DD' strings (the person's own day, not UTC).
const { TASK_DIFFICULTIES, HABIT_DIFFICULTIES, STATS } = require('./xp.engine');

const CADENCES = ['daily', 'weekdays', 'times_per_week', 'every_n_days', 'times_per_month'];
const REPEAT_FREQS = ['daily', 'weekly', 'monthly'];

const parseJson = (text, fallback) => {
  try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
};

function toList(row, counts = {}) {
  return { _id: row.id, name: row.name, color: row.color ?? undefined, position: row.position, open: counts.open ?? 0, done: counts.done ?? 0 };
}

function toChecklistItem(row) {
  return { _id: row.id, text: row.text, done: Boolean(row.done) };
}

/** A task, with its subtasks (already shaped) and checklist items attached when known. */
function toTask(row, { subtasks, checklist } = {}) {
  const task = {
    _id: row.id,
    listId: row.list_id ?? undefined,
    parentId: row.parent_id ?? undefined,
    title: row.title,
    notes: row.notes ?? undefined,
    difficulty: row.difficulty,
    stat: row.stat ?? undefined,
    priority: row.priority,
    status: row.status,
    dueDate: row.due_date ?? undefined,
    dueTime: row.due_time ?? undefined,
    repeat: parseJson(row.repeat_rule, undefined),
    position: row.position,
    completedAt: row.completed_at ?? undefined,
    completedOn: row.completed_on ?? undefined,
    xpAwarded: row.xp_awarded,
    createdAt: row.created_at,
  };
  if (subtasks) task.subtasks = subtasks;
  if (checklist) task.checklist = checklist;
  return task;
}

const TASK_FIELDS = {
  title: 'title', notes: 'notes', difficulty: 'difficulty', stat: 'stat', priority: 'priority',
  dueDate: 'due_date', dueTime: 'due_time', listId: 'list_id',
  repeat: ['repeat_rule', (v) => JSON.stringify(v)],
};

function toTaskColumns(data) {
  const out = {};
  for (const [key, spec] of Object.entries(TASK_FIELDS)) {
    if (data[key] === undefined) continue;
    const [column, convert] = Array.isArray(spec) ? spec : [spec, (v) => v];
    out[column] = data[key] === null ? null : convert(data[key]);
  }
  return out;
}

const ECHO_GRADES = [
  { min: 1000, name: 'Marshal' },
  { min: 365, name: 'Elite' },
  { min: 150, name: 'Knight' },
  { min: 66, name: 'Soldier' },
];
const echoGrade = (longest) => ECHO_GRADES.find((g) => longest >= g.min)?.name ?? 'Soldier';

const HABIT_FIELDS = {
  name: 'name', icon: 'icon', color: 'color', difficulty: 'difficulty', stat: 'stat', cadence: 'cadence',
  daysMask: 'days_mask', targetPerPeriod: 'target_per_period', everyN: 'every_n', targetQuantity: 'target_quantity',
  unit: 'unit', startDate: 'start_date', freezeMax: 'freeze_max', skipsPerWeek: 'skips_per_week',
  inDailyQuest: ['in_daily_quest', (v) => (v ? 1 : 0)],
};

function toHabitColumns(data) {
  const out = {};
  for (const [key, spec] of Object.entries(HABIT_FIELDS)) {
    if (data[key] === undefined) continue;
    const [column, convert] = Array.isArray(spec) ? spec : [spec, (v) => v];
    out[column] = data[key] === null ? null : convert(data[key]);
  }
  return out;
}

/** A habit row plus its freshly evaluated streak and recent days. */
function toHabit(row, evaluation, days) {
  return {
    _id: row.id,
    name: row.name,
    icon: row.icon ?? undefined,
    color: row.color ?? undefined,
    difficulty: row.difficulty,
    stat: row.stat ?? undefined,
    cadence: row.cadence,
    daysMask: row.days_mask,
    targetPerPeriod: row.target_per_period,
    everyN: row.every_n ?? undefined,
    targetQuantity: row.target_quantity ?? undefined,
    unit: row.unit ?? undefined,
    startDate: row.start_date,
    freezeMax: row.freeze_max,
    skipsPerWeek: row.skips_per_week,
    inDailyQuest: Boolean(row.in_daily_quest),
    archived: Boolean(row.archived_at),
    currentStreak: row.current_streak,
    longestStreak: row.longest_streak,
    freezesHeld: row.freezes_held,
    echo: row.echo_bound_at ? { boundAt: row.echo_bound_at, grade: echoGrade(row.longest_streak) } : undefined,
    canBind: !row.echo_bound_at && row.longest_streak >= 66,
    ...(evaluation && {
      period: evaluation.period,
      scheduledToday: evaluation.scheduledToday,
      doneToday: evaluation.doneToday,
      quantityToday: evaluation.quantityToday ?? undefined,
      skippedToday: evaluation.skippedToday,
    }),
    ...(days && { days }),
  };
}

module.exports = {
  CADENCES, REPEAT_FREQS, TASK_DIFFICULTIES, HABIT_DIFFICULTIES, STATS, parseJson,
  toList, toChecklistItem, toTask, toTaskColumns, toHabitColumns, toHabit, echoGrade,
};
