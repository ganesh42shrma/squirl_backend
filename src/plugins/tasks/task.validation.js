const { z } = require('zod');
const { entityId, idParams } = require('../../core/schemas');
const { TASK_DIFFICULTIES, HABIT_DIFFICULTIES, STATS } = require('./xp.engine');
const { CADENCES, REPEAT_FREQS } = require('./task.model');
const { isValidTimezone } = require('./day');

const day = z.iso.date();
const text = (max) => z.string().trim().min(1).max(max);
const stat = z.enum(STATS).nullable();
const color = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #cc785c');

// --- Lists ------------------------------------------------------------------------------------
const createList = z.object({ body: z.object({ name: text(60), color: color.nullable().optional() }) });
const updateList = z.object({
  params: idParams,
  body: z.object({ name: text(60).optional(), color: color.nullable().optional() }).refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
});

// --- Tasks ------------------------------------------------------------------------------------
const repeat = z.object({
  freq: z.enum(REPEAT_FREQS),
  interval: z.number().int().min(1).max(52).default(1),
  days: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  monthDay: z.number().int().min(1).max(31).optional(),
});

const taskFields = {
  title: text(200),
  notes: z.string().trim().max(2000).nullable(),
  difficulty: z.enum(TASK_DIFFICULTIES),
  stat,
  priority: z.number().int().min(0).max(3),
  dueDate: day.nullable(),
  dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM').nullable(),
  listId: entityId.nullable(),
  repeat: repeat.nullable(),
};

const createTask = z.object({
  body: z.object({
    title: taskFields.title,
    notes: taskFields.notes.optional(),
    difficulty: taskFields.difficulty.optional(),
    stat: stat.optional(),
    priority: taskFields.priority.optional(),
    dueDate: taskFields.dueDate.optional(),
    dueTime: taskFields.dueTime.optional(),
    listId: taskFields.listId.optional(),
    repeat: taskFields.repeat.optional(),
    parentId: entityId.optional(),
  }),
});

const updateTask = z.object({
  params: idParams,
  body: z.object(Object.fromEntries(Object.entries(taskFields).map(([k, v]) => [k, v.optional()])))
    .refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
});

const listTasks = z.object({
  query: z.object({
    list: z.union([entityId, z.literal('inbox')]).optional(),
    status: z.enum(['open', 'done', 'all']).optional(),
    due: z.enum(['today', 'overdue', 'upcoming', 'none']).optional(),
    search: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
});

const reorder = z.object({ body: z.object({ ids: z.array(entityId).min(1).max(500) }) });
const byId = z.object({ params: idParams });

const addChecklistItem = z.object({ params: idParams, body: z.object({ text: text(200) }) });
const itemParams = z.object({ itemId: entityId });
const updateChecklistItem = z.object({
  params: itemParams,
  body: z.object({ text: text(200).optional(), done: z.boolean().optional() }).refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
});
const removeChecklistItem = z.object({ params: itemParams });

// --- Habits -----------------------------------------------------------------------------------
const habitFields = {
  name: text(80),
  icon: z.string().trim().max(40).nullable(),
  color: color.nullable(),
  difficulty: z.enum(HABIT_DIFFICULTIES),
  stat,
  cadence: z.enum(CADENCES),
  daysMask: z.number().int().min(1).max(127),
  targetPerPeriod: z.number().int().min(1).max(31),
  everyN: z.number().int().min(2).max(60).nullable(),
  targetQuantity: z.number().positive().max(100000).nullable(),
  unit: z.string().trim().max(20).nullable(),
  startDate: day,
  freezeMax: z.number().int().min(0).max(5),
  skipsPerWeek: z.number().int().min(0).max(7),
  inDailyQuest: z.boolean(),
};

const createHabit = z.object({
  body: z.object({
    ...Object.fromEntries(Object.entries(habitFields).map(([k, v]) => [k, v.optional()])),
    name: habitFields.name,
  }).superRefine((b, ctx) => {
    if (b.cadence === 'every_n_days' && !b.everyN) ctx.addIssue({ code: 'custom', path: ['everyN'], message: 'Choose how many days apart' });
    if (b.cadence === 'times_per_week' && (b.targetPerPeriod ?? 1) > 7) ctx.addIssue({ code: 'custom', path: ['targetPerPeriod'], message: 'A week has 7 days' });
    if (b.targetQuantity && !b.unit) ctx.addIssue({ code: 'custom', path: ['unit'], message: 'Say what you are counting (glasses, pages...)' });
  }),
});

const updateHabit = z.object({
  params: idParams,
  body: z.object(Object.fromEntries(Object.entries(habitFields).map(([k, v]) => [k, v.optional()])))
    .refine((b) => Object.keys(b).length > 0, 'Nothing to update')
    .superRefine((b, ctx) => {
      if (b.cadence === 'every_n_days' && !b.everyN) ctx.addIssue({ code: 'custom', path: ['everyN'], message: 'Choose how many days apart' });
      if (b.cadence === 'times_per_week' && (b.targetPerPeriod ?? 1) > 7) ctx.addIssue({ code: 'custom', path: ['targetPerPeriod'], message: 'A week has 7 days' });
    }),
});

const habitQuery = z.object({ query: z.object({ archived: z.stringbool().optional() }) });
const archiveHabit = z.object({ params: idParams, body: z.object({ archived: z.boolean().default(true) }).default({ archived: true }) });
const checkIn = z.object({
  params: idParams,
  body: z.object({ date: day.optional(), kind: z.enum(['done', 'skip']).default('done'), quantity: z.number().min(0).max(100000).optional() }),
});
const undoCheckIn = z.object({ params: z.object({ id: entityId, date: day }) });
const history = z.object({ params: idParams, query: z.object({ from: day.optional(), to: day.optional() }) });

// --- Quests, settings, profile ----------------------------------------------------------------
const questItem = z.discriminatedUnion('type', [
  z.object({ type: z.literal('habit'), refId: entityId }),
  z.object({ type: z.literal('custom'), title: text(120), key: z.string().max(20).optional() }),
]);
const setQuestItems = z.object({ body: z.object({ items: z.array(questItem).min(0).max(5) }) });
const configureQuest = z.object({
  body: z.object({
    lines: z.array(text(120)).max(5),
    habitIds: z.array(entityId).max(5),
    penaltyTask: z.string().trim().max(120), // empty turns the Penalty Quest off
    applyToday: z.boolean().default(true),
  }).refine((b) => b.lines.length + b.habitIds.length <= 5, { message: 'The Daily Quest holds up to five items', path: ['lines'] }),
});
const questKey = z.object({ params: z.object({ key: z.string().regex(/^[a-z0-9:]{1,40}$/i) }) });

const updateSettings = z.object({
  body: z.object({
    timezone: z.string().trim().max(60).refine(isValidTimezone, 'Unknown timezone').optional(),
    dayStartHour: z.number().int().min(0).max(8).optional(),
    dailyCap: z.number().int().min(100).max(5000).optional(),
    penaltyTask: z.string().trim().max(120).optional(),
    dailyQuestTemplate: z.array(text(120)).max(5).optional(),
    vacationUntil: day.nullable().optional(),
  }).refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
});

const updateProfile = z.object({ body: z.object({ title: z.string().max(40).nullable() }) });
const xpQuery = z.object({ query: z.object({ from: day.optional(), to: day.optional() }) });

module.exports = {
  createList, updateList, createTask, updateTask, listTasks, reorder, byId, addChecklistItem, updateChecklistItem, removeChecklistItem,
  createHabit, updateHabit, habitQuery, archiveHabit, checkIn, undoCheckIn, history, setQuestItems, configureQuest, questKey, updateSettings, updateProfile, xpQuery,
};
