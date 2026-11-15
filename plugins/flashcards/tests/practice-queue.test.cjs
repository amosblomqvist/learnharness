const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let buildPracticeCards;
test.before(async () => {
  ({ buildPracticeCards } = await import(`data:text/javascript;base64,${fs.readFileSync(path.join(__dirname, '../src/practice-queue.js')).toString('base64')}`));
});
function state() {
  const cue = id => ({ id, question: `Question ${id}`, answer: `Answer ${id}` });
  return {
    decks: [{ id: 'a', propositionIds: ['p2', 'p1', 'archived', 'missing'] }, { id: 'b', propositionIds: ['p1'] }, { id: 'empty', propositionIds: [] }],
    propositions: [
      { id: 'p1', name: 'One', archived: false, cues: [cue('c1'), { ...cue('deleted'), deleted: true }, cue('c2')], schedule: { state: 2, due: Date.now() + 86400000 } },
      { id: 'p2', name: 'Two', archived: false, cues: [cue('c3')], schedule: { state: 0 } },
      { id: 'archived', name: 'Archived', archived: true, cues: [cue('old')] },
    ],
  };
}
const ids = cards => cards.map(c => c.cueId);
test('practice snapshots all active cues once in saved deck/proposition/cue order, regardless of schedule', () => {
  assert.deepEqual(ids(buildPracticeCards(state())), ['c3', 'c1', 'c2']);
  const reordered = state(); reordered.decks.reverse();
  assert.deepEqual(ids(buildPracticeCards(reordered)), ['c1', 'c2', 'c3']);
  reordered.propositions[0].cues.reverse();
  assert.deepEqual(ids(buildPracticeCards(reordered)), ['c2', 'c1', 'c3']);
  const reorderedPropositions = state(); reorderedPropositions.decks[0].propositionIds.reverse();
  assert.deepEqual(ids(buildPracticeCards(reorderedPropositions)), ['c1', 'c2', 'c3']);
});
test('practice scopes strictly intersect and empty or unknown filters never widen', () => {
  const s = state();
  assert.deepEqual(ids(buildPracticeCards(s, { deckIds: ['b'] })), ['c1', 'c2']);
  assert.deepEqual(ids(buildPracticeCards(s, { propositionIds: ['p1'], cueIds: ['c2'] })), ['c2']);
  assert.deepEqual(ids(buildPracticeCards(s, { deckIds: ['b'], cueIds: ['c3'] })), []);
  for (const field of ['deckIds', 'propositionIds', 'cueIds']) {
    assert.deepEqual(buildPracticeCards(s, { [field]: [] }), []);
    assert.deepEqual(buildPracticeCards(s, { [field]: ['unknown'] }), []);
  }
  assert.deepEqual(buildPracticeCards(s, { cueIds: ['old', 'deleted'] }), []);
  assert.deepEqual(buildPracticeCards(s, { deckIds: ['empty'] }), []);
  assert.deepEqual(buildPracticeCards(null), []);
});
test('practice copies only presentation strings/IDs and never mutates the library, schedules or memberships', () => {
  const s = state(), original = structuredClone(s), cards = buildPracticeCards(s);
  assert.deepEqual(s, original);
  assert.deepEqual(Object.keys(cards[0]).sort(), ['answer', 'cueId', 'propositionId', 'propositionName', 'question']);
  s.propositions[1].cues[0].answer = 'Changed after opening';
  s.propositions[1].name = 'Renamed after opening';
  assert.equal(cards[0].answer, 'Answer c3');
  assert.equal(cards[0].propositionName, 'Two');
  cards[1].question = 'Practice-local change';
  assert.equal(s.propositions[0].cues[0].question, 'Question c1');
});
