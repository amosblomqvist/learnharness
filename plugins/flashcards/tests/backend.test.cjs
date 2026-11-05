'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { activate, pack, estimate } = require('../src/backend.cjs');
const { defaults } = require('../src/store.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
const node = (id, source = 'source') => ({ id, name: `Fact ${id}`, statement: `Statement ${id}`, provenance: [{ chatId: source }] });
const graph = (...ids) => ({ propositions: ids.map(id => node(id)), chains: [], sessions: { source: 'Source lesson' }, fileSources: {} });
const cards = (id, ...questions) => ({ propositionId: id, cards: questions.map(question => ({ question, answer: `Answer: ${question}` })) });
const result = (...rows) => ({ propositions: rows });

// In-memory durable worker service: activation-local registrations/observers,
// persistent tasks, explicit accepted-result validation, and no model execution.
function workerService() {
  const tasks = new Map(), subscriptions = new Map(), waiters = new Map();
  let definition, starts = 0;
  const terminal = task => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.status);
  const emit = task => {
    for (const listener of subscriptions.get(task.id) ?? []) listener(structuredClone(task));
    if (terminal(task)) for (const done of [...(waiters.get(task.id) ?? [])]) done();
  };
  const service = {
    register(value) { definition = value; return () => {}; },
    start(workerId, options) {
      assert.equal(workerId, definition.id);
      assert.equal(options.purpose, 'user');
      assert.ok(options.requestId);
      const prior = [...tasks.values()].find(task => task.requestId === options.requestId);
      if (prior) return structuredClone(prior);
      starts++;
      const task = { id: randomUUID(), requestId: options.requestId, input: structuredClone(options.input), status: 'running', turns: 0, activity: 'waiting' };
      tasks.set(task.id, task);
      return structuredClone(task);
    },
    list: () => structuredClone([...tasks.values()]),
    get(id) { const task = tasks.get(id); assert.ok(task, `Unknown task ${id}`); return structuredClone(task); },
    subscribe(id, listener) {
      const listeners = subscriptions.get(id) ?? new Set(); subscriptions.set(id, listeners); listeners.add(listener);
      return () => listeners.delete(listener);
    },
    wait(id, signal) {
      if (terminal(tasks.get(id))) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const pending = waiters.get(id) ?? new Set(); waiters.set(id, pending);
        const cleanup = () => { pending.delete(done); signal.removeEventListener('abort', abort); };
        const done = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(new Error('Activation disposed')); };
        pending.add(done); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    },
    // Cancellation is a request, not proof a provider stopped: allow a late result.
    cancel(id) { tasks.get(id).cancelRequested = true; },
  };
  return {
    service, tasks, get starts() { return starts; },
    stage(id, value) {
      const task = tasks.get(id);
      definition.validateResult(value, { input: task.input });
      task.result = structuredClone(value); emit(task);
    },
    complete(id, value, status = 'succeeded') {
      const task = tasks.get(id);
      if (status === 'succeeded') definition.validateResult(value, { input: task.input });
      task.status = status;
      if (status === 'succeeded') task.result = structuredClone(value);
      else task.error = { message: 'Synthetic worker failure' };
      emit(task);
    },
  };
}

function harness(t, initialGraph = graph('p1')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flashcards-test-'));
  const workers = workerService();
  const h = { graph: initialGraph, workers, directory, catalog: {
    slots: { cheap: { model: { provider: 'mock', id: 'cheap' }, thinkingLevel: 'off' } },
    models: [{ provider: 'mock', id: 'cheap', name: 'Mock cheap', supportedLevels: ['off', 'low'], contextWindow: 100000, maxTokens: 8192 }],
  } };
  let handlers, controller, cleanups = [];
  h.dispose = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); controller?.abort(); };
  h.activate = () => {
    h.dispose(); handlers = new Map(); controller = new AbortController();
    activate({ dataDirectory: directory, signal: controller.signal,
      workers: workers.service, learning: { graph: () => structuredClone(h.graph) },
      inference: { catalog: async () => structuredClone(h.catalog) },
      events: { emit() {} }, handle: (name, handler) => handlers.set(name, handler),
      cleanup: fn => { assert.equal(typeof fn, 'function'); cleanups.push(fn); },
    });
  };
  h.call = async (name, input = {}) => { assert.ok(handlers.has(name), name); return handlers.get(name)(input); };
  h.state = () => handlers.get('get-state')({});
  h.disk = () => JSON.parse(fs.readFileSync(path.join(directory, 'flashcards.json'), 'utf8'));
  h.start = async (ids, requestId = randomUUID()) => {
    const plan = await h.call('preflight', { propositionIds: ids });
    await h.call('start-generation', { preflightId: plan.id, requestId });
    await flush();
    const batch = h.state().batch;
    return batch.chunks.map(chunk => workers.service.list().find(task => task.requestId === chunk.requestId));
  };
  h.complete = async (task, value, status) => { workers.complete(task.id, value, status); await flush(); };
  h.generate = async (...rows) => {
    const tasks = await h.start(rows.map(row => row.propositionId));
    for (const task of tasks) await h.complete(task, result(...rows.filter(row => task.input.targets.includes(row.propositionId))));
    return h.state();
  };
  h.grade = async (scope, rating = 4, requestId = randomUUID()) => {
    const { ticket } = await h.call('next-review', scope);
    assert.ok(ticket);
    await h.call('reveal-review', { ticketId: ticket.id });
    await h.call('rate-review', { ticketId: ticket.id, rating, requestId });
    return ticket;
  };
  h.activate();
  t.after(() => { h.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return h;
}

test('clearing overrides follows cheap configuration and unrelated generation settings do not stale reviews', async t => {
  const h = harness(t);
  await h.generate(cards('p1', 'A cue'));
  const { ticket } = await h.call('next-review');
  await h.call('save-settings', { thinkingOverride: 'low' });
  await h.call('save-settings', { modelOverride: null, thinkingOverride: null, chunkBudget: 5000 });
  assert.equal(Object.hasOwn(h.state().settings, 'thinkingOverride'), false);
  await h.call('reveal-review', { ticketId: ticket.id });
  await h.call('rate-review', { ticketId: ticket.id, rating: 4, requestId: 'stable-rating' });
  await assert.rejects(h.call('rate-review', { ticketId: ticket.id, rating: 1, requestId: 'stable-rating' }), /different work/);
  assert.equal(h.state().propositions[0].schedule.reps, 1);
});

test('same accepted generation request is reused but changed preflight identity is rejected', async t => {
  const h = harness(t);
  const plan = await h.call('preflight', { propositionIds: ['p1'] });
  const input = { preflightId: plan.id, requestId: 'same-generation' };
  await h.call('start-generation', input);
  await flush();
  await h.call('start-generation', input);
  assert.equal(h.workers.starts, 1);
  await assert.rejects(h.call('start-generation', { ...input, preflightId: 'different-plan' }), /different work/);
});

test('reordering skips deleted cues and archived propositions', async t => {
  const h = harness(t, graph('p1', 'p2', 'p3'));
  await h.generate(cards('p1', 'First', 'Deleted', 'Last'), cards('p2', 'Middle'), cards('p3', 'Third'));
  const first = h.state().propositions.find(p => p.id === 'p1');
  await h.call('delete-cue', { propositionId: 'p1', cueId: first.cues[1].id, version: first.version });
  await h.call('reorder', { kind: 'cue', propositionId: 'p1', id: first.cues[2].id, direction: -1 });
  assert.deepEqual(h.state().propositions.find(p => p.id === 'p1').cues.filter(c => !c.deleted).map(c => c.question), ['Last', 'First']);
  h.graph.propositions = h.graph.propositions.filter(p => p.id !== 'p2');
  const deckId = h.state().decks[0].id;
  await h.call('reorder', { kind: 'proposition', deckId, id: 'p3', direction: -1 });
  assert.deepEqual(h.state().decks[0].propositionIds, ['p3', 'p2', 'p1']);
});

test('packing includes complete immediate chains and active/deleted cues, not recursive context', () => {
  const g = graph('a', 'b', 'c', 'd', 'e', 'f', 'g');
  g.chains = [{ id: 'ab-c', premises: ['a', 'b'], conclusion: 'c' },
    { id: 'cd-e', premises: ['c', 'd'], conclusion: 'e' }, { id: 'ef-g', premises: ['e', 'f'], conclusion: 'g' }];
  const state = { settings: { ...defaults(), chunkBudget: 100000 }, propositions: {
    c: { cues: [{ question: 'Manual cue', answer: 'Edited answer' }, { question: 'Deleted cue', answer: 'Old answer', deleted: true }] },
  } };
  const [input] = pack(g, ['c', 'c'], state);
  assert.deepEqual(input.targets, ['c']);
  assert.deepEqual(input.chains.map(c => c.id), ['ab-c', 'cd-e']);
  assert.deepEqual(new Set(input.propositions.map(p => p.id)), new Set(['a', 'b', 'c', 'd', 'e']));
  assert.deepEqual(input.chains[0].premises, ['a', 'b']);
  assert.deepEqual(input.cards, [{ propositionId: 'c', active: [{ question: 'Manual cue', answer: 'Edited answer' }], deleted: [{ question: 'Deleted cue', answer: 'Old answer' }] }]);
  assert.equal(input.sources[0].label, 'Source lesson');
  assert.throws(() => pack(g, [], state), /Select at least one/);
  assert.throws(() => pack(g, ['missing'], state), /no longer in the graph/);
  assert.throws(() => pack({ ...g, propositions: g.propositions.filter(p => p.id !== 'b') }, ['c'], state), /Incomplete reasoning chain: b/);
  assert.throws(() => pack(g, ['c'], { ...state, settings: { ...state.settings, chunkBudget: estimate(input) - 1 } }), /needs approximately/);
});

test('generation applies only accepted terminal success; invalid submissions repair and zero cards create no deck', async t => {
  const h = harness(t);
  const [task] = await h.start(['p1']);
  assert.throws(() => h.workers.stage(task.id, result()), /Missing targets/);
  assert.throws(() => h.workers.stage(task.id, result(cards('other', 'Wrong target'))), /Unknown or repeated/);
  h.workers.stage(task.id, result(cards('p1', 'A useful cue')));
  await flush();
  assert.equal(h.state().propositions.length, 0);
  assert.equal(h.state().batch.status, 'running');
  await h.complete(task, result(cards('p1', 'A useful cue')));
  assert.equal(h.state().propositions[0].cues.length, 1);
  assert.equal(h.state().batch.status, 'completed');
  await h.call('resume-results');
  assert.equal(h.state().propositions[0].cues.length, 1);
  const empty = harness(t, graph('empty'));
  await empty.generate(cards('empty'));
  assert.equal(empty.state().batch.status, 'completed');
  assert.equal(empty.state().batch.added, 0);
  assert.deepEqual(empty.state().decks, []);
  assert.deepEqual(empty.state().propositions, []);
});

test('independent chunks accept successful work despite another failure', async t => {
  const g = graph('p1', 'p2');
  for (const p of g.propositions) p.statement = 'Context '.repeat(200);
  const h = harness(t, g);
  const [single] = pack(g, ['p1'], { settings: { ...defaults(), chunkBudget: 100000 }, propositions: {} });
  await h.call('save-settings', { chunkBudget: estimate(single) + 10 });
  const tasks = await h.start(['p1', 'p2']);
  assert.equal(tasks.length, 2);
  await h.complete(tasks[0], result(cards(tasks[0].input.targets[0], 'Accepted cue')));
  assert.equal(h.state().propositions.length, 1);
  assert.equal(h.state().batch.status, 'running');
  h.workers.stage(tasks[1].id, result(cards(tasks[1].input.targets[0], 'Unaccepted final outcome')));
  await h.complete(tasks[1], null, 'failed');
  assert.equal(h.state().batch.status, 'partial');
  assert.equal(h.state().batch.added, 1);
  assert.deepEqual(h.state().batch.failedTargetIds, tasks[1].input.targets);
});

test('regeneration supplies existing/deleted context and preserves manual edits, memberships and schedule', async t => {
  const h = harness(t);
  await h.generate(cards('p1', 'Original', 'Do not recreate'));
  let p = h.state().propositions[0];
  await h.call('save-cue', { propositionId: p.id, cueId: p.cues[0].id, version: p.version, question: 'Manually edited', answer: 'Manual answer' });
  p = h.state().propositions[0];
  await h.call('delete-cue', { propositionId: p.id, cueId: p.cues[1].id, version: p.version });
  await h.call('create-deck', { name: 'Custom' });
  const deckIds = h.state().decks.map(d => d.id);
  await h.call('set-memberships', { propositionId: p.id, deckIds });
  await h.grade({ propositionIds: ['p1'] });
  const before = h.state().propositions[0];
  const [task] = await h.start(['p1']);
  assert.deepEqual(task.input.cards[0].active, [{ question: 'Manually edited', answer: 'Manual answer' }]);
  assert.equal(task.input.cards[0].deleted[0].question, 'Do not recreate');
  assert.throws(() => h.workers.stage(task.id, result(cards('p1', 'Do not recreate'))), /Duplicate or deleted/);
  await h.complete(task, result(cards('p1', 'Distinct new cue')));
  const after = h.state().propositions[0];
  assert.deepEqual(after.schedule, before.schedule);
  assert.deepEqual(after.memberships, before.memberships);
  assert.equal(after.firstReviewedAt, before.firstReviewedAt);
  assert.deepEqual(after.cues.slice(0, 2), before.cues);
  assert.equal(after.cues.length, 3);
  assert.equal(h.disk().reviews.length, 1);
});

test('review hides answer until reveal, requires reveal, and grading is idempotent', async t => {
  const h = harness(t);
  await h.generate(cards('p1', 'Question'));
  const { ticket } = await h.call('next-review');
  assert.ok(ticket.question);
  assert.equal(Object.hasOwn(ticket, 'answer'), false);
  assert.equal(JSON.stringify(ticket).includes('Answer:'), false);
  const requestId = randomUUID();
  await assert.rejects(h.call('rate-review', { ticketId: ticket.id, rating: 3, requestId }), /Reveal/);
  const revealed = await h.call('reveal-review', { ticketId: ticket.id });
  assert.equal(revealed.answer, 'Answer: Question');
  assert.deepEqual(Object.keys(revealed.intervals), ['1', '2', '3', '4']);
  await h.call('rate-review', { ticketId: ticket.id, rating: 3, requestId });
  const after = h.state();
  await h.call('rate-review', { ticketId: ticket.id, rating: 3, requestId });
  assert.deepEqual(h.state(), after);
  assert.equal(h.disk().reviews.length, 1);
});

test('review tickets invalidate when card content or scheduling settings change', async t => {
  const h = harness(t);
  await h.generate(cards('p1', 'Original question'));
  const { ticket } = await h.call('next-review');
  const p = h.state().propositions[0];
  await h.call('save-cue', { propositionId: p.id, cueId: p.cues[0].id, question: 'Changed question', answer: 'Changed answer', version: p.version });
  await assert.rejects(h.call('reveal-review', { ticketId: ticket.id }), /changed elsewhere/);
  const next = (await h.call('next-review')).ticket;
  await h.call('reveal-review', { ticketId: next.id });
  await h.call('save-settings', { retention: .95 });
  await assert.rejects(h.call('rate-review', { ticketId: next.id, rating: 4, requestId: randomUUID() }), /changed elsewhere/);
  assert.equal(h.disk().reviews.length, 0);
});

test('shared schedules charge every containing deck but admission uses only the studied deck; due is uncapped', async t => {
  let now = +new Date(2026, 0, 2, 12);
  t.mock.method(Date, 'now', () => now);
  const h = harness(t, graph('p1', 'p2'));
  await h.generate(cards('p1', 'One cue'), cards('p2', 'Another cue'));
  const source = h.state().decks[0];
  await h.call('save-deck', { id: source.id, name: source.name, newLimit: 1 });
  await h.call('create-deck', { name: 'Shared' });
  const shared = h.state().decks.find(d => d.name === 'Shared');
  await h.call('save-deck', { id: shared.id, name: shared.name, newLimit: 0 });
  await h.call('set-memberships', { propositionId: 'p1', deckIds: [source.id, shared.id] });
  const first = await h.grade({ deckIds: [source.id] }, 1);
  assert.equal(first.propositionId, 'p1');
  assert.deepEqual(h.state().decks.map(d => d.newToday), [1, 1]);
  assert.equal((await h.call('next-review', { deckIds: [source.id] })).ticket, null);
  now += 60000;
  const repeated = await h.grade({ deckIds: [shared.id] }, 4);
  assert.equal(repeated.propositionId, 'p1');
  assert.equal(repeated.cueId, first.cueId);
  assert.equal(h.state().propositions.find(p => p.id === 'p1').schedule.reps, 2);
  assert.deepEqual(h.state().decks.map(d => d.newToday), [1, 1]);
  await h.call('set-memberships', { propositionId: 'p2', deckIds: [source.id, shared.id] });
  await h.call('save-deck', { id: shared.id, name: shared.name, newLimit: 2 });
  assert.equal((await h.grade({ deckIds: [shared.id] })).propositionId, 'p2');
  assert.deepEqual(h.state().decks.map(d => d.newToday), [2, 2]);
  assert.deepEqual(h.disk().reviews.filter(r => r.introduced).map(r => r.deckIds), [[source.id, shared.id], [source.id, shared.id]]);
  await h.call('save-deck', { id: shared.id, name: shared.name, newLimit: 0 });
  now += 20 * 86400000;
  assert.ok((await h.call('next-review', { deckIds: [shared.id] })).ticket);
});

test('cue-filtered new review intersects deck/proposition scope and chooses only selected active cues', async t => {
  const h = harness(t, graph('p1', 'p2'));
  await h.generate(cards('p1', 'Unselected', 'Selected one', 'Selected two'), cards('p2', 'Other proposition'));
  const [p1, p2] = h.state().propositions;
  const random = t.mock.method(Math, 'random', () => 0);
  const scope = { deckIds: [h.state().decks[0].id], propositionIds: ['p1'], cueIds: [p1.cues[1].id, p1.cues[2].id, p2.cues[0].id] };
  assert.equal((await h.call('next-review', scope)).ticket.cueId, p1.cues[1].id);
  random.mock.mockImplementation(() => .999);
  const { ticket } = await h.call('next-review', scope);
  assert.equal(ticket.cueId, p1.cues[2].id);
  assert.deepEqual(await h.call('next-review', { ...scope, cueIds: [p2.cues[0].id] }), { ticket: null, remaining: 0 });
  await h.call('create-deck', { name: 'Empty' });
  const empty = h.state().decks.find(d => d.name === 'Empty');
  assert.equal((await h.call('next-review', { ...scope, deckIds: [empty.id] })).ticket, null);
  // Tickets retain the original selection, rather than the caller's mutable arrays.
  scope.cueIds.splice(0, scope.cueIds.length, p1.cues[0].id);
  scope.propositionIds.length = 0; scope.deckIds.length = 0;
  assert.equal((await h.call('reveal-review', { ticketId: ticket.id })).answer, 'Answer: Selected two');
  await h.call('rate-review', { ticketId: ticket.id, rating: 4, requestId: 'filtered-new' });
  assert.equal(h.disk().reviews[0].cueId, p1.cues[2].id);
  assert.equal(h.disk().reviews[0].introduced, true);
});

test('normal due review retains weighted choice within the selected cue pool and never forces an early review', async t => {
  let now = +new Date(2026, 0, 2, 12);
  t.mock.method(Date, 'now', () => now);
  const h = harness(t);
  await h.generate(cards('p1', 'Reviewed easy', 'Excluded untried', 'Selected untried'));
  const p = h.state().propositions[0], [easy, excluded, untried] = p.cues;
  await h.grade({ cueIds: [easy.id] }, 4);
  assert.equal((await h.call('next-review', { cueIds: [untried.id] })).ticket, null);
  now += 30 * 86400000;
  const before = h.state().propositions[0].schedule;
  const random = t.mock.method(Math, 'random', () => .2);
  const scope = { cueIds: [easy.id, untried.id] };
  // Easy has weight 1, untried weight 3: the boundary is 1/4, not 1/7.
  assert.equal((await h.call('next-review', scope)).ticket.cueId, easy.id);
  random.mock.mockImplementation(() => .3);
  assert.equal((await h.call('next-review', scope)).ticket.cueId, untried.id);
  assert.deepEqual(h.state().propositions[0].schedule, before);
  const ticket = await h.grade(scope, 4);
  assert.equal(ticket.cueId, untried.id);
  assert.equal(h.state().propositions[0].cues.find(c => c.id === excluded.id).latestRating, null);
  assert.equal(h.state().propositions[0].schedule.reps, 2);
  assert.deepEqual(h.disk().reviews.map(r => [r.cueId, r.introduced]), [[easy.id, true], [untried.id, false]]);
});

test('cue filters are strict for empty, unknown, deleted or archived selections and reject invalid shapes', async t => {
  const h = harness(t, graph('p1', 'p2'));
  await h.generate(cards('p1', 'Deleted', 'Active'), cards('p2', 'Other'));
  const p = h.state().propositions[0];
  await h.call('delete-cue', { propositionId: p.id, cueId: p.cues[0].id, version: p.version });
  const before = h.disk();
  for (const cueIds of [[], ['missing'], [p.cues[0].id]]) {
    assert.deepEqual(await h.call('next-review', { cueIds }), { ticket: null, remaining: 0 });
  }
  for (const cueIds of [null, p.cues[1].id, {}, [1], [p.cues[1].id, false], [[p.cues[1].id]]]) {
    await assert.rejects(h.call('next-review', { cueIds }), /Invalid cue selection/);
  }
  for (const scope of [{ deckIds: [] }, { propositionIds: [] }]) {
    assert.equal((await h.call('next-review', { ...scope, cueIds: [p.cues[1].id] })).ticket, null);
  }
  h.graph.propositions = h.graph.propositions.filter(p => p.id !== 'p1');
  assert.equal((await h.call('next-review', { cueIds: [p.cues[1].id] })).ticket, null);
  assert.ok((await h.call('next-review')).ticket);
  assert.deepEqual(h.disk(), before);
});

for (const mode of ['learning', 'relearning']) test(`${mode} cue filtering skips active excluded pins, including nextDue, but deleted pins fall back to selected cues`, async t => {
  let now = +new Date(2026, 0, 2, 12);
  t.mock.method(Date, 'now', () => now);
  const h = harness(t, graph('p1', 'p2'));
  await h.generate(cards('p1', 'Pinned', 'Excluded fallback', 'Selected fallback'), cards('p2', 'New proposition'));
  const [initial, other] = h.state().propositions;
  const [pinned, excluded, fallback] = initial.cues;
  if (mode === 'relearning') {
    await h.grade({ cueIds: [pinned.id] }, 4);
    now += 30 * 86400000;
  }
  await h.grade({ cueIds: [pinned.id] }, 1);
  const p = h.state().propositions[0], due = p.schedule.due;
  assert.equal(p.schedule.state, mode === 'learning' ? 1 : 3);
  assert.equal(p.learningCueId, pinned.id);
  assert.deepEqual(await h.call('next-review', { cueIds: [fallback.id] }), { ticket: null, remaining: 0 });
  assert.deepEqual(await h.call('next-review', { cueIds: [] }), { ticket: null, remaining: 0 });
  assert.equal((await h.call('next-review', { cueIds: [pinned.id] })).nextDue, due);
  assert.equal((await h.call('next-review', { propositionIds: ['p1'] })).nextDue, due);
  now = due;
  const before = h.disk();
  assert.equal((await h.call('next-review', { cueIds: [fallback.id] })).ticket, null);
  assert.equal((await h.call('next-review', { propositionIds: ['p1'] })).ticket.cueId, pinned.id);
  assert.equal((await h.call('next-review', { cueIds: [pinned.id, fallback.id] })).ticket.cueId, pinned.id);
  assert.equal((await h.call('next-review', { cueIds: [fallback.id, other.cues[0].id] })).ticket.propositionId, 'p2');
  assert.deepEqual(h.disk(), before);
  await h.call('delete-cue', { propositionId: 'p1', cueId: pinned.id, version: p.version });
  const ticket = await h.grade({ cueIds: [fallback.id] }, 1);
  assert.equal(ticket.cueId, fallback.id);
  const after = h.state().propositions[0];
  assert.equal(after.learningCueId, fallback.id);
  assert.equal(after.cues.find(c => c.id === excluded.id).latestRating, null);
  assert.equal(after.schedule.reps, p.schedule.reps + 1);
  assert.equal(h.disk().reviews.filter(r => r.introduced).length, 1);
});

test('filtered cues share one proposition schedule, history and introduction across decks', async t => {
  let now = +new Date(2026, 0, 2, 12);
  t.mock.method(Date, 'now', () => now);
  const h = harness(t);
  await h.generate(cards('p1', 'First cue', 'Second cue'));
  await h.call('create-deck', { name: 'Shared' });
  const [source, shared] = h.state().decks, p = h.state().propositions[0];
  await h.call('set-memberships', { propositionId: p.id, deckIds: [source.id, shared.id] });
  await h.grade({ deckIds: [source.id], cueIds: [p.cues[0].id] }, 4);
  assert.deepEqual(h.state().decks.map(d => d.newToday), [1, 1]);
  assert.equal((await h.call('next-review', { deckIds: [shared.id], cueIds: [p.cues[1].id] })).ticket, null);
  now += 30 * 86400000;
  await h.grade({ deckIds: [shared.id], cueIds: [p.cues[1].id] }, 4);
  assert.equal(h.state().propositions.length, 1);
  assert.equal(h.state().propositions[0].schedule.reps, 2);
  assert.deepEqual(h.state().decks.map(d => d.newToday), [0, 0]);
  const reviews = h.disk().reviews;
  assert.deepEqual(reviews.map(r => r.introduced), [true, false]);
  assert.deepEqual(reviews[0].deckIds, [source.id, shared.id]);
  assert.deepEqual(reviews[1].before, reviews[0].after);
});

test('partial deck renames preserve the latest limit and limit-only patches preserve the latest name', async t => {
  const h = harness(t);
  await h.call('create-deck', { name: 'Original' });
  const original = h.state().decks[0];
  await h.call('save-deck', { id: original.id, name: 'Full update', newLimit: 7 });
  await h.call('save-deck', { id: original.id, newLimit: 37 });
  await h.call('save-deck', { id: original.id, name: '  Inline rename  ' });
  let d = h.state().decks[0];
  assert.equal(d.name, 'Inline rename');
  assert.equal(d.newLimit, 37);
  await h.call('save-deck', { id: original.id, newLimit: 0 });
  d = h.state().decks[0];
  assert.equal(d.name, 'Inline rename');
  assert.equal(d.newLimit, 0);
  const before = h.disk();
  for (const patch of [{ name: '' }, { newLimit: -1 }, { newLimit: '2' }, { name: 'Do not save', newLimit: null }]) {
    await assert.rejects(h.call('save-deck', { id: original.id, ...patch }));
    assert.deepEqual(h.disk(), before);
  }
  h.activate();
  assert.deepEqual(h.state().decks[0], d);
});

test('remaining includes current new propositions up to the daily cap, without writes or extra cue choices', async t => {
  t.mock.method(Date, 'now', () => +new Date(2026, 0, 2, 12));
  const h = harness(t, graph('p1', 'p2', 'p3'));
  await h.generate(cards('p1', 'First', 'Second cue'), cards('p2', 'Second proposition'), cards('p3', 'Third proposition'));
  const source = h.state().decks[0];
  let samples = 0;
  t.mock.method(Math, 'random', () => { samples++; return 0; });
  let before = h.disk();
  assert.equal((await h.call('next-review')).remaining, 3);
  assert.equal(samples, 1, 'counting makes no additional cue choices');
  assert.deepEqual(h.disk(), before);
  await h.call('save-deck', { id: source.id, newLimit: 2 });
  before = h.disk();
  const { ticket, remaining } = await h.call('next-review');
  assert.equal(remaining, 2);
  assert.equal(ticket.propositionId, 'p1');
  assert.equal((await h.call('next-review')).remaining, 2, 'repeated reads do not consume admissions');
  assert.equal(samples, 3);
  assert.deepEqual(h.disk(), before);
  await h.call('reveal-review', { ticketId: ticket.id });
  await h.call('rate-review', { ticketId: ticket.id, rating: 4, requestId: 'count-first' });
  assert.equal((await h.call('next-review')).remaining, 1);
  assert.equal((await h.grade({})).propositionId, 'p2');
  assert.deepEqual(await h.call('next-review'), { ticket: null, remaining: 0 });
  assert.equal(h.state().decks[0].newToday, 2);
});

test('remaining combines ready due and admissible new propositions, excluding future learning, archives and unselected active pins', async t => {
  let now = +new Date(2026, 0, 2, 12);
  t.mock.method(Date, 'now', () => now);
  const h = harness(t, graph('learning', 'review', 'future', 'new1', 'new2'));
  await h.generate(cards('learning', 'Pinned', 'Alternate'), cards('review', 'Due review'), cards('future', 'Future learning'), cards('new1', 'New one'), cards('new2', 'New two'));
  await h.grade({ propositionIds: ['review'] }, 4);
  now += 30 * 86400000;
  await h.grade({ propositionIds: ['learning'] }, 1);
  now += 60000;
  await h.grade({ propositionIds: ['future'] }, 1);
  await h.call('save-deck', { id: h.state().decks[0].id, newLimit: 3 });
  const before = h.disk();
  const result = await h.call('next-review');
  assert.equal(result.ticket.propositionId, 'learning', 'actual learning-first selection is unchanged');
  assert.equal(result.remaining, 3, 'two due plus one introduction, including current');
  assert.equal((await h.call('next-review', { propositionIds: ['learning', 'review', 'future'] })).remaining, 2);
  assert.equal((await h.call('next-review', { propositionIds: ['learning', 'future', 'new1'] })).remaining, 2);
  const future = h.state().propositions.find(p => p.id === 'future');
  assert.deepEqual(await h.call('next-review', { propositionIds: ['future'] }), { ticket: null, nextDue: future.schedule.due, remaining: 0 });
  const learning = h.state().propositions.find(p => p.id === 'learning');
  const alternate = learning.cues.find(c => c.id !== learning.learningCueId);
  const newCue = h.state().propositions.find(p => p.id === 'new1').cues[0];
  assert.equal((await h.call('next-review', { cueIds: [alternate.id, future.cues[0].id, newCue.id] })).remaining, 1);
  assert.deepEqual(await h.call('next-review', { cueIds: [] }), { ticket: null, remaining: 0 });
  assert.deepEqual(h.disk(), before);
  await h.call('delete-cue', { propositionId: learning.id, cueId: learning.learningCueId, version: learning.version });
  assert.equal((await h.call('next-review', { cueIds: [alternate.id, newCue.id] })).remaining, 2, 'deleted pin falls back within the selected pool');
  h.graph.propositions = h.graph.propositions.filter(p => p.id !== 'review');
  assert.equal((await h.call('next-review')).remaining, 2, 'archived due propositions are excluded');
  await h.call('save-deck', { id: h.state().decks[0].id, newLimit: 0 });
  assert.equal((await h.call('next-review')).remaining, 1, 'ready due obligations are uncapped even when new admissions are zero');
});

test('remaining simulates deterministic shared-deck admission, charging every membership but gating only the admitting deck', async t => {
  t.mock.method(Date, 'now', () => +new Date(2026, 0, 2, 12));
  const h = harness(t, graph('shared', 'onlyA', 'onlyB'));
  await h.generate(cards('shared', 'Shared cue', 'Another shared cue'), cards('onlyA', 'A cue'), cards('onlyB', 'B cue'));
  const a = h.state().decks[0];
  await h.call('create-deck', { name: 'B' });
  const b = h.state().decks.find(d => d.name === 'B');
  await h.call('set-memberships', { propositionId: 'shared', deckIds: [a.id, b.id] });
  await h.call('set-memberships', { propositionId: 'onlyB', deckIds: [b.id] });
  await h.call('save-deck', { id: a.id, newLimit: 1 });
  await h.call('save-deck', { id: b.id, newLimit: 1 });
  let before = h.disk();
  assert.equal((await h.call('next-review')).remaining, 1, 'first shared introduction fills both allowances');
  assert.equal((await h.call('next-review', { deckIds: [b.id] })).remaining, 1);
  assert.deepEqual(h.disk(), before);
  await h.call('save-deck', { id: a.id, newLimit: 2 });
  assert.equal((await h.call('next-review')).remaining, 2, 'shared proposition is not counted twice');
  await h.call('save-deck', { id: b.id, newLimit: 0 });
  assert.equal((await h.call('next-review')).remaining, 2, 'zero allowance in another containing deck does not block A');
  assert.deepEqual(await h.call('next-review', { deckIds: [b.id] }), { ticket: null, remaining: 0 });
  await h.call('save-deck', { id: a.id, newLimit: 0 });
  await h.call('save-deck', { id: b.id, newLimit: 2 });
  before = h.disk();
  const first = await h.call('next-review');
  assert.equal(first.ticket.propositionId, 'shared');
  assert.equal(first.remaining, 2);
  assert.deepEqual(h.disk(), before);
  assert.equal((await h.grade({})).propositionId, 'shared');
  assert.equal((await h.call('next-review')).remaining, 1);
  assert.equal((await h.grade({})).propositionId, 'onlyB');
  assert.deepEqual(await h.call('next-review'), { ticket: null, remaining: 0 });
  assert.deepEqual(h.state().decks.map(d => d.newToday), [1, 2]);
});

test('get-state adds read-only aggregate statistics, deduplicating shared propositions and retaining actual archived/deleted review activity', async t => {
  t.mock.method(Date, 'now', () => +new Date(2026, 0, 2, 12));
  const h = harness(t, graph('p1', 'p2'));
  await h.generate(cards('p1', 'First cue', 'Second cue'), cards('p2', 'Other cue'));
  await h.call('create-deck', { name: 'Shared' });
  await h.call('set-memberships', { propositionId: 'p1', deckIds: h.state().decks.map(d => d.id) });
  let stats = h.state().statistics;
  assert.deepEqual(stats.states, { new: 2, learning: 0, review: 0, relearning: 0 });
  assert.equal(stats.due.length, 9); assert.equal(stats.activity.length, 14);
  await h.grade({ propositionIds: ['p1'] }, 1);
  stats = h.state().statistics;
  assert.deepEqual(stats.states, { new: 1, learning: 1, review: 0, relearning: 0 });
  assert.equal(stats.due[1].count, 1, 'future learning later today is in the today bar');
  assert.equal(stats.activity.at(-1).count, 1);
  h.graph.propositions = h.graph.propositions.filter(p => p.id !== 'p1');
  const p2 = h.state().propositions.find(p => p.id === 'p2');
  await h.call('delete-cue', { propositionId: p2.id, cueId: p2.cues[0].id, version: p2.version });
  const before = h.disk(), state = await h.call('get-state');
  assert.deepEqual(state.statistics.states, { new: 0, learning: 0, review: 0, relearning: 0 });
  assert.ok(state.statistics.due.every(row => row.count === 0));
  assert.equal(state.statistics.activity.at(-1).count, 1);
  assert.equal(Object.hasOwn(state, 'reviews'), false);
  assert.deepEqual(h.disk(), before);
});

test('missing graph propositions archive non-destructively and return with the same content and memberships', async t => {
  const h = harness(t);
  await h.generate(cards('p1', 'Retained cue'));
  const before = h.state().propositions[0];
  const original = h.graph.propositions[0];
  h.graph.propositions = [];
  assert.equal(h.state().propositions[0].archived, true);
  assert.equal((await h.call('next-review')).ticket, null);
  assert.deepEqual(h.state().propositions[0].cues, before.cues);
  h.graph.propositions = [{ ...original, provenance: [{ chatId: 'different-source' }] }];
  const restored = h.state().propositions[0];
  assert.equal(restored.archived, false);
  assert.deepEqual(restored.schedule, before.schedule);
  assert.deepEqual(restored.memberships, before.memberships);
  assert.equal(h.state().decks[0].name, 'Source lesson');
  assert.equal((await h.call('next-review')).ticket.propositionId, 'p1');
});

test('cancellation fences late successful worker results', async t => {
  const h = harness(t);
  const [task] = await h.start(['p1']);
  await h.call('cancel-generation', { batchId: h.state().batch.id });
  assert.equal(h.workers.tasks.get(task.id).cancelRequested, true);
  await h.complete(task, result(cards('p1', 'Too late')));
  await h.call('resume-results');
  assert.equal(h.state().batch.status, 'cancelled');
  assert.deepEqual(h.state().propositions, []);
  assert.deepEqual(h.state().decks, []);
});

test('accepted results survive a save failure and reconcile without another worker run', async t => {
  const h = harness(t);
  const [task] = await h.start(['p1']);
  const before = h.disk();
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Synthetic result-save failure'); });
  try {
    await h.complete(task, result(cards('p1', 'Recoverable result')));
    assert.equal(h.workers.service.get(task.id).status, 'succeeded');
    assert.deepEqual(h.disk(), before);
    assert.deepEqual(h.state().propositions, []);
    assert.match(h.state().batch.error, /Synthetic result-save failure/);
    assert.notEqual(h.state().batch.chunks[0].status, 'applied');
  } finally { rename.mock.restore(); }
  h.activate();
  await flush();
  assert.equal(h.workers.starts, 1);
  assert.equal(h.state().batch.status, 'completed');
  assert.equal(h.state().propositions[0].cues[0].question, 'Recoverable result');
  assert.deepEqual(fs.readdirSync(h.directory), ['flashcards.json']);
});

test('restart reconciles accepted durable results exactly once and never replays missing tasks', async t => {
  const h = harness(t);
  const [task] = await h.start(['p1']);
  h.dispose();
  h.workers.complete(task.id, result(cards('p1', 'Durable accepted cue')));
  h.activate();
  await flush();
  assert.equal(h.workers.starts, 1);
  assert.equal(h.state().batch.status, 'completed');
  assert.equal(h.state().propositions[0].cues.length, 1);
  h.activate();
  await flush();
  assert.equal(h.state().propositions[0].cues.length, 1);
  assert.equal(h.workers.starts, 1);
  const [missing] = await h.start(['p1']);
  const durableTask = h.workers.tasks.get(missing.id);
  h.dispose(); h.workers.tasks.delete(missing.id); h.activate();
  await flush();
  assert.equal(h.workers.starts, 2);
  assert.match(h.state().batch.error, /worker record could not be read/);
  assert.equal(h.state().propositions[0].cues.length, 1);
  // A transiently unreadable accepted record is recoverable, not auto-replayed.
  h.workers.tasks.set(missing.id, durableTask);
  h.workers.complete(missing.id, result(cards('p1', 'Recovered later')));
  await h.call('resume-results');
  assert.equal(h.state().batch.status, 'completed');
  assert.equal(h.state().propositions[0].cues.length, 2);
  assert.equal(h.workers.starts, 2);
});

test('settings validate atomically and model resolution fails explicitly without a configured slot', async t => {
  const h = harness(t);
  const before = h.state();
  for (const patch of [{ retention: .69 }, { retention: 1 }, { learningSteps: [] }, { relearningSteps: [10, 5] },
    { learningSteps: [1440] }, { dayStart: 24 }, { chunkBudget: 0 }, { modelOverride: {} }, { thinkingOverride: 'invented' }, { unknown: true }]) {
    await assert.rejects(h.call('save-settings', patch));
    assert.deepEqual(h.state(), before);
  }
  h.catalog.slots = {};
  await assert.rejects(h.call('preflight', { propositionIds: ['p1'] }), /Configure the cheap model slot/);
  assert.equal(h.workers.starts, 0);
  assert.deepEqual(h.state().propositions, []);
});
