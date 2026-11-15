const { createHash } = require('node:crypto');
const { dayKey } = require('../tasks/day');
const { clockFor } = require('../tasks/settings');
const { periodFor, targetFor, isScheduled, isDayDone } = require('../tasks/streak.engine');
const commitments = require('../commitments/commitment.service');

function pendingHabits(db, userId, today, settings) {
  if (settings.vacationFrom && today >= settings.vacationFrom && today <= settings.vacationUntil) return false;
  const habits = db.prepare('SELECT * FROM active_habits WHERE user_id = ? AND archived_at IS NULL AND start_date <= ?').all(userId, today);
  return habits.some((habit) => {
    if (!isScheduled(habit, today)) return false;
    const period = periodFor(habit, today);
    const checkins = db.prepare('SELECT date, kind, quantity FROM habit_checkins WHERE habit_id = ? AND date BETWEEN ? AND ?').all(habit.id, period.start, today);
    if (checkins.some((c) => c.date === today && (c.kind === 'skip' || isDayDone(habit, c)))) return false;
    return checkins.filter((c) => isDayDone(habit, c)).length < targetFor(habit, period);
  });
}

// Read-only: sending reminders must never settle quests, pay XP, or alter a habit's streak.
async function remindersFor(db, userId, preferences, settings, now = new Date()) {
  const { today } = clockFor(settings, now);
  const calendarDay = dayKey(now, { ...settings, dayStartHour: 0 });
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: settings.timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(now);
  // Tasks days can span midnight (e.g. 4AM–4AM); 2AM comes after 11PM within that day.
  const taskMinutes = (time) => {
    const [h, m] = time.split(':').map(Number);
    return (h * 60 + m - settings.dayStartHour * 60 + 1440) % 1440;
  };
  const messages = [];
  const add = (kind, key) => messages.push({ kind, key, tag: createHash('sha256').update(`${userId}:${key}`).digest('hex').slice(0, 24) });
  if (preferences.tasks) {
    const rows = db.prepare(`SELECT t.id, t.due_date, t.due_time FROM active_tasks t
      WHERE t.user_id = ? AND t.status = 'open' AND t.due_date <= ?
      AND (t.parent_id IS NULL OR EXISTS (SELECT 1 FROM active_tasks parent WHERE parent.id = t.parent_id AND parent.status = 'open'))`).all(userId, today);
    if (taskMinutes(clock) >= taskMinutes(preferences.dailyTime) && rows.some((t) => t.due_date < today || !t.due_time)) add('tasks', `tasks:${today}`);
    for (const task of rows) {
      if (task.due_date === today && task.due_time && taskMinutes(clock) >= taskMinutes(task.due_time)) {
        add('tasks', `task:${task.id}:${task.due_date}:${task.due_time}`);
      }
    }
  }
  if (preferences.habits && taskMinutes(clock) >= taskMinutes(preferences.habitTime) && pendingHabits(db, userId, today, settings)) add('habits', `habits:${today}`);
  if (preferences.bills && clock >= preferences.dailyTime && (await commitments.listAlerts(userId, calendarDay)).alerts.length) add('bills', `bills:${calendarDay}`);
  return messages;
}

module.exports = { remindersFor, pendingHabits };
