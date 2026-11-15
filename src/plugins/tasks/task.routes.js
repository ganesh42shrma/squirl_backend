const { Router } = require('express');
const validate = require('../../core/validate');
const schemas = require('./task.validation');
const c = require('./task.controller');

const router = Router();

router.get('/overview', c.overview);
router.get('/settings', c.getSettings);
router.patch('/settings', validate(schemas.updateSettings), c.updateSettings);

router.get('/lists', c.listLists);
router.post('/lists', validate(schemas.createList), c.createList);
router.patch('/lists/:id', validate(schemas.updateList), c.updateList);
router.delete('/lists/:id', validate(schemas.byId), c.deleteList);

router.get('/today', c.today);
router.get('/items', validate(schemas.listTasks), c.listTasks);
router.post('/items', validate(schemas.createTask), c.createTask);
router.patch('/items/reorder', validate(schemas.reorder), c.reorderTasks); // before /items/:id
router.get('/items/:id', validate(schemas.byId), c.getTask);
router.patch('/items/:id', validate(schemas.updateTask), c.updateTask);
router.delete('/items/:id', validate(schemas.byId), c.deleteTask);
router.post('/items/:id/complete', validate(schemas.byId), c.completeTask);
router.post('/items/:id/reopen', validate(schemas.byId), c.reopenTask);
router.post('/items/:id/checklist', validate(schemas.addChecklistItem), c.addChecklistItem);
router.patch('/checklist/:itemId', validate(schemas.updateChecklistItem), c.updateChecklistItem);
router.delete('/checklist/:itemId', validate(schemas.removeChecklistItem), c.removeChecklistItem);

router.get('/habits', validate(schemas.habitQuery), c.listHabits);
router.post('/habits', validate(schemas.createHabit), c.createHabit);
router.get('/habits/:id', validate(schemas.byId), c.getHabit);
router.patch('/habits/:id', validate(schemas.updateHabit), c.updateHabit);
router.delete('/habits/:id', validate(schemas.byId), c.deleteHabit);
router.post('/habits/:id/archive', validate(schemas.archiveHabit), c.archiveHabit);
router.post('/habits/:id/checkins', validate(schemas.checkIn), c.checkIn);
router.delete('/habits/:id/checkins/:date', validate(schemas.undoCheckIn), c.undoCheckIn);
router.post('/habits/:id/bind', validate(schemas.byId), c.bindEcho);
router.get('/habits/:id/history', validate(schemas.history), c.habitHistory);

router.get('/quests/today', c.getQuest);
router.put('/quests/today', validate(schemas.setQuestItems), c.setQuestItems);
router.put('/quests/config', validate(schemas.configureQuest), c.configureQuest);
router.post('/quests/today/items/:key/toggle', validate(schemas.questKey), c.toggleQuestItem);
router.post('/quests/penalty/complete', c.completePenalty);

router.get('/xp', validate(schemas.xpQuery), c.xp);
router.get('/achievements', c.achievements);
router.patch('/profile', validate(schemas.updateProfile), c.updateProfile);
router.post('/trial/claim', c.claimTrial);

module.exports = router;
