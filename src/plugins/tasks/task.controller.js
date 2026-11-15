const { run } = require('./context');
const tasks = require('./task.service');
const habits = require('./habit.service');
const quests = require('./quest.service');
const hunter = require('./hunter.service');
const { sendSuccess } = require('../../core/response');

// Every handler runs inside one transaction with the day's housekeeping done first, and answers
// with the data plus `events` (XP paid, levels, awards...) for the UI to announce.
const handle = (work, { status, message } = {}) => async (req, res) => {
  const { data, events } = run(req.user.id, (ctx) => work(ctx, req));
  return sendSuccess(res, data, { status, message, events });
};

module.exports = {
  overview: handle((ctx) => hunter.overview(ctx)),
  getSettings: handle((ctx) => tasks.getSettings(ctx)),
  updateSettings: handle((ctx, req) => tasks.updateSettings(ctx, req.body), { message: 'Saved' }),

  listLists: handle((ctx) => tasks.listLists(ctx)),
  createList: handle((ctx, req) => tasks.createList(ctx, req.body), { status: 201 }),
  updateList: handle((ctx, req) => tasks.updateList(ctx, req.params.id, req.body)),
  deleteList: handle((ctx, req) => tasks.deleteList(ctx, req.params.id), { message: 'Deleted' }),

  today: handle((ctx) => tasks.todayView(ctx)),
  listTasks: async (req, res) => {
    const { data, events } = run(req.user.id, (ctx) => tasks.listTasks(ctx, req.query));
    return sendSuccess(res, data.items, { meta: data.meta, events });
  },
  createTask: handle((ctx, req) => tasks.createTask(ctx, req.body), { status: 201 }),
  getTask: handle((ctx, req) => tasks.getTask(ctx, req.params.id)),
  updateTask: handle((ctx, req) => tasks.updateTask(ctx, req.params.id, req.body)),
  deleteTask: handle((ctx, req) => tasks.deleteTask(ctx, req.params.id), { message: 'Deleted' }),
  reorderTasks: handle((ctx, req) => tasks.reorderTasks(ctx, req.body.ids)),
  completeTask: handle((ctx, req) => tasks.completeTask(ctx, req.params.id)),
  reopenTask: handle((ctx, req) => tasks.reopenTask(ctx, req.params.id)),
  addChecklistItem: handle((ctx, req) => tasks.addChecklistItem(ctx, req.params.id, req.body), { status: 201 }),
  updateChecklistItem: handle((ctx, req) => tasks.updateChecklistItem(ctx, req.params.itemId, req.body)),
  removeChecklistItem: handle((ctx, req) => tasks.removeChecklistItem(ctx, req.params.itemId)),

  listHabits: handle((ctx, req) => habits.listHabits(ctx, { archived: req.query.archived })),
  createHabit: handle((ctx, req) => habits.createHabit(ctx, req.body), { status: 201 }),
  getHabit: handle((ctx, req) => habits.getHabit(ctx, req.params.id)),
  updateHabit: handle((ctx, req) => habits.updateHabit(ctx, req.params.id, req.body)),
  archiveHabit: handle((ctx, req) => habits.archiveHabit(ctx, req.params.id, req.body.archived)),
  deleteHabit: handle((ctx, req) => habits.deleteHabit(ctx, req.params.id), { message: 'Deleted' }),
  checkIn: handle((ctx, req) => habits.checkIn(ctx, req.params.id, req.body), { status: 201 }),
  undoCheckIn: handle((ctx, req) => habits.undoCheckIn(ctx, req.params.id, req.params.date)),
  bindEcho: handle((ctx, req) => habits.bindEcho(ctx, req.params.id)),
  habitHistory: handle((ctx, req) => habits.history(ctx, req.params.id, req.query)),

  getQuest: handle((ctx) => quests.getToday(ctx)),
  setQuestItems: handle((ctx, req) => quests.setTodayItems(ctx, req.body.items)),
  configureQuest: handle((ctx, req) => quests.configure(ctx, req.body), { message: 'Saved' }),
  toggleQuestItem: handle((ctx, req) => quests.toggleItem(ctx, req.params.key)),
  completePenalty: handle((ctx) => quests.completePenalty(ctx)),

  xp: handle((ctx, req) => hunter.xpSeries(ctx, req.query)),
  achievements: handle((ctx) => hunter.achievements(ctx)),
  updateProfile: handle((ctx, req) => hunter.setTitle(ctx, req.body)),
  claimTrial: handle((ctx) => hunter.claimTrial(ctx)),
};
