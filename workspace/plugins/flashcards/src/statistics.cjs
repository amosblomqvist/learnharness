'use strict';
const { dayBounds, studyDay } = require('./scheduler.cjs');

function statistics(state, live, now) {
  const dayStart = state.settings.dayStart;
  const today = studyDay(now, dayStart), { start } = dayBounds(now, dayStart);
  const dayAt = offset => {
    // Advance civil dates, not fixed 24-hour intervals across DST boundaries.
    const date = new Date(start);
    date.setHours(12, 0, 0, 0); date.setDate(date.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const states = { new: 0, learning: 0, review: 0, relearning: 0 };
  const names = ['new', 'learning', 'review', 'relearning'];
  const due = [{ day: null, count: 0 }, ...Array.from({ length: 8 }, (_, i) => ({ day: dayAt(i), count: 0 }))];
  const activity = Array.from({ length: 14 }, (_, i) => ({ day: dayAt(i - 13), count: 0 }));
  const dueDays = new Map(due.slice(1).map(row => [row.day, row]));
  const activityDays = new Map(activity.map(row => [row.day, row]));
  for (const p of Object.values(state.propositions)) {
    if ((p.origin !== 'file' && p.origin !== 'manual' && !live.has(p.id)) || !p.cues.some(c => !c.deleted)) continue;
    const schedule = p.schedule;
    states[names[schedule.state]]++;
    if (schedule.state === 0) continue;
    const day = schedule.state === 2 && schedule.dueDay ? schedule.dueDay : studyDay(schedule.due, dayStart);
    const bucket = day < today ? due[0] : dueDays.get(day);
    if (bucket) bucket.count++;
  }
  // Past activity is evidence of actual reviews, even if its cards are now archived/deleted.
  for (const review of state.reviews) {
    const bucket = activityDays.get(studyDay(review.at, dayStart));
    if (bucket) bucket.count++;
  }
  return { states, due, activity };
}
module.exports = { statistics };
