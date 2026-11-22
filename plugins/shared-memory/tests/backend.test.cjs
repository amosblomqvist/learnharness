'use strict';
// Behaviour of the Shared Memory backend through its only seam, activate(ctx):
// a fake ctx (stub graph, temporary data directory) and a loopback fake
// shared-memory MCP server. Tests look only at operation results, emitted
// notifications and the write calls the fake server received.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { activate } = require('../src/backend.cjs');
const { startFakeSharedMemory, unreachableUrl } = require('./fake-shared-memory.cjs');

const DATE = '2026-03-04T10:00:00.000Z';
const node = (id, extra = {}) => ({
  id, name: `Name ${id}`, statement: `Statement ${id}.`, aliases: [], createdAt: DATE,
  provenance: [{ chatId: 'chat-1', messageId: 'm-1' }], ...extra,
});
const graphOf = (propositions, extra = {}) => ({
  propositions, chains: [], sessions: { 'chat-1': 'Lesson one' }, fileSources: { 'src_notes': '/home/me/notes/Physics notes.md' }, clusters: [], ...extra,
});

async function until(check, label = 'condition') {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function harness(t, graph, { connect = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-memory-test-'));
  const server = await startFakeSharedMemory();
  const h = { graph, server, directory, events: [] };
  let handlers = new Map(), controller, cleanups = [];
  h.dispose = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); controller?.abort(); };
  h.activate = () => {
    h.dispose(); handlers = new Map(); controller = new AbortController();
    activate({
      dataDirectory: directory, signal: controller.signal,
      learning: { graph: () => structuredClone(h.graph) },
      events: { emit: (topic, data) => h.events.push({ topic, data: structuredClone(data) }) },
      handle: (name, handler) => { assert.ok(!handlers.has(name), name); handlers.set(name, handler); return () => handlers.delete(name); },
      cleanup: fn => { assert.equal(typeof fn, 'function'); cleanups.push(fn); },
    });
  };
  h.operations = () => [...handlers.keys()].sort();
  h.call = async (name, input) => { assert.ok(handlers.has(name), name); return handlers.get(name)(input); };
  h.list = async () => (await h.call('list', {})).items;
  h.states = async () => Object.fromEntries((await h.list()).map(item => [item.id, item.state]));
  h.send = ids => h.call('send', { ids });
  h.activate();
  t.after(async () => { h.dispose(); await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  // Never let a test reach the default (real) shared-memory URL.
  if (connect) await h.call('set-settings', { url: server.url });
  return h;
}

test('activation registers exactly the five operations and does not contact shared memory', async t => {
  const h = await harness(t, graphOf([node('p1')]));
  assert.deepEqual(h.operations(), ['get-settings', 'list', 'send', 'set-settings', 'stop']);
  h.activate();
  await h.list();
  assert.equal(h.server.requests, 0);

  // Activation succeeds even when nothing listens at the configured URL.
  await h.call('set-settings', { url: await unreachableUrl() });
  assert.doesNotThrow(() => h.activate());
  assert.deepEqual(await h.states(), { p1: 'unsent' });
});

test('settings default, validate, persist across activation and drive the next send', async t => {
  const h = await harness(t, graphOf([node('p1')]), { connect: false });
  assert.deepEqual(await h.call('get-settings', {}), { url: 'http://127.0.0.1:7820/mcp', scope: 'project:learning' });

  for (const url of ['not a url', 'ftp://127.0.0.1/mcp', '', '   ', 42]) {
    await assert.rejects(h.call('set-settings', { url }), /http or https URL/);
  }
  for (const scope of ['', '   ', null]) {
    await assert.rejects(h.call('set-settings', { scope }), /scope must not be blank/);
  }
  await assert.rejects(h.call('set-settings', { url: h.server.url, scope: '' }), /scope must not be blank/);
  assert.deepEqual(await h.call('get-settings', {}), { url: 'http://127.0.0.1:7820/mcp', scope: 'project:learning' });

  assert.deepEqual(await h.call('set-settings', { url: h.server.url, scope: 'project:physics' }), { url: h.server.url, scope: 'project:physics' });
  h.activate();
  assert.deepEqual(await h.call('get-settings', {}), { url: h.server.url, scope: 'project:physics' });

  await h.send(['p1']);
  assert.equal(h.server.writes.length, 1);
  assert.equal(h.server.writes[0].scope, 'project:physics');
});

test('a write carries the title, the spec body, the fixed fields and the cluster tag, without source_path', async t => {
  const graph = graphOf([
    node('p1'), node('p2'), node('p4'),
    node('p3', { aliases: ['Alias A', 'Alias B'], provenance: [{ chatId: 'chat-1', messageId: 'm-1' }, { chatId: 'src_notes', messageId: '' }, { chatId: 'chat-1', messageId: 'm-2' }] }),
    node('p5', { provenance: [{ chatId: 'src_notes', messageId: '' }] }),
  ], {
    chains: [
      { id: 'arg_b', premises: ['p4'], conclusion: 'p3', provenance: [], createdAt: DATE },
      { id: 'arg_a', premises: ['p1', 'p2'], conclusion: 'p3', provenance: [], createdAt: DATE },
    ],
    clusters: [{ id: 'c1', label: 'Mechanics', members: ['p1', 'p2', 'p3'] }, { id: 'c2', label: null, members: ['p4', 'p5'] }],
  });
  const h = await harness(t, graph);
  const result = await h.send(['p3', 'p5']);
  assert.deepEqual(result.results.map(r => r.outcome), ['written', 'written']);

  assert.deepEqual(h.server.writes[0], {
    title: 'Name p3',
    content: [
      'Statement p3.',
      '',
      '別名: Alias A, Alias B',
      '',
      '## 前提（この命題を導く推論の連鎖）',
      '- Statement p1.',
      '- Statement p2.',
      '',
      '- Statement p4.',
      '',
      '## 出典',
      '- Lesson one (2026-03-04)',
      '- Physics notes',
    ].join('\n'),
    scope: 'project:learning',
    kind: 'semantic',
    provenance: 'agent_inferred',
    source_agent: 'learnharness',
    tags: ['learnharness', 'Mechanics'],
  });
  // No aliases, no chains, an unlabeled cluster: those parts are left out.
  assert.deepEqual(h.server.writes[1], {
    title: 'Name p5', content: 'Statement p5.\n\n## 出典\n- Physics notes', scope: 'project:learning',
    kind: 'semantic', provenance: 'agent_inferred', source_agent: 'learnharness', tags: ['learnharness'],
  });
  for (const write of h.server.writes) {
    assert.equal(Object.hasOwn(write, 'source_path'), false);
    assert.equal(Object.hasOwn(write, 'supersedes'), false);
  }
});

test('the list shows unsent, changed and removed propositions only, and follows content back and forth', async t => {
  const h = await harness(t, graphOf([node('p1'), node('p2'), node('p3')]));
  assert.deepEqual(await h.call('list', {}), {
    items: ['p1', 'p2', 'p3'].map(id => ({ id, name: `Name ${id}`, statement: `Statement ${id}.`, state: 'unsent' })),
    progress: { sending: false },
  });

  await h.send(['p1', 'p2']);
  assert.deepEqual(await h.states(), { p3: 'unsent' });

  // Any part of the content changes the state: statement, aliases, premises, sources, cluster.
  const original = structuredClone(h.graph);
  const variants = [
    g => { g.propositions[0].statement = 'Statement p1, revised.'; },
    g => { g.propositions[0].aliases = ['Another phrasing']; },
    g => { g.chains = [{ id: 'arg_1', premises: ['p3'], conclusion: 'p1', provenance: [], createdAt: DATE }]; },
    g => { g.sessions['chat-1'] = 'Lesson one, renamed'; },
    g => { g.clusters = [{ id: 'c', label: 'Cluster', members: ['p1'] }]; },
  ];
  for (const change of variants) {
    h.graph = structuredClone(original); change(h.graph);
    assert.equal((await h.states()).p1, 'changed');
  }
  // Back to the content that was sent: sent again, not listed.
  h.graph = structuredClone(original);
  assert.deepEqual(await h.states(), { p3: 'unsent' });

  // A sent proposition leaves the graph: removed. A never-sent one leaving is simply gone.
  h.graph = graphOf([node('p1')]);
  const items = await h.list();
  assert.deepEqual(items, [{ id: 'p2', name: 'Name p2', statement: null, state: 'removed' }]);

  // Coming back with the same content before retirement: sent again.
  h.graph = original;
  assert.deepEqual(await h.states(), { p3: 'unsent' });
  // Coming back with different content: changed.
  h.graph = graphOf([node('p1'), node('p2', { statement: 'Different.' }), node('p3')]);
  assert.deepEqual(await h.states(), { p2: 'changed', p3: 'unsent' });
});

test('changed, retired and returning propositions supersede the previous memory', async t => {
  const h = await harness(t, graphOf([node('p1'), node('p2')]));
  const first = await h.send(['p1', 'p2']);
  const [m1, m2] = first.results.map(r => r.memoryId);
  assert.ok(m1 && m2 && m1 !== m2);

  // Changed: the new memory replaces the last one.
  h.graph = graphOf([node('p1', { statement: 'Revised p1.' }), node('p2')]);
  const changed = await h.send(['p1']);
  assert.deepEqual(changed.results.map(r => [r.outcome, r.state]), [['written', 'changed']]);
  assert.equal(h.server.writes.at(-1).supersedes, m1);
  assert.equal(h.server.writes.at(-1).content.startsWith('Revised p1.'), true);
  const m1b = changed.results[0].memoryId;

  // Removed: a retirement memory replaces the last one; afterwards it is retired and not listed.
  h.graph = graphOf([node('p2')]);
  assert.deepEqual(await h.states(), { p1: 'removed' });
  const retired = await h.send(['p1']);
  assert.deepEqual(retired.results.map(r => [r.outcome, r.state]), [['written', 'removed']]);
  assert.deepEqual(h.server.writes.at(-1), {
    title: '廃止: Name p1', content: 'LearnHarness の知識グラフから消えたため廃止した。', scope: 'project:learning',
    kind: 'semantic', provenance: 'agent_inferred', source_agent: 'learnharness', tags: ['learnharness'], supersedes: m1b,
  });
  assert.deepEqual(await h.states(), {});
  // A retired proposition is not sent again while it stays out of the graph.
  const again = await h.send(['p1']);
  assert.deepEqual(again.results.map(r => r.outcome), ['skipped']);
  assert.equal(h.server.writes.length, 4);

  // Back in the graph after retirement: unsent, and sending replaces the retirement memory.
  h.graph = graphOf([node('p1', { statement: 'Revised p1.' }), node('p2')]);
  assert.deepEqual(await h.states(), { p1: 'unsent' });
  await h.send(['p1']);
  assert.equal(h.server.writes.at(-1).supersedes, retired.results[0].memoryId);
  assert.equal(h.server.writes.at(-1).title, 'Name p1');
  assert.deepEqual(await h.states(), {});
});

test('sending reports each proposition and notifies progress for every item', async t => {
  const h = await harness(t, graphOf([node('p1'), node('p2'), node('p3')]));
  h.events.length = 0;
  const result = await h.send(['p1', 'p2', 'p3', 'p2']);
  assert.equal(result.stopped, false);
  assert.equal(result.total, 3);
  assert.equal(result.done, 3);
  assert.deepEqual(result.results.map(r => [r.id, r.outcome, r.state]), [['p1', 'written', 'unsent'], ['p2', 'written', 'unsent'], ['p3', 'written', 'unsent']]);
  assert.deepEqual(h.server.writes.map(w => w.title), ['Name p1', 'Name p2', 'Name p3']);
  assert.deepEqual(h.events.filter(e => e.topic === 'progress').map(e => [e.data.done, e.data.total]), [[0, 3], [1, 3], [2, 3], [3, 3]]);
  assert.deepEqual(h.events.at(-1), { topic: 'finished', data: { stopped: false, total: 3, done: 3 } });
  assert.deepEqual((await h.call('list', {})).progress, { sending: false });
  await assert.rejects(h.send([]), /at least one/);
});

test('the list includes progress while a send is under way and a second send is refused', async t => {
  const h = await harness(t, graphOf([node('p1'), node('p2')]));
  const gate = deferred();
  h.server.behavior = async (_args, index) => { if (index === 1) await gate.promise; };
  const sending = h.send(['p1', 'p2']);
  await until(() => h.server.writes.length === 2, 'second write');
  const listed = await h.call('list', {});
  assert.deepEqual(listed.progress, { sending: true, total: 2, done: 1, stopping: false });
  assert.deepEqual(listed.items.map(i => i.id), ['p2']);
  await assert.rejects(h.send(['p2']), /already sending/);
  gate.resolve();
  await sending;
  assert.deepEqual((await h.call('list', {})).progress, { sending: false });
});

test('a rejected write keeps the server message, leaves the proposition listed and the record unchanged', async t => {
  const h = await harness(t, graphOf([node('p1'), node('p2'), node('p3')]));
  const firstP2 = (await h.send(['p2'])).results[0].memoryId;
  h.graph = graphOf([node('p1'), node('p2', { statement: 'Revised p2.' }), node('p3')]);
  const message = 'write rejected: content looks like a secret (api key)';
  h.server.behavior = args => (args.title === 'Name p2' || args.title === 'Name p3' ? { reject: message } : undefined);

  const result = await h.send(['p1', 'p2', 'p3']);
  assert.deepEqual(result.results.map(r => [r.id, r.outcome]), [['p1', 'written'], ['p2', 'failed'], ['p3', 'failed']]);
  assert.deepEqual(result.results[1].reason, { kind: 'rejected', message });

  // Only the successful proposition became sent; the failed ones keep their states and reasons.
  assert.deepEqual(await h.list(), [
    { id: 'p2', name: 'Name p2', statement: 'Revised p2.', state: 'changed', reason: { kind: 'rejected', message } },
    { id: 'p3', name: 'Name p3', statement: 'Statement p3.', state: 'unsent', reason: { kind: 'rejected', message } },
  ]);

  // The sent record did not move: the retry still supersedes the original memory, and p3 still has none.
  h.server.behavior = () => undefined;
  const retry = await h.send(['p2', 'p3']);
  assert.deepEqual(retry.results.map(r => r.outcome), ['written', 'written']);
  const [p2Retry, p3Retry] = h.server.writes.slice(-2);
  assert.equal(p2Retry.supersedes, firstP2);
  assert.equal(Object.hasOwn(p3Retry, 'supersedes'), false);
  assert.deepEqual(await h.list(), []);
});

test('an unreachable server is reported as such and nothing is recorded', async t => {
  const h = await harness(t, graphOf([node('p1'), node('p2')]));
  await h.send(['p1']);
  h.graph = graphOf([node('p2')]);
  await h.call('set-settings', { url: await unreachableUrl() });

  const result = await h.send(['p1', 'p2']);
  assert.deepEqual(result.results.map(r => [r.outcome, r.reason?.kind]), [['failed', 'unreachable'], ['failed', 'unreachable']]);
  // A failed retirement stays removed (not retired); a failed first send stays unsent.
  assert.deepEqual((await h.list()).map(i => [i.id, i.state, i.reason?.kind]), [['p2', 'unsent', 'unreachable'], ['p1', 'removed', 'unreachable']]);

  await h.call('set-settings', { url: h.server.url });
  await h.send(['p1', 'p2']);
  assert.equal(h.server.writes.at(-2).supersedes, 'mem-1');
  assert.equal(Object.hasOwn(h.server.writes.at(-1), 'supersedes'), false);
  assert.deepEqual(await h.list(), []);
});

test('an HTTP error answer is reported as rejected with the server body, and nothing is recorded', async t => {
  const h = await harness(t, graphOf([node('p1'), node('p2')]));
  const body = 'internal error: database is locked';
  h.server.httpAnswer = message => (message?.method === 'tools/call' ? { status: 500, body } : undefined);

  const result = await h.send(['p1', 'p2']);
  assert.deepEqual(result.results.map(r => [r.id, r.outcome]), [['p1', 'failed'], ['p2', 'failed']]);
  assert.deepEqual(result.results[0].reason, { kind: 'rejected', message: body });
  assert.equal(h.server.writes.length, 0);
  assert.deepEqual((await h.list()).map(i => [i.id, i.state, i.reason?.kind]), [['p1', 'unsent', 'rejected'], ['p2', 'unsent', 'rejected']]);

  h.server.httpAnswer = () => undefined;
  const retry = await h.send(['p1', 'p2']);
  assert.deepEqual(retry.results.map(r => r.outcome), ['written', 'written']);
  assert.equal(h.server.writes.some(args => Object.hasOwn(args, 'supersedes')), false);
  assert.deepEqual(await h.list(), []);
});

test('a write without an answer within 15 seconds fails as a timeout', { timeout: 60_000 }, async t => {
  const h = await harness(t, graphOf([node('p1'), node('p2')]));
  h.server.behavior = (_args, index) => (index === 0 ? { delayMs: 16_000 } : undefined);
  const started = Date.now();
  const result = await h.send(['p1', 'p2']);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 14_900 && elapsed < 16_000, `elapsed ${elapsed}ms`);
  assert.deepEqual(result.results.map(r => [r.id, r.outcome, r.reason?.kind]), [['p1', 'failed', 'timeout'], ['p2', 'written', undefined]]);
  assert.deepEqual((await h.list()).map(i => [i.id, i.state, i.reason?.kind]), [['p1', 'unsent', 'timeout']]);
});

test('stop returns at once, the write in flight finishes and is recorded, later propositions are not written', async t => {
  const h = await harness(t, graphOf([node('p1'), node('p2'), node('p3')]));
  const gate = deferred();
  h.server.behavior = async () => { await gate.promise; };
  h.events.length = 0;
  const sending = h.send(['p1', 'p2', 'p3']);
  await until(() => h.server.writes.length === 1, 'first write');

  // Stop does not wait for the write in flight.
  assert.deepEqual(await h.call('stop', {}), { stopping: true });
  assert.equal((await h.call('list', {})).progress.stopping, true);
  gate.resolve();
  const result = await sending;

  assert.equal(result.stopped, true);
  assert.deepEqual(result.results.map(r => [r.id, r.outcome]), [['p1', 'written'], ['p2', 'not-sent'], ['p3', 'not-sent']]);
  assert.deepEqual(h.server.writes.map(w => w.title), ['Name p1']);
  assert.deepEqual(h.events.at(-1), { topic: 'finished', data: { stopped: true, total: 3, done: 1 } });
  assert.deepEqual(await h.list(), [
    { id: 'p2', name: 'Name p2', statement: 'Statement p2.', state: 'unsent' },
    { id: 'p3', name: 'Name p3', statement: 'Statement p3.', state: 'unsent' },
  ]);
  // Nothing more arrives later.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.server.writes.length, 1);
  assert.deepEqual(await h.call('stop', {}), { stopping: false });
});

test('a memory whose sent record could not be saved is superseded by the next send', async t => {
  const h = await harness(t, graphOf([node('p1'), node('p2')]));
  const recordFile = path.join(h.directory, 'sent-record.json');
  // A directory in place of the record file makes the local save fail after the write succeeded.
  h.server.behavior = (_args, index) => { if (index === 0) fs.mkdirSync(recordFile); };
  const result = await h.send(['p1', 'p2']);
  assert.deepEqual(result.results.map(r => [r.id, r.outcome, r.reason?.kind]), [['p1', 'failed', 'unrecorded'], ['p2', 'not-sent', undefined]]);
  assert.equal(result.results[0].memoryId, 'mem-1');
  assert.equal(h.server.writes.length, 1);

  fs.rmSync(recordFile, { recursive: true });
  h.server.behavior = () => undefined;
  const retry = await h.send(['p1', 'p2']);
  assert.deepEqual(retry.results.map(r => r.outcome), ['written', 'written']);
  assert.equal(h.server.writes[1].supersedes, 'mem-1');
  assert.equal(Object.hasOwn(h.server.writes[2], 'supersedes'), false);
});

test('a memory whose sent record could not be saved is still superseded after a new activation', async t => {
  const h = await harness(t, graphOf([node('p1')]));
  const recordFile = path.join(h.directory, 'sent-record.json');
  h.server.behavior = (_args, index) => { if (index === 0) fs.mkdirSync(recordFile); };
  assert.equal((await h.send(['p1'])).results[0].reason.kind, 'unrecorded');

  fs.rmSync(recordFile, { recursive: true });
  h.server.behavior = () => undefined;
  h.activate();
  assert.deepEqual(await h.states(), { p1: 'unsent' });
  await h.send(['p1']);
  assert.equal(h.server.writes[1].supersedes, 'mem-1');

  // Once recorded, the next change supersedes the recorded memory, also after another activation.
  h.graph = graphOf([node('p1', { statement: 'Revised p1.' })]);
  h.activate();
  await h.send(['p1']);
  assert.equal(h.server.writes[2].supersedes, 'mem-2');
});

test('when neither the sent record nor the unrecorded memory can be saved, the reason says so', async t => {
  const h = await harness(t, graphOf([node('p1')]));
  h.server.behavior = (_args, index) => {
    if (index === 0) for (const file of ['sent-record.json', 'unrecorded.json']) fs.mkdirSync(path.join(h.directory, file));
  };
  const [result] = (await h.send(['p1'])).results;
  assert.equal(result.reason.kind, 'unrecorded');
  assert.match(result.reason.message, /remembered only until Shared Memory restarts/);

  // Within the same activation the memory is still superseded, not duplicated.
  for (const file of ['sent-record.json', 'unrecorded.json']) fs.rmSync(path.join(h.directory, file), { recursive: true });
  h.server.behavior = () => undefined;
  await h.send(['p1']);
  assert.equal(h.server.writes[1].supersedes, 'mem-1');
});

test('the sent record survives a new activation', async t => {
  const h = await harness(t, graphOf([node('p1'), node('p2')]));
  await h.send(['p1', 'p2']);
  h.activate();
  assert.deepEqual(await h.list(), []);
  h.graph = graphOf([node('p1', { statement: 'Revised.' })]);
  assert.deepEqual(await h.states(), { p1: 'changed', p2: 'removed' });
  h.activate();
  await h.send(['p1', 'p2']);
  assert.deepEqual(h.server.writes.slice(-2).map(w => [w.title, w.supersedes]), [['Name p1', 'mem-1'], ['廃止: Name p2', 'mem-2']]);
  h.activate();
  assert.deepEqual(await h.list(), []);
});

test('never: a failed send is not sent or retired, a never-sent proposition is not retired, no memory duplicates without supersedes', async t => {
  const h = await harness(t, graphOf([node('p1'), node('p2'), node('p3')]));

  // A never-sent proposition leaving the graph is not listed and cannot be retired.
  h.graph = graphOf([node('p1'), node('p2')]);
  assert.deepEqual(await h.states(), { p1: 'unsent', p2: 'unsent' });
  const ghost = await h.send(['p3']);
  assert.deepEqual(ghost.results.map(r => [r.outcome, r.state]), [['skipped', null]]);
  assert.equal(h.server.writes.length, 0);

  // A failed retirement does not retire; a failed first send does not mark sent.
  await h.send(['p1', 'p2']);
  h.graph = graphOf([node('p2')]);
  h.server.behavior = () => ({ reject: 'write rejected: storage unavailable' });
  await h.send(['p1']);
  assert.equal((await h.states()).p1, 'removed');

  // Sending a sent proposition again writes nothing (it would duplicate the memory).
  h.server.behavior = () => undefined;
  const before = h.server.writes.length;
  const repeat = await h.send(['p2']);
  assert.deepEqual(repeat.results.map(r => [r.outcome, r.state]), [['skipped', 'sent']]);
  assert.equal(h.server.writes.length, before);

  // Every later write for a proposition replaces the memory written before it.
  h.graph = graphOf([node('p2', { statement: 'Revised p2.' })]);
  await h.send(['p1', 'p2']);
  const byTitle = id => h.server.writes.filter(w => w.title === `Name ${id}` || w.title === `廃止: Name ${id}`);
  for (const id of ['p1', 'p2']) {
    const writes = byTitle(id);
    assert.equal(Object.hasOwn(writes[0], 'supersedes'), false);
    for (const later of writes.slice(1)) assert.ok(later.supersedes, `${id} later write supersedes`);
  }
});
