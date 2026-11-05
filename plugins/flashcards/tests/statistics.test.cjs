'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { statistics } = require('../src/statistics.cjs');
const at = (day, hour = 12, minute = 0) => +new Date(2026, 0, day, hour, minute);
const proposition = (id, state, due, extra = {}) => ({ id, cues: [{ id: `${id}-cue` }], schedule: { state, due, ...extra } });
const fixture = (...props) => ({ settings: { dayStart: 4 }, propositions: Object.fromEntries(props.map(p => [p.id, p])), reviews: [], decks: [] });
const liveIds = state => new Set(Object.keys(state.propositions));
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }

test('empty statistics expose stable zero-valued categories and chronological windows ending at the current study day', () => {
  const result = statistics(fixture(), new Set(), at(2, 3, 59));
  assert.deepEqual(result.states, { new: 0, learning: 0, review: 0, relearning: 0 });
  assert.equal(result.due.length, 9);
  assert.deepEqual(result.due.map(row => row.day), [null, '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08']);
  assert.equal(result.activity.length, 14);
  assert.equal(result.activity[0].day, '2025-12-19');
  assert.equal(result.activity.at(-1).day, '2026-01-01');
  assert.ok([...result.due, ...result.activity].every(row => row.count === 0));
});

test('current states count unique live propositions with active cues, regardless of shared deck memberships', () => {
  const state = fixture(proposition('new', 0, at(1)), proposition('learning', 1, at(2)), proposition('review', 2, at(2)), proposition('relearning', 3, at(2)), proposition('archived', 2, at(1)), proposition('deleted', 1, at(1)), proposition('empty', 0, at(1)));
  state.propositions.review.cues.push({ id: 'second-cue' });
  state.propositions.deleted.cues[0].deleted = true;
  state.propositions.empty.cues = [];
  state.decks = [{ propositionIds: ['new', 'review'] }, { propositionIds: ['new', 'review'] }];
  const live = liveIds(state); live.delete('archived');
  const before = structuredClone(state);
  const result = statistics(freeze(state), live, at(2));
  assert.deepEqual(result.states, { new: 1, learning: 1, review: 1, relearning: 1 });
  assert.equal(result.due[1].count, 3);
  assert.equal(result.due[0].count, 0);
  assert.deepEqual(state, before);
  assert.deepEqual(Object.keys(result).sort(), ['activity', 'due', 'states']);
  assert.equal(JSON.stringify(result).includes('second-cue'), false);
});

test('due buckets use canonical review dueDay, civil-day overdue boundaries, and epoch fallback for learning/relearning/older reviews', () => {
  const state = fixture(
    proposition('new', 0, at(1)),
    proposition('canonical-today', 2, at(30), { dueDay: '2026-01-15' }),
    proposition('canonical-overdue', 2, at(30), { dueDay: '2026-01-14' }),
    proposition('canonical-future', 2, at(1), { dueDay: '2026-01-22' }),
    proposition('beyond-window', 2, at(1), { dueDay: '2026-01-23' }),
    proposition('learning-earlier-today', 1, at(15, 4)),
    proposition('learning-later-today', 1, at(16, 3, 59)),
    proposition('learning-overdue', 1, at(15, 3, 59)),
    proposition('relearning-tomorrow', 3, at(16, 4), { dueDay: '2026-01-01' }),
    proposition('legacy-review', 2, at(17, 4)),
  );
  const result = statistics(state, liveIds(state), at(15));
  assert.deepEqual(result.due.map(row => row.count), [2, 3, 1, 1, 0, 0, 0, 0, 1]);
  assert.equal(result.due[1].day, '2026-01-15');
  assert.equal(result.due.at(-1).day, '2026-01-22');
  assert.deepEqual(result.states, { new: 1, learning: 3, review: 5, relearning: 1 });
});

test('activity counts actual review records across 14 study days, retaining archived/deleted history and repeated learning attempts', () => {
  const state = fixture(proposition('deleted', 1, at(15)));
  state.propositions.deleted.cues[0].deleted = true;
  state.reviews = [
    { propositionId: 'archived', at: at(2, 4), question: 'Do not expose history', introduced: true },
    { propositionId: 'deleted', at: at(15, 3, 59) },
    { propositionId: 'deleted', at: at(15, 4) },
    { propositionId: 'deleted', at: at(15, 5) },
    { propositionId: 'deleted', at: at(15, 6) },
    { propositionId: 'too-old', at: at(2, 3, 59) },
    { propositionId: 'future', at: at(16, 4) },
  ];
  const result = statistics(state, liveIds(state), at(15));
  assert.deepEqual(result.states, { new: 0, learning: 0, review: 0, relearning: 0 });
  assert.equal(result.activity[0].day, '2026-01-02');
  assert.equal(result.activity[0].count, 1);
  assert.equal(result.activity.at(-2).count, 1);
  assert.equal(result.activity.at(-1).count, 3);
  assert.equal(result.activity.reduce((n, row) => n + row.count, 0), 5);
  assert.equal(JSON.stringify(result).includes('Do not expose history'), false);
});

test('statistics windows and epoch buckets remain correct through spring/fall DST and nonexistent rollover hours', () => {
  const modulePath = require.resolve('../src/statistics.cjs');
  const output = execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { statistics } = require(${JSON.stringify(modulePath)});
    const at = (month, day, hour, minute = 0) => +new Date(2026, month - 1, day, hour, minute);
    for (const [month, day, prefix] of [[3, 7, '2026-03-'], [10, 31, '2026-11-']]) {
      const now = at(month, day, 12), next = new Date(now); next.setDate(next.getDate() + 1);
      const dayStart = 4;
      const state = { settings: { dayStart }, propositions: { p: { id: 'p', cues: [{}], schedule: { state: 1, due: +new Date(next.getFullYear(), next.getMonth(), next.getDate(), 4) } } }, reviews: [{ at: now }, { at: +next }] };
      const result = statistics(state, new Set(['p']), now);
      assert.equal(result.due[2].day, prefix + '0' + (month === 3 ? 8 : 1));
      assert.equal(result.due[2].count, 1);
      assert.equal(new Set(result.due.slice(1).map(row => row.day)).size, 8);
      assert.equal(new Set(result.activity.map(row => row.day)).size, 14);
      assert.equal(result.activity.at(-1).count, 1);
    }
    const state = { settings: { dayStart: 2 }, propositions: { p: { id: 'p', cues: [{}], schedule: { state: 3, due: at(3, 8, 1, 59) } } }, reviews: [{ at: at(3, 8, 1, 59) }, { at: at(3, 8, 3) }] };
    const gap = statistics(state, new Set(['p']), at(3, 8, 12));
    assert.equal(gap.due[1].day, '2026-03-08');
    assert.equal(gap.due[2].day, '2026-03-09');
    assert.equal(gap.due[0].count, 1);
    assert.equal(gap.activity.at(-2).count, 1);
    assert.equal(gap.activity.at(-1).count, 1);
    state.settings.dayStart = 23;
    const lateRollover = statistics(state, new Set(), at(3, 8, 12));
    assert.equal(lateRollover.due[1].day, '2026-03-07');
    assert.equal(lateRollover.activity.at(-1).day, '2026-03-07');
    console.log('ok');
  `], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.equal(output.trim(), 'ok');
});
