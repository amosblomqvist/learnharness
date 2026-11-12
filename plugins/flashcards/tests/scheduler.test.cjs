'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const scheduler = require('../src/scheduler.cjs');
const { createSchedule, rate, preview, chooseCue, studyDay, dayBounds, isDue } = scheduler;
const MINUTE = 60000;
const local = (day, hour = 12, minute = 0) => +new Date(2026, 0, day, hour, minute);
const numeric = (s) => [s.stability, s.difficulty, s.elapsed_days, s.scheduled_days,
  s.reps, s.lapses, s.learning_steps, s.state];

// Fixed FSRS-6 fixtures, independently evaluated with ts-fsrs@5.2.3's published
// parameters and logical review dates normalized to UTC noon. Dates deliberately
// remain outside the fixtures: this plugin uses local study days, not UTC dates.
const FIXTURES = {
  new: [
    [0.212, 6.4133, 0, 0, 1, 0, 0, 1],
    [1.2931, 5.11217071, 0, 0, 1, 0, 0, 1],
    [2.3065, 2.11810397, 0, 0, 1, 0, 1, 1],
    [8.2956, 1, 0, 8, 1, 0, 0, 2],
  ],
  learning: [
    [0.08335672, 8.80630447, 0, 0, 2, 0, 0, 1],
    [0.14339875, 7.60420977, 0, 0, 2, 0, 0, 1],
    [0.24668919, 6.40211507, 0, 1, 2, 0, 0, 2],
    [0.42437996, 5.20002037, 0, 1, 2, 0, 0, 2],
  ],
  review: [
    [1.38863246, 7.02698957, 8, 0, 2, 1, 0, 3],
    [26.70418346, 4.01060897, 8, 27, 2, 0, 0, 2],
    [38.90515015, 1, 8, 39, 2, 0, 0, 2],
    [65.62422648, 1, 8, 66, 2, 0, 0, 2],
  ],
  reviewSameDay: [
    [1.18242352, 7.02698957, 0, 0, 2, 1, 0, 3],
    [8.2956, 4.01060897, 0, 8, 2, 0, 0, 2],
    [8.2956, 1, 0, 9, 2, 0, 0, 2],
    [8.2956, 1, 0, 10, 2, 0, 0, 2],
  ],
  reviewOneDay: [
    [1.21617837, 7.02698957, 1, 0, 2, 1, 0, 3],
    [11.4165426, 4.01060897, 1, 11, 2, 0, 0, 2],
    [13.48506225, 1, 1, 13, 2, 0, 0, 2],
    [18.01494386, 1, 1, 18, 2, 0, 0, 2],
  ],
  relearning: [
    [0.48248377, 9.00802006, 0, 0, 3, 1, 0, 3],
    [0.83001791, 8.01160551, 0, 0, 3, 1, 0, 3],
    [1.42788168, 7.01519095, 0, 1, 3, 1, 0, 2],
    [2.45638806, 6.01877639, 0, 2, 3, 1, 0, 2],
  ],
};

for (const kind of Object.keys(FIXTURES)) {
  test(`all four ${kind} outcomes match fixed FSRS-6 fixtures`, () => {
    const initial = createSchedule(local(1));
    const learning = rate(initial, 1, local(1));
    const review = rate(initial, 4, local(1));
    const relearning = rate(review, 1, local(9));
    const schedules = { new: initial, learning, review, relearning, reviewSameDay: review, reviewOneDay: review };
    const now = local(kind === 'reviewOneDay' ? 2 : kind === 'review' || kind === 'relearning' ? 9 : 1);
    const results = preview(schedules[kind], now);
    for (let rating = 1; rating <= 4; rating++) {
      assert.deepEqual(numeric(results[rating]), FIXTURES[kind][rating - 1]);
      assert.deepEqual(rate(schedules[kind], rating, now), results[rating]);
    }
  });
}

test('new schedules and every outcome are JSON-safe and immutable', () => {
  const now = local(1);
  const schedule = Object.freeze(createSchedule(now));
  assert.equal(schedule.due, now);
  assert.equal(schedule.last_review, null);
  assert.deepEqual(schedule, JSON.parse(JSON.stringify(schedule)));
  const settings = Object.freeze({ learningSteps: Object.freeze([1, 10]) });
  const result = rate(schedule, 3, now, settings);
  assert.notEqual(result, schedule);
  assert.equal(schedule.reps, 0);
  assert.equal(schedule.state, 0);
  for (const next of Object.values(preview(schedule, now, settings))) {
    assert.deepEqual(next, JSON.parse(JSON.stringify(next)));
    assert.equal(next.last_review, now);
  }
});

test('reference learning/relearning steps, resets, and graduation', () => {
  const now = local(1);
  const fresh = createSchedule(now);
  const first = preview(fresh, now);
  assert.deepEqual([1, 2, 3].map(r => (first[r].due - now) / MINUTE), [1, 6, 10]);
  const good = first[3];
  assert.equal(good.learning_steps, 1);
  assert.equal(rate(good, 1, good.due).learning_steps, 0);
  assert.equal(rate(good, 3, good.due).state, 2);
  // BasicScheduler advances its learning step before asking for Good's next step.
  assert.equal(rate(first[1], 3, first[1].due).state, 2);
  const lapse = rate(first[4], 1, local(9));
  assert.equal(lapse.state, 3);
  assert.equal(lapse.lapses, 1);
  assert.equal(lapse.due, local(9) + 10 * MINUTE);
  assert.equal(rate(lapse, 1, lapse.due).due, lapse.due + 10 * MINUTE);
  assert.equal(rate(lapse, 2, lapse.due).due, lapse.due + 15 * MINUTE);
  assert.equal(rate(lapse, 3, lapse.due).state, 2);
  assert.equal(rate(lapse, 4, lapse.due).lapses, 1);
});

test('custom numeric steps, changed step counts, and empty steps', () => {
  const now = local(1);
  const schedule = createSchedule(now);
  const settings = { learningSteps: [2, 20, 60], relearningSteps: [5, 30] };
  const good = rate(schedule, 3, now, settings);
  assert.equal(good.due, now + 20 * MINUTE);
  assert.equal(rate(good, 3, good.due, settings).state, 2);
  assert.equal(rate(good, 2, good.due, { learningSteps: [5] }).state, 1);
  assert.equal(rate(schedule, 1, now, { learningSteps: [] }).state, 2);
  const review = rate(schedule, 4, now);
  assert.equal(rate(review, 1, local(9), { relearningSteps: [] }).state, 2);
  const long = rate(schedule, 1, now, { learningSteps: [1500] });
  assert.equal(long.state, 2);
  assert.equal(long.scheduled_days, 1);
  assert.equal(long.due, now + 1500 * MINUTE);
});

test('shortened step lists clamp stale indexes only when graded', () => {
  const now = local(1);
  const settings = { learningSteps: [5], relearningSteps: [7] };
  const learning = Object.freeze({ ...rate(createSchedule(now), 3, now), learning_steps: 5 });
  const originalDue = learning.due;
  const learningHard = rate(learning, 2, originalDue, settings);
  assert.equal(learningHard.state, 1);
  assert.equal(learningHard.learning_steps, 0);
  assert.equal(learningHard.due, originalDue + 8 * MINUTE);
  assert.equal(learning.learning_steps, 5);
  assert.equal(learning.due, originalDue);
  const relearning = Object.freeze({ ...learning, state: 3, learning_steps: 9 });
  const relearningHard = rate(relearning, 2, originalDue, settings);
  assert.equal(relearningHard.state, 3);
  assert.equal(relearningHard.learning_steps, 0);
  assert.equal(relearningHard.due, originalDue + 11 * MINUTE);
  assert.equal(rate(relearning, 1, originalDue, settings).due, originalDue + 7 * MINUTE);
  assert.equal(rate(relearning, 3, originalDue, settings).state, 2);
  assert.equal(rate(relearning, 2, originalDue, { relearningSteps: [] }).state, 2);
});

test('logical dueDay survives changed dayStart while learning remains exact-time', () => {
  const now = local(1);
  const review = rate(createSchedule(now), 4, now);
  assert.equal(review.dueDay, '2026-01-09');
  const dueEpoch = review.due;
  assert.equal(isDue(review, local(9, 5), 6), false);
  assert.equal(isDue(review, local(9, 6), 6), true);
  assert.equal(isDue(review, local(9, 2), 1), true);
  assert.equal(review.due, dueEpoch);
  const lapse = rate(review, 1, local(9));
  assert.equal(Object.hasOwn(lapse, 'dueDay'), false);
  assert.equal(isDue(lapse, lapse.due - 1, 6), false);
  assert.equal(isDue(lapse, lapse.due, 6), true);
});

test('logical dueDay survives timezone changes without changing the stored epoch', () => {
  const modulePath = require.resolve('../src/scheduler.cjs');
  const serialized = execFileSync(process.execPath, ['-e', `
    const { createSchedule, rate } = require(${JSON.stringify(modulePath)});
    const now = +new Date(2026, 0, 1, 12);
    console.log(JSON.stringify(rate(createSchedule(now), 4, now)));
  `], { env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' }).trim();
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { isDue } = require(${JSON.stringify(modulePath)});
    const schedule = ${serialized};
    assert.equal(schedule.dueDay, '2026-01-09');
    assert.equal(schedule.due, Date.UTC(2026, 0, 9, 4));
    assert.equal(isDue(schedule, +new Date(2026, 0, 9, 3, 59)), false);
    assert.equal(isDue(schedule, +new Date(2026, 0, 9, 4)), true);
  `], { env: { ...process.env, TZ: 'America/New_York' } });
});

test('stability, difficulty, retention and interval clamps retain reference ordering', () => {
  const now = local(1);
  const review = { ...createSchedule(now), state: 2, stability: 36500, difficulty: 1, last_review: local(1) };
  const outcomes = preview(review, local(30));
  assert.equal(outcomes[4].stability, 36500);
  assert.equal(outcomes[4].difficulty, 1);
  // Reference applies passing-interval ordering after its 36500-day clamp.
  assert.deepEqual([2, 3, 4].map(r => outcomes[r].scheduled_days), [36500, 36501, 36502]);
  const tiny = { ...review, stability: 0.001, difficulty: 10 };
  assert.equal(rate(tiny, 1, now).stability, 0.001);
  assert.ok(rate(tiny, 1, now).difficulty <= 10);
  const lowRetention = rate(createSchedule(now), 4, now, { retention: 0.7 });
  const highRetention = rate(createSchedule(now), 4, now, { retention: 0.99 });
  assert.ok(lowRetention.scheduled_days > highRetention.scheduled_days);
  assert.equal(rate(createSchedule(now), 4, now, { retention: 1 }).scheduled_days, 1);
  for (const retention of [0, -1, 1.01, NaN, Infinity]) {
    assert.throws(() => rate(review, 3, now, { retention }), /retention/);
  }
});

test('elapsed days follow study dates, are nonnegative, and reviews use local rollover', () => {
  const initial = rate(createSchedule(local(1)), 4, local(1));
  assert.equal(rate(initial, 3, local(2, 3, 59)).elapsed_days, 0);
  const next = rate(initial, 3, local(2, 4));
  assert.equal(next.elapsed_days, 1);
  assert.equal(new Date(next.due).getHours(), 4);
  assert.equal(new Date(next.due).getMinutes(), 0);
  assert.equal(rate(initial, 3, local(1, 10)).elapsed_days, 0);
  assert.equal(isDue(next, next.due - 1), false);
  assert.equal(isDue(next, next.due), true);
  const learning = rate(createSchedule(local(1)), 1, local(1));
  assert.equal(isDue(learning, learning.due - 1), false);
  assert.equal(isDue(learning, learning.due), true);
});

test('weighted cue choice uses latest rating, includes every cue, and returns originals', () => {
  const cues = [1, 2, 3, 4, null].map((latestRating, id) => Object.freeze({ id, latestRating }));
  // Total 13; intervals: [0,4), [4,7), [7,9), [9,10), [10,13).
  for (const [index, sample] of [[0, 0], [0, 3.9], [1, 4], [2, 7], [3, 9], [4, 10], [4, 12.99]]) {
    assert.equal(chooseCue(cues, () => sample / 13), cues[index]);
  }
  const recovered = { latestRating: 4, history: [{ rating: 1 }] };
  assert.equal(chooseCue([recovered, { latestRating: 1 }], () => 0.3).latestRating, 1);
  assert.equal(chooseCue([]), null);
  assert.equal(chooseCue([cues[0]]), cues[0]);
});

test('study days and DST use local civil dates in a deterministic timezone', () => {
  const modulePath = require.resolve('../src/scheduler.cjs');
  const output = execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { studyDay, dayBounds, createSchedule, rate } = require(${JSON.stringify(modulePath)});
    const at = (month, day, hour, minute = 0) => +new Date(2026, month - 1, day, hour, minute);
    assert.equal(studyDay(at(1, 1, 3, 59)), '2025-12-31');
    assert.equal(studyDay(at(1, 1, 4)), '2026-01-01');
    for (const [now, hours] of [[at(3, 7, 12), 23], [at(10, 31, 12), 25]]) {
      const bounds = dayBounds(now);
      assert.equal((bounds.end - bounds.start) / 3600000, hours);
      assert.equal(new Date(bounds.start).getHours(), 4);
      assert.equal(new Date(bounds.end).getHours(), 4);
      const review = rate(createSchedule(now), 4, now);
      const next = rate(review, 3, bounds.end);
      assert.equal(next.elapsed_days, 1);
      assert.equal(new Date(next.due).getHours(), 4);
    }
    // Nonexistent 02:00 rollover normalizes to 03:00 only on the spring-gap date.
    assert.equal(studyDay(at(3, 8, 1), 2), '2026-03-07');
    const gap = dayBounds(at(3, 8, 12), 2);
    assert.equal(new Date(gap.start).getHours(), 3);
    assert.equal(new Date(gap.end).getHours(), 2);
    const spring = rate(createSchedule(at(3, 7, 12)), 4, at(3, 7, 12));
    assert.equal(rate(spring, 3, at(3, 8, 4)).elapsed_days, 1);
    console.log('ok');
  `], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.equal(output.trim(), 'ok');
});

test('invalid ratings, clocks and steps fail explicitly', () => {
  for (const rating of [0, 5, 1.5, '3', NaN]) {
    assert.throws(() => rate(createSchedule(0), rating, 0), /rating/);
  }
  assert.throws(() => createSchedule(NaN), /timestamp/);
  assert.throws(() => studyDay(0, 24), /dayStart/);
  for (const steps of [[0], [-1], [NaN], ['1m'], 'bad']) {
    assert.throws(() => rate(createSchedule(0), 1, 0, { learningSteps: steps }), /steps/);
  }
  assert.throws(() => rate({ state: 9 }, 1, 0), /state/);
});
