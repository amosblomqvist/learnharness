'use strict';

// Selectively adapted from ts-fsrs 5.2.3 (FSRS-6), MIT, Open Spaced Repetition.
// See ../FSRS-LICENSE.txt. No Date prototype extensions or runtime dependencies.
const W = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194,
  0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629,
  1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
]);
const MINUTE = 60000;
const DAY = 86400000;
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const round8 = (v) => +v.toFixed(8);
const DECAY = -W[20];
const FACTOR = round8(Math.exp(Math.pow(DECAY, -1) * Math.log(0.9)) - 1);

function timestamp(now) {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
    throw new RangeError('Expected a finite epoch-millisecond timestamp');
  }
  return now;
}

function dayBounds(now, startHour = 4) {
  timestamp(now);
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
    throw new RangeError('dayStart must be an integer from 0 to 23');
  }
  const start = new Date(now);
  start.setHours(startHour, 0, 0, 0);
  if (+start > now) {
    start.setDate(start.getDate() - 1);
    start.setHours(startHour, 0, 0, 0);
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setHours(startHour, 0, 0, 0);
  return { start: +start, end: +end };
}

function studyDay(now, startHour = 4) {
  const date = new Date(dayBounds(now, startHour).start);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function ordinal(now, startHour) {
  const date = new Date(dayBounds(now, startHour).start);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

function reviewDue(now, days, dayStart) {
  const date = new Date(dayBounds(now, dayStart).start);
  date.setDate(date.getDate() + days);
  // Restore the requested rollover even if the starting date crossed a DST gap.
  date.setHours(dayStart, 0, 0, 0);
  return +date;
}

function settingsFor(settings) {
  const retention = settings.retention ?? 0.9;
  if (!Number.isFinite(retention) || retention <= 0 || retention > 1) {
    throw new RangeError('retention must be in (0, 1]');
  }
  const learningSteps = settings.learningSteps ?? [1, 10];
  const relearningSteps = settings.relearningSteps ?? [10];
  for (const steps of [learningSteps, relearningSteps]) {
    if (!Array.isArray(steps) || steps.some((step) => !Number.isFinite(step) || step <= 0)) {
      throw new RangeError('Learning steps must be arrays of positive minutes');
    }
  }
  const dayStart = settings.dayStart ?? 4;
  dayBounds(0, dayStart);
  return {
    learningSteps, relearningSteps, dayStart,
    modifier: round8((Math.pow(retention, 1 / DECAY) - 1) / FACTOR),
  };
}

function createSchedule(now = Date.now()) {
  return {
    due: timestamp(now), stability: 0, difficulty: 0, elapsed_days: 0,
    scheduled_days: 0, reps: 0, lapses: 0, learning_steps: 0,
    state: 0, last_review: null,
  };
}

function initDifficulty(rating) {
  return round8(W[4] - Math.exp((rating - 1) * W[5]) + 1);
}

function nextDifficulty(difficulty, rating) {
  const delta = round8(-W[6] * (rating - 3) * (10 - difficulty) / 9);
  return clamp(round8(W[7] * initDifficulty(4) + (1 - W[7]) * (difficulty + delta)), 1, 10);
}

function shortStability(stability, rating) {
  const increase = Math.pow(stability, -W[19]) * Math.exp(W[17] * (rating - 3 + W[18]));
  return round8(clamp(stability * (rating >= 3 ? Math.max(increase, 1) : increase), 0.001, 36500));
}

function reviewStability(schedule, rating, elapsed) {
  const { difficulty: d, stability: s } = schedule;
  const r = round8(Math.pow(1 + FACTOR * elapsed / s, DECAY));
  if (rating === 1) {
    const forgotten = round8(clamp(W[11] * Math.pow(d, -W[12]) *
      (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]), 0.001, 36500));
    return clamp(round8(s / Math.exp(W[17] * W[18])), 0.001, forgotten);
  }
  const hard = rating === 2 ? W[15] : 1;
  const easy = rating === 4 ? W[16] : 1;
  return round8(clamp(s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) *
    (Math.exp((1 - r) * W[10]) - 1) * hard * easy), 0.001, 36500));
}

function interval(stability, settings) {
  return clamp(Math.round(stability * settings.modifier), 1, 36500);
}

// Reference BasicLearningStepsStrategy, using numeric minutes rather than strings.
function learningInfo(schedule, rating, settings) {
  const steps = schedule.state === 2 || schedule.state === 3
    ? settings.relearningSteps : settings.learningSteps;
  let step = schedule.learning_steps || 0;
  if (schedule.state === 1 && rating >= 3) step += 1;
  if (steps.length === 0 || step >= steps.length) return { minutes: 0, step: 0 };
  if (schedule.state === 2) return { minutes: steps[step], step: 0 };
  if (rating === 1) return { minutes: steps[0], step: 0 };
  if (rating === 2) {
    return { minutes: Math.round(steps.length === 1 ? steps[0] * 1.5 : (steps[0] + steps[1]) / 2), step };
  }
  if (rating === 3 && steps[step + 1]) return { minutes: Math.round(steps[step + 1]), step: step + 1 };
  return { minutes: 0, step: 0 };
}

function applySteps(next, previous, rating, now, settings) {
  const { minutes, step } = learningInfo(previous, rating, settings);
  if (minutes > 0) {
    next.learning_steps = step;
    next.scheduled_days = Math.floor(minutes / 1440);
    next.state = minutes < 1440 ? (previous.state === 2 ? 3 : previous.state || 1) : 2;
    next.due = now + Math.round(minutes) * MINUTE;
  } else {
    next.learning_steps = 0;
    next.state = 2;
    next.scheduled_days = interval(next.stability, settings);
    next.due = reviewDue(now, next.scheduled_days, settings.dayStart);
  }
}

function rate(schedule, rating, now = Date.now(), settings = {}) {
  timestamp(now);
  if (!Number.isInteger(rating) || rating < 1 || rating > 4) throw new RangeError('rating must be 1–4');
  if (!schedule || !Number.isInteger(schedule.state) || schedule.state < 0 || schedule.state > 3) {
    throw new RangeError('Invalid schedule state');
  }
  const options = settingsFor(settings);
  const steps = schedule.state === 2 || schedule.state === 3
    ? options.relearningSteps : options.learningSteps;
  if (steps.length && schedule.learning_steps >= steps.length) {
    // Settings edits take effect when graded, never by moving an outstanding due.
    schedule = { ...schedule, learning_steps: steps.length - 1 };
  }
  const elapsed = schedule.state === 0 || schedule.last_review == null ? 0 :
    Math.max(0, ordinal(now, options.dayStart) - ordinal(schedule.last_review, options.dayStart));
  const next = { ...schedule, elapsed_days: elapsed, reps: schedule.reps + 1, last_review: now };
  if (schedule.state === 0) {
    next.stability = Math.max(W[rating - 1], 0.1);
    next.difficulty = clamp(initDifficulty(rating), 1, 10);
  } else {
    next.difficulty = nextDifficulty(schedule.difficulty, rating);
    next.stability = schedule.state === 2
      ? reviewStability(schedule, rating, elapsed) : shortStability(schedule.stability, rating);
  }
  if (schedule.state !== 2 || rating === 1) {
    if (schedule.state === 2) next.lapses += 1;
    applySteps(next, schedule, rating, now, options);
  } else {
    // Compute all passing intervals together to preserve the reference ordering.
    const hard = Math.min(interval(reviewStability(schedule, 2, elapsed), options),
      interval(reviewStability(schedule, 3, elapsed), options));
    const good = Math.max(interval(reviewStability(schedule, 3, elapsed), options), hard + 1);
    const easy = Math.max(interval(reviewStability(schedule, 4, elapsed), options), good + 1);
    next.scheduled_days = { 2: hard, 3: good, 4: easy }[rating];
    next.state = 2;
    next.learning_steps = 0;
    next.due = reviewDue(now, next.scheduled_days, options.dayStart);
  }
  if (next.state === 2) next.dueDay = studyDay(next.due, options.dayStart);
  else delete next.dueDay;
  return next;
}

function preview(schedule, now = Date.now(), settings = {}) {
  return Object.fromEntries([1, 2, 3, 4].map((rating) => [rating, rate(schedule, rating, now, settings)]));
}

function chooseCue(cues, random = Math.random) {
  if (!cues.length) return null;
  const weight = (cue) => ({ 1: 4, 2: 3, 3: 2, 4: 1 }[cue.latestRating] ?? 3);
  const total = cues.reduce((sum, cue) => sum + weight(cue), 0);
  let target = random() * total;
  for (const cue of cues) {
    target -= weight(cue);
    if (target < 0) return cue;
  }
  return cues[cues.length - 1];
}

function isDue(schedule, now = Date.now(), startHour = 4) {
  const today = studyDay(now, startHour);
  // Logical review dates survive timezone and rollover-setting changes. Older
  // schedules without dueDay retain their original epoch cutoff until graded.
  if (schedule.state === 2 && schedule.dueDay) return today >= schedule.dueDay;
  return schedule.due <= now;
}

module.exports = { createSchedule, rate, preview, chooseCue, studyDay, dayBounds, isDue };
