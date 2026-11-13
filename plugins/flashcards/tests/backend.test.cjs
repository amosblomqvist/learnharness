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
  const definitions = new Map(); let starts = 0;
  const terminal = task => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.status);
  const emit = task => {
    for (const listener of subscriptions.get(task.id) ?? []) listener(structuredClone(task));
    if (terminal(task)) for (const done of [...(waiters.get(task.id) ?? [])]) done();
  };
  const service = {
    register(value) { definitions.set(value.id, value); return () => {}; },
    start(workerId, options) {
      assert.ok(definitions.has(workerId));
      assert.equal(options.purpose, 'user');
      assert.ok(options.requestId);
      const prior = [...tasks.values()].find(task => task.requestId === options.requestId);
      if (prior) return structuredClone(prior);
      starts++;
      const task = { id: randomUUID(), workerId, requestId: options.requestId, input: structuredClone(options.input), prompt: options.prompt, status: 'running', turns: 0, activity: 'waiting' };
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
      definitions.get(task.workerId).validateResult(value, { input: task.input });
      task.result = structuredClone(value); emit(task);
    },
    complete(id, value, status = 'succeeded') {
      const task = tasks.get(id);
      if (status === 'succeeded') definitions.get(task.workerId).validateResult(value, { input: task.input });
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
  const h = { graph: initialGraph, workers, directory, catalogReads: 0, catalog: {
    slots: { cheap: { model: { provider: 'mock', id: 'cheap' }, thinkingLevel: 'off' } },
    models: [{ provider: 'mock', id: 'cheap', name: 'Mock cheap', supportedLevels: ['off', 'low'], contextWindow: 100000, maxTokens: 8192 }],
  } };
  let handlers, controller, cleanups = [];
  h.dispose = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); controller?.abort(); };
  h.activate = () => {
    h.dispose(); handlers = new Map(); controller = new AbortController();
    activate({ dataDirectory: directory, signal: controller.signal,
      workers: workers.service, learning: { graph: () => structuredClone(h.graph) },
      inference: { catalog: async () => { h.catalogReads++; return h.resolveCatalog ? h.resolveCatalog() : structuredClone(h.catalog); } },
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
  h.startFile = async (input, requestId = randomUUID()) => {
    const plan = await h.call('preflight-file', input);
    await h.call('start-generation', { preflightId: plan.id, requestId }); await flush();
    return { plan, batch: h.state().batch, tasks: h.state().batch.chunks.map(c => workers.service.list().find(t => t.requestId === c.requestId)) };
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

test('content deletion is global and permanent, preserves surviving schedules and history, and cleans only affected empty decks', async t => {
  const h = harness(t, graph('p1', 'p2'));
  await h.generate(cards('p1', 'Remove one', 'Remove two'), cards('p2', 'Keep'));
  await h.call('create-deck', { name: 'Shared' }); await h.call('create-deck', { name: 'Unrelated empty deck' });
  const shared = h.state().decks.find(d => d.name === 'Shared'), unrelated = h.state().decks.find(d => d.name === 'Unrelated empty deck');
  await h.call('set-memberships', { propositionId: 'p1', deckIds: [h.state().decks[0].id, shared.id] });
  await h.grade({ propositionIds: ['p1'] }, 1);
  const p = h.state().propositions.find(p => p.id === 'p1'), history = h.disk().reviews, graphBefore = structuredClone(h.graph), starts = h.workers.starts;
  const removed = p.cues.find(c => c.id === p.learningCueId);
  await h.call('delete-content', { revision: h.state().revision, cueIds: [removed.id, removed.id], deleteEmptyDecks: true, requestId: 'remove-one' });
  const surviving = h.state().propositions.find(p => p.id === 'p1');
  assert.deepEqual(surviving.schedule, p.schedule); assert.equal(surviving.learningCueId, null);
  assert.deepEqual(surviving.memberships, p.memberships); assert.equal(surviving.cues.length, 1); assert.equal(surviving.version, p.version + 1);
  assert.equal(JSON.stringify(h.disk()).includes(removed.question), false, 'no deleted question/answer tombstone is retained');
  await h.call('delete-content', { revision: h.state().revision, propositionIds: ['p1'], deleteEmptyDecks: true, requestId: 'remove-target' });
  assert.equal(h.state().propositions.some(p => p.id === 'p1'), false);
  assert.equal(h.state().decks.some(d => d.id === shared.id), false);
  assert.equal(h.state().decks.some(d => d.id === unrelated.id), true, 'unrelated empty decks are untouched');
  assert.deepEqual(h.state().decks[0].propositionIds, ['p2']); assert.deepEqual(h.disk().reviews, history);
  assert.equal(h.state().statistics.activity.at(-1).count, 1); assert.equal(h.state().statistics.states.learning, 0);
  assert.deepEqual(h.graph, graphBefore); assert.equal(h.workers.starts, starts);
  h.activate(); assert.equal(JSON.stringify(h.disk()).includes('Remove two'), false);
});

test('content deletion can retain emptied containers; direct deck deletion removes its shared contents without a replacement', async t => {
  const h = harness(t); await h.generate(cards('p1', 'Only cue'));
  await h.call('create-deck', { name: 'Shared' });
  const deckIds = h.state().decks.map(d => d.id);
  await h.call('set-memberships', { propositionId: 'p1', deckIds });
  await h.call('delete-content', { revision: h.state().revision, deckIds: [deckIds[0]], deleteEmptyDecks: false, requestId: 'retain-decks' });
  assert.equal(h.state().propositions.length, 0); assert.deepEqual(h.state().decks.map(d => d.id), deckIds);
  assert.ok(h.state().decks.every(d => d.propositionIds.length === 0));
  await h.call('delete-deck', { id: deckIds[0] });
  assert.deepEqual(h.state().decks.map(d => d.id), [deckIds[1]], 'selected empty deck is deleted, unrelated empty decks survive');
});

test('content deletion validates the whole selection and stale snapshots atomically and safely retries a lost response', async t => {
  const h = harness(t); await h.generate(cards('p1', 'One', 'Two'));
  const before = h.disk(), cueId = h.state().propositions[0].cues[0].id;
  const input = { revision: h.state().revision, cueIds: [cueId], deleteEmptyDecks: true, requestId: 'delete-once' };
  for (const patch of [{ cueIds: [cueId, 'missing'] }, { propositionIds: ['missing'] }, { deckIds: ['missing'] }, { cueIds: 'wrong' }, { cueIds: null }, { cueIds: [] }, { deleteEmptyDecks: 'yes' }, { requestId: '' }, { revision: input.revision - 1 }]) {
    await assert.rejects(h.call('delete-content', { ...input, ...patch })); assert.deepEqual(h.disk(), before);
  }
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Deletion save unavailable'); });
  try { await assert.rejects(h.call('delete-content', input), /Deletion save unavailable/); }
  finally { rename.mock.restore(); }
  assert.deepEqual(h.disk(), before); assert.equal(h.state().propositions[0].cues.length, 2);
  await h.call('delete-content', input); const accepted = h.disk();
  h.activate(); await h.call('delete-content', input); assert.deepEqual(h.disk(), accepted, 'same request cannot delete more content or fail as stale');
  await assert.rejects(h.call('delete-content', { ...input, deleteEmptyDecks: false }), /different work/);
});

test('legacy tombstones are purged on activation without losing text-free manual creation receipts or past review statistics', async t => {
  const h = harness(t); await h.generate(cards('p1', 'Keep active', 'LEGACY_SECRET_QUESTION'));
  await h.call('create-deck', { name: 'Manual deck' });
  const request = { deckId: h.state().decks[1].id, name: 'LEGACY_SECRET_TARGET', question: 'LEGACY_MANUAL_QUESTION', answer: 'LEGACY_MANUAL_ANSWER', requestId: 'legacy-create' };
  const created = await h.call('create-card', request); await h.grade({ propositionIds: [created.propositionId] });
  const old = h.disk(), history = structuredClone(old.reviews);
  old.propositions.p1.cues[1].deleted = true;
  const manual = old.propositions[created.propositionId].cues[0], receipt = old.creationReceipts[0];
  manual.creation = { requestId: receipt.requestId, hash: receipt.hash }; manual.deleted = true; delete old.creationReceipts;
  old.reviews[0].question = manual.question; old.reviews[0].answer = manual.answer;
  h.dispose(); fs.writeFileSync(path.join(h.directory, 'flashcards.json'), JSON.stringify(old)); h.activate();
  const migrated = h.disk(), text = JSON.stringify(migrated);
  for (const secret of ['LEGACY_SECRET_QUESTION', 'LEGACY_SECRET_TARGET', 'LEGACY_MANUAL_QUESTION', 'LEGACY_MANUAL_ANSWER']) assert.equal(text.includes(secret), false, secret);
  assert.equal(h.state().propositions.length, 1); assert.deepEqual(h.disk().reviews, history);
  assert.equal(h.state().decks.some(d => d.id === request.deckId), true, 'migration does not remove containers');
  assert.equal((await h.call('create-card', request)).propositionId, created.propositionId);
  assert.deepEqual(h.disk(), migrated, 'retry never restores a physically deleted manual card');
  h.activate(); assert.deepEqual(h.disk(), migrated, 'migration runs only once');
});

test('file source data follows its deck, not its last target; deleted decks cannot reopen or regenerate from old retry records', async t => {
  const h = harness(t, graph()), input = fileInput(), { tasks, batch } = await h.startFile(input);
  await h.complete(tasks[0], fileResult(fileFact('Local', 'Local statement', 'Local cue')));
  const p = h.state().propositions[0], sourceFile = path.join(h.directory, 'sources', `${batch.sourceId}.md`);
  await h.call('delete-content', { revision: h.state().revision, propositionIds: [p.id], deleteEmptyDecks: false, requestId: 'keep-file-deck' });
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), input.markdown); assert.ok(h.disk().fileSources[batch.sourceId]);
  const reads = h.catalogReads, starts = h.workers.starts;
  const duplicate = await h.call('preflight-file', input); assert.equal(duplicate.existingSourceId, batch.sourceId);
  const opened = await h.call('open-file-deck', { sourceId: batch.sourceId }); assert.equal(opened.deckId, batch.deckId);
  assert.equal(h.state().propositions.length, 0); assert.equal(h.catalogReads, reads); assert.equal(h.workers.starts, starts);
  await h.call('delete-deck', { id: batch.deckId });
  assert.equal(fs.existsSync(sourceFile), false); assert.equal(h.disk().fileSources[batch.sourceId], undefined);
  await assert.rejects(h.call('open-file-deck', { sourceId: batch.sourceId }), /File source not found/);
  const fresh = await h.call('preflight-file', input); assert.ok(fresh.id); assert.equal(fresh.existingSourceId, undefined);
  assert.equal(h.state().decks.length, 0); assert.equal(h.workers.starts, starts, 'upload still requires fresh confirmation');
});

test('all deletion entry points reject active and cancelling generation; cancelled late results never restore deleted content', async t => {
  const h = harness(t); await h.generate(cards('p1', 'Original'));
  const p = h.state().propositions[0], deckId = h.state().decks[0].id;
  const [task] = await h.start(['p1']);
  const checkBlocked = async () => {
    const before = h.disk();
    await assert.rejects(h.call('delete-content', { cueIds: [p.cues[0].id], revision: h.state().revision, deleteEmptyDecks: true, requestId: randomUUID() }), /generation to finish or cancel/);
    await assert.rejects(h.call('delete-deck', { id: deckId }), /generation to finish or cancel/);
    await assert.rejects(h.call('delete-cue', { propositionId: p.id, cueId: p.cues[0].id, version: p.version }), /generation to finish or cancel/);
    assert.deepEqual(h.disk(), before);
  };
  await checkBlocked(); await h.call('cancel-generation', { batchId: h.state().batch.id }); await checkBlocked();
  await h.complete(task, result(cards('p1', 'Late cue')));
  assert.equal(h.state().batch.status, 'cancelled');
  await h.call('delete-deck', { id: deckId }); h.activate(); await h.call('resume-results');
  assert.equal(h.state().propositions.length, 0); assert.equal(h.state().decks.length, 0);
});

test('failed saved-source cleanup is durable and retryable without restoring content, metadata, or model work', async t => {
  const h = harness(t, graph()), input = fileInput(), { tasks, batch } = await h.startFile(input);
  await h.complete(tasks[0], fileResult(fileFact('Local', 'Local statement', 'Secret file cue')));
  const sourceFile = path.join(h.directory, 'sources', `${batch.sourceId}.md`), unlink = fs.unlinkSync;
  const failure = t.mock.method(fs, 'unlinkSync', filename => {
    if (filename === sourceFile) throw new Error('Synthetic source cleanup unavailable');
    return unlink(filename);
  });
  const deletion = { deckIds: [batch.deckId], revision: h.state().revision, deleteEmptyDecks: true, requestId: 'cleanup-retry' };
  try { await assert.rejects(h.call('delete-content', deletion), /cleanup is pending/); }
  finally { failure.mock.restore(); }
  assert.equal(h.state().decks.length, 0); assert.equal(h.state().propositions.length, 0); assert.equal(h.disk().fileSources[batch.sourceId], undefined);
  assert.deepEqual(h.disk().pendingSourceRemovals, [batch.sourceId]); assert.equal(fs.existsSync(sourceFile), true);
  await h.call('delete-content', deletion); assert.equal(fs.existsSync(sourceFile), false); assert.equal(h.disk().pendingSourceRemovals, undefined);
  assert.equal(h.state().cleanupError, undefined); assert.equal(h.workers.starts, 1);
  h.activate(); await h.call('delete-content', deletion); assert.equal(h.state().decks.length, 0);
});

test('activation completes pending source cleanup after its final metadata write failed, without replaying the deletion', async t => {
  const h = harness(t, graph()), { tasks, batch } = await h.startFile(fileInput());
  await h.complete(tasks[0], fileResult(fileFact('Local', 'Local statement', 'Local cue')));
  const deletion = { deckIds: [batch.deckId], revision: h.state().revision, deleteEmptyDecks: true, requestId: 'cleanup-after-crash' };
  let writes = 0; const rename = fs.renameSync;
  const failure = t.mock.method(fs, 'renameSync', (...args) => {
    if (++writes === 2) throw new Error('Cleanup marker save unavailable');
    return rename(...args);
  });
  try { await assert.rejects(h.call('delete-content', deletion), /cleanup is pending/); }
  finally { failure.mock.restore(); }
  assert.equal(fs.existsSync(path.join(h.directory, 'sources', `${batch.sourceId}.md`)), false);
  assert.deepEqual(h.disk().pendingSourceRemovals, [batch.sourceId]);
  h.activate(); const recovered = h.disk();
  assert.equal(recovered.pendingSourceRemovals, undefined); assert.equal(h.state().decks.length, 0); assert.equal(h.state().propositions.length, 0);
  await h.call('delete-content', deletion); assert.deepEqual(h.disk(), recovered); assert.equal(h.workers.starts, 1);
});

test('deleting an emptied original file deck removes its source assets but preserves local targets moved to other decks', async t => {
  const h = harness(t, graph()), input = fileInput(), { tasks, batch } = await h.startFile(input);
  await h.complete(tasks[0], fileResult(fileFact('Moved fact', 'Moved statement', 'Moved cue')));
  const p = h.state().propositions[0]; await h.grade({ propositionIds: [p.id] });
  await h.call('create-deck', { name: 'Keep moved fact' }); const keep = h.state().decks.find(d => d.id !== batch.deckId);
  await h.call('set-memberships', { propositionId: p.id, deckIds: [keep.id] });
  const progress = h.state().propositions[0].schedule;
  await h.call('delete-deck', { id: batch.deckId }); h.activate();
  assert.equal(h.state().propositions[0].archived, false); assert.deepEqual(h.state().propositions[0].schedule, progress);
  assert.deepEqual(h.state().propositions[0].memberships, [keep.id]); assert.equal(h.state().statistics.states.review, 1);
  assert.equal(h.disk().fileSources[batch.sourceId], undefined);
  assert.equal(fs.existsSync(path.join(h.directory, 'sources', `${batch.sourceId}.md`)), false);
  assert.ok((await h.call('preflight-file', input)).id); assert.equal(h.state().decks.length, 1);
});

test('activation forgets legacy orphaned file sources rather than recreating deleted decks, without deleting moved targets', async t => {
  const h = harness(t, graph()), input = fileInput(), { tasks, batch } = await h.startFile(input);
  await h.complete(tasks[0], fileResult(fileFact('Moved', 'Moved statement', 'Moved cue')));
  await h.call('create-deck', { name: 'Surviving deck' }); const keep = h.state().decks.find(d => d.id !== batch.deckId);
  const p = h.state().propositions[0]; await h.call('set-memberships', { propositionId: p.id, deckIds: [keep.id] });
  h.dispose(); const old = h.disk(); old.decks = old.decks.filter(d => d.id !== batch.deckId);
  fs.writeFileSync(path.join(h.directory, 'flashcards.json'), JSON.stringify(old)); h.activate();
  assert.equal(h.disk().fileSources[batch.sourceId], undefined); assert.equal(h.disk().pendingSourceRemovals, undefined);
  assert.equal(fs.existsSync(path.join(h.directory, 'sources', `${batch.sourceId}.md`)), false);
  assert.equal(h.state().propositions[0].id, p.id); assert.equal(h.state().propositions[0].archived, false);
  assert.ok((await h.call('preflight-file', input)).id);
  await assert.rejects(h.call('open-file-deck', { sourceId: batch.sourceId }), /File source not found/);
  assert.deepEqual(h.state().decks.map(d => d.id), [keep.id]);
});

test('manual creation atomically makes a local target and first cue in the chosen deck without graph writes or model calls', async t => {
  const h = harness(t, graph()); await h.call('create-deck', { name: 'Handwritten' });
  h.catalog.slots = {}; h.resolveCatalog = () => { throw new Error('Manual creation must not resolve a model'); };
  const deckId = h.state().decks[0].id, graphBefore = structuredClone(h.graph);
  const input = { deckId, name: '  My target  ', question: 'Question **Markdown**?', answer: '$x = 1$', requestId: 'manual-create' };
  const created = await h.call('create-card', input), p = created.state.propositions[0];
  assert.equal(p.id, created.propositionId); assert.equal(p.name, 'My target'); assert.equal(p.origin, 'manual'); assert.equal(p.archived, false);
  assert.deepEqual(p.memberships, [deckId]); assert.deepEqual(created.state.decks[0].propositionIds, [p.id]);
  assert.equal(p.cues.length, 1); assert.equal(p.cues[0].id, created.cueId); assert.equal(p.cues[0].question, input.question); assert.equal(p.cues[0].answer, input.answer);
  assert.equal(p.schedule.state, 0); assert.equal(p.firstReviewedAt, null); assert.equal(p.learningCueId, null);
  assert.deepEqual(created.state.statistics.states, { new: 1, learning: 0, review: 0, relearning: 0 });
  assert.equal(h.workers.starts, 0); assert.equal(h.catalogReads, 0); assert.deepEqual(h.graph, graphBefore);
  assert.deepEqual(fs.readdirSync(h.directory), ['flashcards.json'], 'manual content needs neither file sources nor task records');
  h.activate(); assert.equal(h.state().propositions[0].archived, false);
  await h.grade({ cueIds: [created.cueId] }, 1);
  assert.equal(h.state().decks[0].newToday, 1); assert.equal(h.state().propositions[0].schedule.state, 1);
  const another = await h.call('create-card', { ...input, requestId: 'another-intentional-create' });
  assert.notEqual(another.propositionId, p.id, 'a deliberate new save creates a new target instead of matching labels');
  await h.call('reorder', { kind: 'proposition', deckId, id: another.propositionId, direction: -1 });
  assert.deepEqual(h.state().decks[0].propositionIds, [another.propositionId, p.id]);
});

test('manual add-cue works on graph, file and handwritten targets without resetting schedules, history, memberships or learning pins', async t => {
  for (const origin of ['graph', 'file', 'manual']) {
    const h = harness(t, origin === 'graph' ? graph('p1') : graph());
    if (origin === 'graph') await h.generate(cards('p1', 'Existing cue'));
    else if (origin === 'file') { const started = await h.startFile(fileInput()); await h.complete(started.tasks[0], fileResult(fileFact('File fact', 'Statement', 'Existing cue'))); }
    else { await h.call('create-deck', { name: 'Manual' }); await h.call('create-card', { deckId: h.state().decks[0].id, name: 'Manual fact', question: 'Existing cue', answer: 'Existing answer', requestId: 'first' }); }
    const id = h.state().propositions[0].id; await h.grade({ propositionIds: [id] }, 1);
    const before = structuredClone(h.state().propositions[0]), reviews = h.disk().reviews;
    const added = await h.call('create-cue', { propositionId: id, question: 'Alternate cue', answer: 'Alternate answer', requestId: 'append' });
    const after = added.state.propositions.find(p => p.id === id);
    assert.equal(added.propositionId, id); assert.equal(after.cues.at(-1).id, added.cueId);
    assert.equal(after.cues.at(-1).latestRating, null); assert.equal(after.version, before.version + 1);
    for (const key of ['schedule', 'firstReviewedAt', 'learningCueId', 'memberships']) assert.deepEqual(after[key], before[key], `${origin}: ${key}`);
    assert.deepEqual(after.cues.slice(0, -1), before.cues); assert.deepEqual(h.disk().reviews, reviews);
  }
});

test('manual creation receipts survive restart, editing and deletion; duplicate deliveries never add another target or cue', async t => {
  const h = harness(t, graph()); await h.call('create-deck', { name: 'Manual' });
  const create = { deckId: h.state().decks[0].id, name: 'Target', question: 'Question', answer: 'Answer', requestId: 'create-once' };
  const first = await h.call('create-card', create), before = h.disk();
  const repeated = await h.call('create-card', create); assert.equal(repeated.propositionId, first.propositionId); assert.equal(repeated.cueId, first.cueId); assert.deepEqual(h.disk(), before);
  await assert.rejects(h.call('create-card', { ...create, answer: 'Different' }), /different work/);
  const append = { propositionId: first.propositionId, question: 'Second', answer: 'Answer', requestId: 'append-once' };
  const second = await h.call('create-cue', append);
  await h.call('save-cue', { propositionId: first.propositionId, cueId: second.cueId, question: 'Edited', answer: 'Edited answer', version: h.state().propositions[0].version });
  await h.call('delete-cue', { propositionId: first.propositionId, cueId: second.cueId, version: h.state().propositions[0].version });
  h.activate(); const saved = h.disk();
  const retry = await h.call('create-cue', append); assert.equal(retry.cueId, second.cueId); assert.deepEqual(h.disk(), saved);
  const retryCreate = await h.call('create-card', create); assert.equal(retryCreate.propositionId, first.propositionId); assert.deepEqual(h.disk(), saved);
  await assert.rejects(h.call('create-cue', { ...append, question: 'Changed request' }), /different work/);
  assert.equal(h.state().propositions.length, 1); assert.equal(h.state().propositions[0].cues.length, 1);
});

test('manual writes reject blank content, missing destinations and archived graph targets without partial mutation', async t => {
  const h = harness(t); await h.generate(cards('p1', 'Graph cue'));
  const input = { deckId: h.state().decks[0].id, name: 'Name', question: 'Question', answer: 'Answer', requestId: 'new' }, before = h.disk();
  for (const key of ['name', 'question', 'answer', 'requestId']) await assert.rejects(h.call('create-card', { ...input, [key]: '  ' }), /blank/);
  await assert.rejects(h.call('create-card', { ...input, deckId: 'missing' }), /Deck not found/);
  await assert.rejects(h.call('create-cue', { propositionId: 'missing', question: 'Q', answer: 'A', requestId: 'x' }), /Proposition not found/);
  for (const key of ['question', 'answer', 'requestId']) await assert.rejects(h.call('create-cue', { propositionId: 'p1', question: 'Q', answer: 'A', requestId: 'x', [key]: '' }), /blank/);
  h.graph.propositions = [];
  await assert.rejects(h.call('create-cue', { propositionId: 'p1', question: 'Q', answer: 'A', requestId: 'x' }), /no longer|archived/);
  assert.deepEqual(h.disk(), before);
});

test('manual atomic save failure leaves no empty target and a retry creates exactly one complete card', async t => {
  const h = harness(t, graph()); await h.call('create-deck', { name: 'Manual' });
  const input = { deckId: h.state().decks[0].id, name: 'Name', question: 'Question', answer: 'Answer', requestId: 'retry-save' }, before = h.disk();
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Synthetic manual save failure'); });
  await assert.rejects(h.call('create-card', input), /Synthetic manual save failure/); assert.deepEqual(h.disk(), before); assert.equal(h.state().propositions.length, 0);
  rename.mock.restore(); await h.call('create-card', input); await h.call('create-card', input);
  assert.equal(h.state().propositions.length, 1); assert.equal(h.state().propositions[0].cues.length, 1);
});

const fileFact = (name, statement, ...questions) => ({ name, statement, cards: questions.map(question => ({ question, answer: `Answer: ${question}` })) });
const fileResult = (...facts) => ({ facts });
const fileInput = () => ({ name: 'lesson.notes.md', markdown: 'UNIQUE SOURCE MARKDOWN\n\nThe original converted notes are retained separately.' });
const chunkedFile = () => ({ name: 'notes.md', markdown: Array.from({ length: 4 }, (_, i) => `Section ${i}\n${'Text '.repeat(100)}\n\n`).join('') });

test('file preflight is temporary and validates inputs before catalog access; confirmation creates one private source and deck even for zero facts', async t => {
  const h = harness(t, graph());
  for (const input of [{}, { name: '', markdown: 'x' }, { name: 'notes.md', markdown: '' }, { name: 'notes.md', markdown: 'a'.repeat(2 * 1024 * 1024 + 1) }, { name: 'notes.md', markdown: 123 }]) await assert.rejects(h.call('preflight-file', input));
  assert.equal(h.catalogReads, 0); assert.deepEqual(fs.readdirSync(h.directory), []);
  const input = fileInput(), graphBefore = structuredClone(h.graph), plan = await h.call('preflight-file', input);
  assert.equal(plan.kind, 'file'); assert.equal(plan.name, input.name); assert.equal(plan.chunkCount, 1); assert.ok(plan.estimatedTokens > 0);
  assert.deepEqual(fs.readdirSync(h.directory), []); assert.equal(h.workers.starts, 0); assert.equal(h.state().decks.length, 0);
  const request = { preflightId: plan.id, requestId: 'confirmed-file' };
  await h.call('start-generation', request); await flush();
  const batch = h.state().batch, source = h.disk().fileSources[batch.sourceId];
  assert.equal(batch.kind, 'file'); assert.equal(batch.name, input.name); assert.equal(batch.deckId, source.deckId);
  assert.equal(h.state().decks.length, 1); assert.equal(h.state().decks[0].name, input.name);
  const filename = path.join(h.directory, 'sources', `${source.id}.md`);
  assert.equal(fs.readFileSync(filename, 'utf8'), input.markdown); assert.equal(fs.statSync(filename).mode & 0o777, process.platform === 'win32' ? 0o666 : 0o600);
  assert.equal(fs.statSync(path.dirname(filename)).mode & 0o777, process.platform === 'win32' ? 0o666 : 0o700);
  const ledger = fs.readFileSync(path.join(h.directory, 'flashcards.json'), 'utf8');
  assert.equal(ledger.includes('UNIQUE SOURCE MARKDOWN'), false); assert.equal(ledger.includes('markdown'), false);
  const task = h.workers.service.list()[0];
  assert.equal(task.workerId, 'generate-file-facts-v1'); assert.equal(task.input.sourceId, source.id); assert.equal(task.input.markdown, input.markdown);
  assert.throws(() => h.workers.stage(task.id, { facts: [{ name: 'Invalid', statement: 'No cue', cards: [] }] }), /at least one card/);
  h.workers.stage(task.id, fileResult(fileFact('Unaccepted', 'Nonterminal results do not apply', 'Staged cue'))); await flush();
  assert.equal(h.state().propositions.length, 0);
  await h.call('start-generation', request); assert.equal(h.workers.starts, 1);
  await assert.rejects(h.call('start-generation', { ...request, preflightId: 'another' }), /different work/);
  await h.complete(task, fileResult());
  assert.equal(h.state().batch.status, 'completed'); assert.equal(h.state().decks.length, 1); assert.equal(h.state().propositions.length, 0);
  assert.deepEqual(h.graph, graphBefore);
});

test('file preflight rechecks duplicates after a deferred catalog resolves and cannot regenerate a concurrently confirmed file', async t => {
  const h = harness(t, graph()), input = fileInput();
  let release;
  const deferred = new Promise(resolve => { release = resolve; });
  h.resolveCatalog = () => h.catalogReads === 1 ? deferred : structuredClone(h.catalog);
  const pending = h.call('preflight-file', input);
  assert.equal(h.catalogReads, 1, 'first preflight is paused inside catalog resolution');
  const confirmed = await h.startFile(input);
  await h.complete(confirmed.tasks[0], fileResult(fileFact('Concurrent fact', 'Confirmed while catalog was pending', 'Concurrent cue')));
  const before = h.disk(); assert.equal(h.state().batch.status, 'completed');
  release(structuredClone(h.catalog));
  const resumed = await pending;
  assert.deepEqual(resumed, { existingSourceId: confirmed.batch.sourceId, deckId: confirmed.batch.deckId, name: input.name });
  assert.equal(resumed.id, undefined, 'no second generation plan is offered');
  assert.deepEqual(h.disk(), before); assert.equal(h.workers.starts, 1);
  assert.equal(h.state().decks.length, 1); assert.equal(Object.keys(h.disk().fileSources).length, 1);
  assert.equal(fs.readdirSync(path.join(h.directory, 'sources')).length, 1);
  const reads = h.catalogReads;
  assert.deepEqual(await h.call('preflight-file', input), resumed);
  assert.equal(h.catalogReads, reads, 'normal duplicate reopening still bypasses model resolution');
});

test('file preflight rechecks active batches after a deferred catalog resolves', async t => {
  const h = harness(t, graph());
  let release;
  const deferred = new Promise(resolve => { release = resolve; });
  h.resolveCatalog = () => h.catalogReads === 1 ? deferred : structuredClone(h.catalog);
  const pending = h.call('preflight-file', fileInput());
  assert.equal(h.catalogReads, 1);
  await h.startFile({ name: 'other.md', markdown: 'A different file confirmed during the pending catalog request.' });
  const before = h.disk(); assert.equal(h.state().batch.status, 'running');
  release(structuredClone(h.catalog));
  await assert.rejects(pending, /generation batch is already active/);
  assert.deepEqual(h.disk(), before); assert.equal(h.workers.starts, 1);
  assert.equal(h.state().decks.length, 1); assert.equal(Object.keys(h.disk().fileSources).length, 1);
});

test('file facts stay live in empty graphs for filtered review, limits, shared schedules, ordering and statistics', async t => {
  let now = +new Date(2026, 0, 2, 12); t.mock.method(Date, 'now', () => now);
  const h = harness(t, graph()), { tasks } = await h.startFile(fileInput());
  await h.complete(tasks[0], fileResult(fileFact('Fact one', 'First local statement', 'First cue', 'Alternate'), fileFact('Fact two', 'Second local statement', 'Second cue')));
  const [one, two] = h.state().propositions, sourceDeck = h.state().decks[0];
  assert.equal(one.origin, 'file'); assert.equal(one.sourceId, h.state().batch.sourceId); assert.equal(one.archived, false);
  assert.deepEqual(h.state().statistics.states, { new: 2, learning: 0, review: 0, relearning: 0 });
  await h.call('reorder', { kind: 'proposition', deckId: sourceDeck.id, id: two.id, direction: -1 });
  assert.deepEqual(h.state().decks[0].propositionIds, [two.id, one.id]);
  await h.call('save-deck', { id: sourceDeck.id, newLimit: 1 });
  await h.call('create-deck', { name: 'Shared local facts' });
  const shared = h.state().decks[1];
  await h.call('set-memberships', { propositionId: one.id, deckIds: [sourceDeck.id, shared.id] });
  const first = await h.grade({ cueIds: [one.cues[1].id] }, 1);
  assert.equal(first.propositionId, one.id); assert.deepEqual(h.state().decks.map(d => d.newToday), [1, 1]);
  assert.equal((await h.call('next-review', { deckIds: [sourceDeck.id] })).ticket, null);
  assert.deepEqual(h.state().statistics.states, { new: 1, learning: 1, review: 0, relearning: 0 });
  assert.equal(h.state().statistics.due[1].count, 1); assert.equal(h.state().statistics.activity.at(-1).count, 1);
  now += 60000;
  assert.equal((await h.grade({ deckIds: [sourceDeck.id], cueIds: [one.cues[1].id] }, 4)).cueId, first.cueId, 'due repetitions are uncapped and retain the pin');
  h.activate();
  assert.equal(h.state().propositions.find(p => p.id === one.id).archived, false);
  assert.equal(h.state().propositions.find(p => p.id === one.id).schedule.reps, 2);
  assert.equal(h.disk().reviews.filter(r => r.introduced).length, 1);
  assert.deepEqual(h.graph, graph());
});

test('identical files reopen renamed decks without catalog access; deleting the deck forgets its source and preserves only review statistics', async t => {
  const h = harness(t, graph()), input = { name: '../../original.notes.md', markdown: 'Same converted source.' };
  const { tasks } = await h.startFile(input);
  await h.complete(tasks[0], fileResult(fileFact('Local', 'Local statement', 'Local cue')));
  const source = Object.values(h.disk().fileSources)[0], p = h.state().propositions[0];
  await h.grade({ propositionIds: [p.id] });
  await h.call('save-deck', { id: source.deckId, name: 'My renamed collection', newLimit: 7 });
  const before = h.disk(), reads = h.catalogReads; h.catalog.slots = {};
  assert.deepEqual(await h.call('preflight-file', input), { existingSourceId: source.id, deckId: source.deckId, name: input.name });
  assert.equal(h.catalogReads, reads); assert.deepEqual(h.disk(), before);
  const opened = await h.call('open-file-deck', { sourceId: source.id });
  assert.equal(opened.deckId, source.deckId); assert.equal(opened.state.decks[0].name, 'My renamed collection');
  const reviews = h.disk().reviews;
  await h.call('delete-deck', { id: source.deckId });
  await assert.rejects(h.call('open-file-deck', { sourceId: source.id }), /File source not found/);
  h.catalog.slots.cheap = { model: { provider: 'mock', id: 'cheap' }, thinkingLevel: 'off' };
  assert.ok((await h.call('preflight-file', input)).id);
  assert.equal(h.state().decks.length, 0); assert.equal(h.state().propositions.length, 0);
  assert.deepEqual(h.disk().reviews, reviews); assert.equal(h.workers.starts, 1);
  assert.deepEqual(fs.readdirSync(path.join(h.directory, 'sources')), []);
});

test('same-source exact statements and questions collapse across chunks; deletion waits for completion and changed content is a new source', async t => {
  const h = harness(t, graph()), input = chunkedFile();
  await h.call('save-settings', { chunkBudget: 300 });
  const { tasks } = await h.startFile(input); assert.ok(tasks.length > 1);
  await h.complete(tasks[0], fileResult(fileFact('Original name', '  Shared statement  ', 'Original cue', 'Deleted cue')));
  let p = h.state().propositions[0];
  await h.call('save-cue', { propositionId: p.id, cueId: p.cues[0].id, question: 'Manual cue', answer: 'Manual answer', version: p.version });
  p = h.state().propositions[0];
  await assert.rejects(h.call('delete-cue', { propositionId: p.id, cueId: p.cues[1].id, version: p.version }), /generation to finish or cancel/);
  await h.grade({ propositionIds: [p.id] });
  const before = h.state().propositions[0], history = h.disk().reviews;
  for (const task of tasks.slice(1)) await h.complete(task, fileResult(fileFact('Do not rename', 'Shared statement', 'Manual cue', 'Deleted cue', 'New cue')));
  assert.equal(h.state().propositions.length, 1);
  p = h.state().propositions[0]; assert.equal(p.name, 'Original name'); assert.deepEqual(p.schedule, before.schedule); assert.deepEqual(p.cues.slice(0, 2), before.cues);
  assert.equal(p.cues.length, 3); assert.deepEqual(h.disk().reviews, history);
  await h.call('delete-cue', { propositionId: p.id, cueId: p.cues[1].id, version: p.version });
  assert.equal(h.state().propositions[0].cues.length, 2); assert.equal(JSON.stringify(h.disk()).includes('Deleted cue'), false);
  const changed = await h.startFile({ ...input, markdown: input.markdown + 'Changed.' });
  for (const task of changed.tasks) await h.complete(task, fileResult(fileFact('Independent', 'Shared statement', 'Other-source cue')));
  assert.equal(Object.keys(h.disk().fileSources).length, 2); assert.equal(h.state().decks.length, 2); assert.equal(h.state().propositions.length, 2);
  assert.notEqual(h.state().propositions[0].sourceId, h.state().propositions[1].sourceId);
});

test('file retries cover only failed source spans with current settings and cannot replay spans applied by any retry', async t => {
  const h = harness(t, graph()), input = chunkedFile();
  await h.call('save-settings', { chunkBudget: 300 });
  const { tasks, batch } = await h.startFile(input); assert.equal(tasks.length, 2);
  await h.complete(tasks[0], null, 'failed');
  await h.complete(tasks[1], fileResult(fileFact('Accepted', 'Accepted original fact', 'Keep this cue')));
  assert.equal(h.state().batch.status, 'partial'); assert.deepEqual(h.state().batch.failedChunkIds, [batch.chunks[0].id]); assert.deepEqual(h.state().batch.failedTargetIds, []);
  const accepted = h.state().propositions[0]; await h.grade({ propositionIds: [accepted.id] });
  const progress = h.state().propositions[0].schedule;
  await h.call('save-settings', { chunkBudget: 150, thinkingOverride: 'low' });
  const retry = await h.call('preflight-file-retry', { batchId: batch.id }); assert.equal(retry.kind, 'file'); assert.ok(retry.chunkCount > 1);
  await h.call('start-generation', { preflightId: retry.id, requestId: 'retry-failed-file' }); await flush();
  const retried = h.state().batch; assert.equal(retried.sourceId, batch.sourceId); assert.equal(retried.deckId, batch.deckId);
  for (const [index, chunk] of retried.chunks.entries()) {
    assert.ok(chunk.start >= batch.chunks[0].start && chunk.end <= batch.chunks[0].end);
    const task = h.workers.service.list().find(t => t.requestId === chunk.requestId);
    assert.equal(task.input.markdown, input.markdown.slice(chunk.start, chunk.end));
    if (index === 0) await h.complete(task, fileResult(fileFact('Retried', 'Retried fact', 'Accepted retry cue')));
    else await h.complete(task, null, 'failed');
  }
  assert.equal(h.state().batch.status, 'partial');
  const finalPlan = await h.call('preflight-file-retry', { batchId: batch.id });
  await h.call('start-generation', { preflightId: finalPlan.id, requestId: 'retry-old-batch-unapplied-only' }); await flush();
  for (const chunk of h.state().batch.chunks) {
    assert.ok(chunk.start >= retried.chunks[0].end && chunk.end <= batch.chunks[0].end, 'old batch retry subtracts successful retry subspans');
    const task = h.workers.service.list().find(t => t.requestId === chunk.requestId);
    await h.complete(task, fileResult(fileFact('Retried', 'Retried fact', `Final cue ${chunk.start}`)));
  }
  assert.equal(h.state().batch.status, 'completed'); assert.equal(h.state().decks.length, 1);
  assert.deepEqual(h.state().propositions.find(p => p.id === accepted.id).schedule, progress);
  const starts = h.workers.starts;
  await assert.rejects(h.call('preflight-file-retry', { batchId: batch.id }), /No failed file chunks/);
  assert.equal(h.workers.starts, starts); assert.equal(h.disk().reviews.length, 1);
  assert.equal(fs.readFileSync(path.join(h.directory, 'flashcards.json'), 'utf8').includes('Section 0'), false);
});

test('file cancellation fences late results, retains the source/deck, and retries cancelled spans after restart', async t => {
  const h = harness(t, graph()), { tasks, batch } = await h.startFile(fileInput());
  await h.call('cancel-generation', { batchId: batch.id });
  await h.complete(tasks[0], fileResult(fileFact('Late', 'Should not apply', 'Late cue')));
  assert.equal(h.state().batch.status, 'cancelled'); assert.equal(h.state().propositions.length, 0); assert.equal(h.state().decks.length, 1);
  h.activate();
  const retry = await h.call('preflight-file-retry', { batchId: batch.id });
  await h.call('start-generation', { preflightId: retry.id, requestId: 'retry-cancelled' }); await flush();
  const task = h.workers.service.list().find(t => t.requestId === h.state().batch.chunks[0].requestId);
  await h.complete(task, fileResult(fileFact('Accepted', 'Retry supported fact', 'Retry cue')));
  assert.equal(h.state().propositions.length, 1); assert.equal(h.state().decks.length, 1); assert.equal(h.state().batch.sourceId, batch.sourceId);
});

test('accepted file results reconcile once after restart or atomic save failure without running another worker', async t => {
  const h = harness(t, graph()), { tasks } = await h.startFile(fileInput());
  const before = h.disk(), rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Synthetic file result-save failure'); });
  try {
    await h.complete(tasks[0], fileResult(fileFact('Recoverable', 'Durable local statement', 'Durable cue')));
    assert.deepEqual(h.disk(), before); assert.equal(h.state().propositions.length, 0); assert.match(h.state().batch.error, /result-save failure/);
  } finally { rename.mock.restore(); }
  h.activate(); await flush(); assert.equal(h.state().propositions.length, 1); assert.equal(h.workers.starts, 1);
  const progress = h.state().propositions[0]; h.activate(); await flush(); assert.deepEqual(h.state().propositions[0], progress);
  const second = await h.startFile({ name: 'second.md', markdown: 'A different source.' });
  h.dispose(); h.workers.complete(second.tasks[0].id, fileResult(fileFact('Restart', 'Saved while inactive', 'Restart cue')));
  h.activate(); await flush(); assert.equal(h.state().propositions.length, 2); assert.equal(h.workers.starts, 2);
  assert.deepEqual(fs.readdirSync(path.join(h.directory, 'sources')).filter(name => name.endsWith('.tmp')), []);
});

test('confirmation failures do not retain unaccepted file metadata; stale plans and unreadable retry sources fail explicitly', async t => {
  const h = harness(t, graph()), input = fileInput(), plan = await h.call('preflight-file', input);
  const originalRename = fs.renameSync;
  const rename = t.mock.method(fs, 'renameSync', (from, to) => { if (path.basename(to) === 'flashcards.json') throw new Error('Ledger unavailable'); return originalRename(from, to); });
  try { await assert.rejects(h.call('start-generation', { preflightId: plan.id, requestId: 'save-failed' }), /Ledger unavailable/); }
  finally { rename.mock.restore(); }
  assert.equal(h.state().batch, null); assert.equal(h.state().decks.length, 0); assert.equal(h.workers.starts, 0);
  assert.deepEqual(fs.readdirSync(path.join(h.directory, 'sources')), []);
  await h.call('start-generation', { preflightId: plan.id, requestId: 'save-failed' }); await flush();
  const batch = h.state().batch, task = h.workers.service.list()[0]; await h.complete(task, null, 'failed');
  fs.unlinkSync(path.join(h.directory, 'sources', `${batch.sourceId}.md`));
  await assert.rejects(h.call('preflight-file-retry', { batchId: batch.id }), /ENOENT/);
  const changed = await h.call('preflight-file', { name: 'changed.md', markdown: 'Changed text.' });
  await h.call('save-settings', { thinkingOverride: 'low' });
  await assert.rejects(h.call('start-generation', { preflightId: changed.id, requestId: 'stale-file-plan' }), /changed/);
  assert.equal(h.workers.starts, 1);
});

test('legacy graph records lacking origin or batch kind retain progress, graph archive semantics and normal generation after file support is enabled', async t => {
  const h = harness(t);
  await h.generate(cards('p1', 'Graph cue')); await h.grade({});
  const legacy = h.disk(); delete legacy.propositions.p1.origin; delete legacy.batches[0].kind; delete legacy.fileSources;
  fs.writeFileSync(path.join(h.directory, 'flashcards.json'), JSON.stringify(legacy)); h.activate();
  assert.deepEqual(h.disk(), legacy); assert.equal(h.state().batch.kind, 'graph');
  assert.deepEqual(h.state().propositions[0].schedule, legacy.propositions.p1.schedule); assert.deepEqual(h.disk().reviews, legacy.reviews);
  h.graph = graph(); assert.equal(h.state().propositions[0].archived, true); assert.equal((await h.call('next-review')).ticket, null);
  const local = await h.startFile(fileInput()); await h.complete(local.tasks[0], fileResult(fileFact('Local', 'Local statement', 'Local cue')));
  assert.equal(h.state().propositions.find(p => p.origin === 'file').archived, false);
  assert.equal(h.state().propositions.find(p => p.id === 'p1').archived, true);
  assert.deepEqual(h.disk().propositions.p1.schedule, legacy.propositions.p1.schedule);
});

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

test('packing includes complete immediate chains and only active cues, never deleted-card backlog or recursive context', () => {
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
  assert.deepEqual(input.cards, [{ propositionId: 'c', active: [{ question: 'Manual cue', answer: 'Edited answer' }] }]);
  assert.equal(JSON.stringify(input).includes('Deleted cue'), false);
  assert.equal(JSON.stringify(input).includes('Old answer'), false);
  assert.equal(input.sources[0].label, 'Source lesson');
  assert.throws(() => pack(g, [], state), /Select at least one/);
  assert.throws(() => pack(g, ['missing'], state), /no longer in the graph/);
  assert.throws(() => pack({ ...g, propositions: g.propositions.filter(p => p.id !== 'b') }, ['c'], state), /Incomplete reasoning chain: b/);
  assert.deepEqual(pack(g, ['c'], { ...state, settings: { ...state.settings, chunkBudget: 1 } }), [input], 'an indivisible target rides alone, outside context does not consume its budget');
});

test('graph chunks budget selected target text only, independent of immediate chains and active card context', () => {
  const g = graph('p1', 'p2', 'context');
  g.propositions[2].statement = 'Neighboring context '.repeat(1000);
  g.chains = [{ id: 'joint', premises: ['p1', 'context'], conclusion: 'p2' }];
  const targetTokens = p => Math.ceil(`${p.name}\n${p.statement}`.length / 4);
  const budget = targetTokens(g.propositions[0]) + targetTokens(g.propositions[1]);
  const state = { settings: { ...defaults(), chunkBudget: budget }, propositions: {
    p1: { cues: [{ question: 'Active', answer: 'Long answer '.repeat(500) }, { question: 'Deleted', answer: 'Deleted text '.repeat(500), deleted: true }] },
  } };
  const before = JSON.stringify(state), [combined] = pack(g, ['p1', 'p2'], state);
  assert.deepEqual(combined.targets, ['p1', 'p2']);
  assert.ok(estimate(combined) > 4000, 'the full request is larger than the source budget and still packs');
  assert.equal(combined.propositions.length, 3); assert.equal(combined.cards[0].active.length, 1); assert.equal(Object.hasOwn(combined.cards[0], 'deleted'), false);
  assert.equal(JSON.stringify(combined).includes('Deleted text'), false);
  const split = pack(g, ['p1', 'p2'], { ...state, settings: { ...state.settings, chunkBudget: budget - 1 } });
  assert.deepEqual(split.map(input => input.targets), [['p1'], ['p2']]);
  assert.equal(JSON.stringify(state), before);
});

test('graph preflight estimates the full request and enforces the model context independently of the source budget', async t => {
  const h = harness(t);
  await h.call('save-settings', { chunkBudget: 1 });
  const [input] = pack(h.graph, ['p1'], { settings: { ...defaults(), chunkBudget: 1 }, propositions: {} });
  const tokens = estimate(input);
  h.catalog.models[0].contextWindow = tokens + 256 + 1024;
  const plan = await h.call('preflight', { propositionIds: ['p1'] });
  assert.equal(plan.chunkCount, 1); assert.equal(plan.estimatedTokens, tokens); assert.ok(tokens > 1);
  h.catalog.models[0].contextWindow--;
  await assert.rejects(h.call('preflight', { propositionIds: ['p1'] }), /cannot fit this context and an output allowance/);
  assert.equal(h.workers.starts, 0);
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
  const p = g.propositions[0];
  await h.call('save-settings', { chunkBudget: Math.ceil(`${p.name}\n${p.statement}`.length / 4) });
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

test('regeneration supplies active context only and preserves manual edits, memberships and schedule without a deleted-question blacklist', async t => {
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
  assert.equal(Object.hasOwn(task.input.cards[0], 'deleted'), false);
  assert.equal(JSON.stringify(task.input).includes('Do not recreate'), false);
  assert.throws(() => h.workers.stage(task.id, result(cards('p1', 'Manually edited'))), /Duplicate question/);
  await h.complete(task, result(cards('p1', 'Do not recreate', 'Distinct new cue')));
  const after = h.state().propositions[0];
  assert.deepEqual(after.schedule, before.schedule);
  assert.deepEqual(after.memberships, before.memberships);
  assert.equal(after.firstReviewedAt, before.firstReviewedAt);
  assert.deepEqual(after.cues.slice(0, before.cues.length), before.cues);
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
    { learningSteps: [1440] }, { dayStart: 24 }, { chunkBudget: 0 }, { modelOverride: {} }, { thinkingOverride: 'invented' }, { unknown: true },
    { language: '' }, { language: '   ' }, { language: 123 }, { language: null }]) {
    await assert.rejects(h.call('save-settings', patch));
    assert.deepEqual(h.state(), before);
  }
  h.catalog.slots = {};
  await assert.rejects(h.call('preflight', { propositionIds: ['p1'] }), /Configure the cheap model slot/);
  assert.equal(h.workers.starts, 0);
  assert.deepEqual(h.state().propositions, []);
});

test('saving language setting updates store and informs graph and file preflights', async t => {
  const h = harness(t, graph('p1'));
  assert.equal(h.state().settings.language, 'auto');
  await h.call('save-settings', { language: 'Indonesian' });
  assert.equal(h.state().settings.language, 'Indonesian');

  const graphPlan = await h.call('preflight', { propositionIds: ['p1'] });
  assert.ok(graphPlan.id);
  await h.call('start-generation', { preflightId: graphPlan.id, requestId: 'test-lang-graph' });
  await flush();
  const graphTask = h.workers.service.list().find(t => t.requestId === h.state().batch.chunks[0].requestId);
  assert.ok(graphTask.prompt.includes('Language: Generate all facts, cues, questions, and answers in Indonesian.'));
  await h.complete(graphTask, result(cards('p1', 'Pertanyaan', 'Jawaban')));
  assert.equal(h.state().batch.status, 'completed');

  const filePlan = await h.call('preflight-file', { name: 'test.md', markdown: '# Fact\nSome statement.' });
  await h.call('start-generation', { preflightId: filePlan.id, requestId: 'test-lang-file' });
  await flush();
  const fileTask = h.workers.service.list().find(t => t.requestId === h.state().batch.chunks[0].requestId);
  assert.ok(fileTask.prompt.includes('Language: Generate all facts, cues, questions, and answers in Indonesian.'));
});
