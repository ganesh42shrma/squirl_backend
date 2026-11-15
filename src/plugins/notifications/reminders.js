const { createHash } = require('node:crypto');
const { dayKey } = require('../tasks/day');
const { clockFor } = require('../tasks/settings');
const { periodFor, targetFor, isScheduled, isDayDone } = require('../tasks/streak.engine');
const commitments = require('../commitments/commitment.service');
const { inboxSummary } = require('../capture/capture.service');

// Short text for a notification. Push payloads are end-to-end encrypted; the service worker still caps lengths.
const clip = (text, max = 60) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** Names of the habits still to do today (empty on vacation). */
function pendingHabitNames(db, userId, today, settings) {
  if (settings.vacationFrom && today >= settings.vacationFrom && today <= settings.vacationUntil) return [];
  const habits = db.prepare('SELECT * FROM active_habits WHERE user_id = ? AND archived_at IS NULL AND start_date <= ?').all(userId, today);
  return habits.filter((habit) => {
    if (!isScheduled(habit, today)) return false;
    const period = periodFor(habit, today);
    const checkins = db.prepare('SELECT date, kind, quantity FROM habit_checkins WHERE habit_id = ? AND date BETWEEN ? AND ?').all(habit.id, period.start, today);
    if (checkins.some((c) => c.date === today && (c.kind === 'skip' || isDayDone(habit, c)))) return false;
    return checkins.filter((c) => isDayDone(habit, c)).length < targetFor(habit, period);
  }).map((habit) => habit.name);
}
const pendingHabits = (...args) => pendingHabitNames(...args).length > 0;

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
  // With details off (a per-device choice), only the kind is sent and the phone shows a generic line.
  const details = preferences.details !== false;
  const add = (kind, key, detail) => messages.push({ kind, key, tag: createHash('sha256').update(`${userId}:${key}`).digest('hex').slice(0, 24),
    ...(details && detail && { detail }) });
  if (preferences.tasks) {
    const rows = db.prepare(`SELECT t.id, t.title, t.due_date, t.due_time FROM active_tasks t
      WHERE t.user_id = ? AND t.status = 'open' AND t.due_date <= ?
      AND (t.parent_id IS NULL OR EXISTS (SELECT 1 FROM active_tasks parent WHERE parent.id = t.parent_id AND parent.status = 'open'))`).all(userId, today);
    const daily = rows.filter((t) => t.due_date < today || !t.due_time);
    if (taskMinutes(clock) >= taskMinutes(preferences.dailyTime) && daily.length) {
      add('tasks', `tasks:${today}`, { count: daily.length, overdue: daily.filter((t) => t.due_date < today).length, first: clip(daily[0].title) });
    }
    for (const task of rows) {
      if (task.due_date === today && task.due_time && taskMinutes(clock) >= taskMinutes(task.due_time)) {
        add('tasks', `task:${task.id}:${task.due_date}:${task.due_time}`, { title: clip(task.title), time: task.due_time });
      }
    }
  }
  if (preferences.habits && taskMinutes(clock) >= taskMinutes(preferences.habitTime)) {
    const names = pendingHabitNames(db, userId, today, settings);
    if (names.length) add('habits', `habits:${today}`, { count: names.length, names: names.slice(0, 3).map((n) => clip(n, 30)) });
  }
  if (preferences.bills && clock >= preferences.dailyTime) {
    const { alerts } = await commitments.listAlerts(userId, calendarDay);
    if (alerts.length) {
      const first = alerts.find((a) => a.type === 'missed') || alerts[0];
      add('bills', `bills:${calendarDay}`, { count: alerts.length, name: clip(first.name, 40), amount: first.amount || 0,
        missed: first.type === 'missed', daysUntil: first.daysUntil ?? 0 });
    }
  }
  // Unsorted Quick Capture notes. Devices saved before this option existed get it on by default.
  if (preferences.captures !== false && clock >= preferences.dailyTime) {
    const { count, first } = inboxSummary(db, userId);
    if (count) add('captures', `captures:${calendarDay}`, { count, first: clip(first, 50) });
  }
  return messages;
}

module.exports = { remindersFor, pendingHabits, pendingHabitNames };
