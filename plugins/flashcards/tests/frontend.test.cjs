const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseHTML } = require('linkedom');
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

// Deliberately public-API-only UI double. Also reusable as a disposable browser fixture.
function fixture(document) {
  const app = document.createElement('main'); document.body.append(app);
  const settings = document.createElement('aside'); document.body.append(settings);
  const controller = new AbortController();
  const calls = [], markdowns = [], registrations = [], handles = [], cleanups = [];
  const listeners = new Set(), resync = new Set(), appEvents = new Set();
  let view, settingsMount;
  let state = {
    revision: 1,
    settings: { retention: .9, learningSteps: [1, 10], relearningSteps: [10], dayStart: 4, fuzz: false, chunkBudget: 4000, modelOverride: null },
    decks: [{ id: 'd1', name: 'Notes', newLimit: 20, newToday: 0, due: 1, propositionIds: ['p1'] }, { id: 'd2', name: 'Custom', newLimit: 20, newToday: 0, due: 0, propositionIds: [] }],
    propositions: [{ id: 'p1', name: 'Fact one', statement: 'A useful statement', memberships: ['d1'], cues: [{ id: 'c1', question: 'Question **one**?', answer: 'SECRET ANSWER' }], schedule: {}, archived: false, version: 1 }], batch: null,
  };
  const overrides = {};
  const clone = value => JSON.parse(JSON.stringify(value));
  function handle(kind, container, props, signal, render) {
    let current = props, disposed = false;
    const mount = { kind, get props() { return current; }, signal, update(next) { if (!disposed) { current = { ...current, ...next }; render?.(current); } }, dispose() { if (disposed) return; disposed = true; container.replaceChildren(); }, get disposed() { return disposed; } };
    handles.push(mount); signal.addEventListener('abort', () => mount.dispose(), { once: true }); render?.(current); return mount;
  }
  const ctx = {
    signal: controller.signal, manifest: { id: 'flashcards' }, cleanup(fn) { cleanups.push(fn); },
    registerView(value) { view = value; return () => {}; },
    registerAction(value) { registrations.push(value); return () => {}; },
    placeAction(value) { registrations.push(value); return () => {}; },
    registerSettings(value) { settingsMount = value; return () => {}; },
    app: { openView(id) { calls.push(['openView', id]); } },
    onNotification(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onResync(fn) { resync.add(fn); return () => resync.delete(fn); },
    onAppEvent(fn) { appEvents.add(fn); return () => appEvents.delete(fn); },
    async call(operation, input) {
      calls.push([operation, input]);
      if (overrides[operation]) return overrides[operation](input);
      if (operation === 'get-state' || operation === 'resume-results') return clone(state);
      if (operation === 'get-catalog') return { slots: { cheap: { model: { provider: 'test', id: 'cheap' } } } };
      if (operation === 'preflight') return { id: 'pf', propositionCount: input.propositionIds.length, chunkCount: 1, estimatedTokens: 123, modelLabel: 'Test model' };
      if (operation === 'next-review') return { ticket: { id: 't1', propositionId: 'p1', cueId: 'c1', question: 'Question **one**?', propositionName: 'Fact one' }, remaining: 1 };
      if (operation === 'reveal-review') return { answer: 'SECRET ANSWER', intervals: { 1: 60000, 2: 300000, 3: 600000, 4: 86400000 } };
      if (operation === 'rate-review') return { ok: true };
      if (operation === 'save-settings') { state.settings = { ...state.settings, ...input }; }
      if (operation === 'save-cue') { Object.assign(state.propositions[0].cues[0], { question: input.question, answer: input.answer }); state.propositions[0].version++; }
      if (operation === 'set-memberships') state.propositions[0].memberships = input.deckIds;
      if (operation === 'reorder') {
        const list = input.kind === 'deck' ? state.decks : input.kind === 'proposition' ? state.decks.find(d => d.id === input.deckId).propositionIds : state.propositions.find(p => p.id === input.propositionId).cues;
        const index = list.findIndex(item => (typeof item === 'string' ? item : item.id) === input.id);
        const other = index + input.direction; [list[index], list[other]] = [list[other], list[index]];
      }
      if (operation === 'start-generation') state.batch = { id: 'b1', status: 'running', chunks: [{ id: 'chunk1', status: 'running', targetIds: ['p1'] }], added: 0, completed: 0, total: 1, failedTargetIds: [] };
      state.revision++; return clone(state);
    },
    ui: {
      mountButton(container, props, { signal }) {
        const button = document.createElement('button'); container.append(button);
        button.addEventListener('click', () => { if (!button.disabled) Promise.resolve(mount.props.onClick()).catch(() => {}); });
        const mount = handle('button', container, props, signal, p => { button.textContent = p.label; button.disabled = !!p.disabled; if (p.title) button.title = p.title; }); return mount;
      },
      mountMarkdown(container, props, { signal }) { markdowns.push({ text: props.text, signal }); return handle('markdown', container, props, signal, p => { container.textContent = p.text; }); },
      mountKnowledgePicker(container, props, { signal }) {
        const button = document.createElement('button'); button.textContent = 'Pick nodes'; container.append(button);
        const mount = handle('knowledge', container, props, signal); button.onclick = () => mount.props.onChange(['p1']); return mount;
      },
      mountSettingsRows(container, props, { signal }) {
        return handle('rows', container, props, signal, p => { container.textContent = p.rows.map(row => `${row.label}: ${row.value}`).join('\n'); });
      },
      mountModelPicker(container, props, { signal }) { return handle('model', container, props, signal); },
      mountThinkingPicker(container, props, { signal }) { return handle('thinking', container, props, signal); },
      openDialog(props, { signal }) {
        const container = document.createElement('section'); container.setAttribute('role', 'dialog'); document.body.append(container);
        const title = document.createElement('h2'); title.textContent = props.title; container.append(title);
        const scope = new AbortController(); signal.addEventListener('abort', () => scope.abort(), { once: true });
        const cleanup = props.content(container, scope.signal);
        let disposed = false;
        const mount = { dispose() { if (disposed) return; disposed = true; scope.abort(); cleanup?.(); container.remove(); }, update() {} };
        signal.addEventListener('abort', () => mount.dispose(), { once: true }); return mount;
      },
    },
  };
  let viewController, viewCleanup, settingsController, settingsCleanup;
  return {
    ctx, app, settings, calls, markdowns, handles, registrations, overrides,
    get state() { return state; },
    mount() { viewController = new AbortController(); viewCleanup = view.mount(app, viewController.signal); },
    unmount() { viewController?.abort(); viewCleanup?.(); },
    mountSettings() { settingsController = new AbortController(); settingsCleanup = settingsMount(settings, settingsController.signal); },
    notify() { for (const fn of listeners) fn({ pluginId: 'flashcards', topic: 'changed' }); },
    resync() { for (const fn of resync) fn(); },
    appEvent(type) { for (const fn of appEvents) fn({ type }); },
    dispose() { this.unmount(); settingsController?.abort(); settingsCleanup?.(); controller.abort(); for (const fn of cleanups) fn(); app.remove(); settings.remove(); },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function setup() {
  const { document } = parseHTML('<html><body></body></html>');
  global.document = document;
  if (!global.crypto) global.crypto = require('node:crypto').webcrypto;
  const { activate } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const h = fixture(document); activate(h.ctx); h.mount(); await flush(); return h;
}
function click(h, name, root = h.app) {
  const button = [...root.querySelectorAll('button')].find(button => button.textContent === name);
  assert.ok(button, `Missing button: ${name}`); assert.equal(button.disabled, false, `Disabled button: ${name}`); button.click();
}
function openAll(h) {
  for (let index = 0; index < 3; index++) for (const details of h.app.querySelectorAll('details')) {
    details.open = true; details.dispatchEvent(new document.defaultView.Event('toggle'));
  }
}

test('native library, host placements, explicit preflight and no navigation cancellation', async () => {
  const h = await setup();
  try {
    assert.equal(h.registrations.find(r => r.id === 'open-sidebar').location, 'sidebar');
    assert.equal(h.registrations.find(r => r.id === 'open-graph').location, 'graph');
    assert.ok(h.app.textContent.includes('Notes'));
    assert.equal(h.markdowns.length, 0, 'collapsed library mounts no card content');
    click(h, 'Pick nodes'); click(h, 'Generate'); await flush();
    assert.equal(h.calls.filter(([op]) => op === 'start-generation').length, 0);
    assert.ok(document.querySelector('[role=dialog]').textContent.includes('123 input tokens'));
    click(h, 'Start', document); await flush();
    assert.equal(h.calls.filter(([op]) => op === 'start-generation').length, 1);
    h.unmount(); h.notify(); h.resync(); await flush();
    assert.equal(h.calls.filter(([op]) => op === 'cancel-generation').length, 0);
    const reads = h.calls.filter(([op]) => op === 'get-state').length;
    h.notify(); await flush(); assert.equal(h.calls.filter(([op]) => op === 'get-state').length, reads);
  } finally { h.dispose(); }
});

test('review does not mount answer before reveal; rating retries retain request identity', async () => {
  const h = await setup();
  try {
    click(h, 'Review all'); await flush();
    assert.equal(h.markdowns.some(item => item.text === 'SECRET ANSWER'), false);
    click(h, 'Reveal answer · Space'); await flush();
    assert.equal(h.markdowns.filter(item => item.text === 'SECRET ANSWER').length, 1);
    h.overrides['rate-review'] = async () => { throw new Error('Save unavailable'); };
    click(h, '3 Good · 10m'); await flush();
    assert.ok(h.app.textContent.includes('Save unavailable'));
    assert.ok([...h.app.querySelectorAll('button')].some(button => button.textContent === 'Retry next card'));
    h.overrides['rate-review'] = async () => ({ ok: true });
    click(h, '3 Good · 10m'); await flush();
    const rates = h.calls.filter(([op]) => op === 'rate-review');
    assert.equal(rates.length, 2); assert.equal(rates[0][1].requestId, rates[1][1].requestId);
    assert.equal(h.app.querySelector('.fc-review').textContent.includes('SECRET ANSWER'), false);
  } finally { h.dispose(); }
});

test('late reveal and next-card responses cannot revive an ended review', async () => {
  const h = await setup();
  try {
    click(h, 'Review all'); await flush();
    const wait = deferred(); h.overrides['reveal-review'] = () => wait.promise;
    click(h, 'Reveal answer · Space'); click(h, 'End review');
    wait.resolve({ answer: 'LATE SECRET', intervals: {} }); await flush();
    assert.equal(h.markdowns.some(item => item.text === 'LATE SECRET'), false);
    const next = deferred(); h.overrides['next-review'] = () => next.promise;
    click(h, 'Review all'); click(h, 'End review');
    next.resolve({ ticket: { id: 'late', question: 'LATE QUESTION' } }); await flush();
    assert.equal(h.app.textContent.includes('LATE QUESTION'), false);
  } finally { h.dispose(); }
});

test('cue editor retains failed drafts and sends version; archive is read-only', async () => {
  const h = await setup();
  try {
    openAll(h); click(h, 'Edit');
    const dialog = document.querySelector('[role=dialog]');
    const question = dialog.querySelector('textarea'); question.value = 'Edited draft';
    h.overrides['save-cue'] = async () => { throw new Error('Version conflict'); };
    click(h, 'Save', dialog); await flush();
    assert.equal(question.value, 'Edited draft'); assert.ok(dialog.textContent.includes('Version conflict'));
    assert.equal(h.calls.find(([op]) => op === 'save-cue')[1].version, 1);
    click(h, 'Cancel', dialog);
    h.state.propositions[0].archived = true; h.state.revision++; h.notify(); await flush(); openAll(h);
    assert.ok(h.app.textContent.includes('Archive'));
    assert.equal([...h.app.querySelectorAll('button')].some(button => button.textContent === 'Edit'), false);
  } finally { h.dispose(); }
});

test('settings parse minutes/hours, retain failed drafts and use acknowledged values', async () => {
  const h = await setup();
  try {
    h.mountSettings(); await flush();
    const rows = h.handles.find(handle => handle.kind === 'rows');
    assert.equal(rows.props.rows.some(row => row.key === 'fuzz'), false);
    const find = key => rows.props.rows.find(row => row.key === key);
    await find('learningSteps').onChange('1m, 1h');
    assert.deepEqual(h.calls.find(([op]) => op === 'save-settings')[1].learningSteps, [1, 60]);
    assert.equal(find('learningSteps').value, '1m 60m');
    await find('retention').onChange(95); assert.equal(h.state.settings.retention, .95);
    const before = h.calls.filter(([op]) => op === 'save-settings').length;
    await assert.rejects(find('learningSteps').onChange('10m 1m'), /increasing/);
    assert.equal(h.calls.filter(([op]) => op === 'save-settings').length, before);
    h.overrides['save-settings'] = async () => { throw new Error('Disk full'); };
    await assert.rejects(find('dayStart').onChange(7), /Disk full/);
    assert.ok(h.settings.textContent.includes('Disk full'));
    h.notify(); await flush(); assert.ok(h.settings.textContent.includes('Disk full'));
  } finally { h.dispose(); }
});

test('snapshot revisions prevent rollback and failed generation retry requires confirmation', async () => {
  const h = await setup();
  try {
    const old = JSON.parse(JSON.stringify(h.state));
    h.state.revision = 3; h.state.decks[0].name = 'New name'; h.notify(); await flush();
    h.overrides['get-state'] = async () => old; h.notify(); await flush();
    assert.ok(h.app.textContent.includes('New name'));
    delete h.overrides['get-state'];
    h.state.batch = { id: 'b', status: 'partial', chunks: [{ id: 'ch', status: 'failed', targetIds: ['p1'], error: 'Worker failed' }], added: 2, completed: 1, total: 1, failedTargetIds: ['p1'], error: 'Disk write failed' };
    h.state.revision++; h.notify(); await flush();
    click(h, 'Retry failed…'); await flush();
    assert.deepEqual(h.calls.findLast(([op]) => op === 'preflight')[1].propositionIds, ['p1']);
    assert.equal(h.calls.filter(([op]) => op === 'start-generation').length, 0);
    click(h, 'Cancel', document.querySelector('[role=dialog]'));
    click(h, 'Retry saving'); await flush();
    assert.equal(h.calls.filter(([op]) => op === 'resume-results').length, 1);
  } finally { h.dispose(); }
});

test('deck ordering and Up/Down controls use public reorder scopes', async () => {
  const h = await setup();
  try {
    h.state.propositions.push({ ...JSON.parse(JSON.stringify(h.state.propositions[0])), id: 'p2', name: 'Fact two', cues: [{ id: 'c2', question: 'Second cue', answer: 'Second answer' }] });
    h.state.decks[0].propositionIds = ['p2', 'p1'];
    h.state.propositions[0].cues.push({ id: 'c3', question: 'Third cue', answer: 'Third answer' });
    h.state.revision++; h.notify(); await flush(); openAll(h);
    const firstDeck = h.app.querySelector('.fc-tree > details');
    const propNames = [...firstDeck.querySelector('.fc-folder-body').children].filter(node => node.tagName === 'DETAILS').map(node => node.querySelector('summary').textContent);
    assert.deepEqual(propNames, ['Fact two · 1 cues', 'Fact one · 2 cues']);
    firstDeck.querySelector('button[title="Move deck down"]').click(); await flush();
    assert.deepEqual(h.calls.findLast(([op]) => op === 'reorder')[1], { kind: 'deck', id: 'd1', direction: 1 });
    openAll(h);
    const propUp = [...h.app.querySelectorAll('button[title="Move proposition up"]')].find(button => !button.disabled);
    propUp.click(); await flush();
    assert.deepEqual(h.calls.findLast(([op]) => op === 'reorder')[1], { kind: 'proposition', id: 'p1', deckId: 'd1', direction: -1 });
    openAll(h);
    const cueDown = [...h.app.querySelectorAll('button[title="Move cue down"]')].find(button => !button.disabled);
    cueDown.click(); await flush();
    assert.deepEqual(h.calls.findLast(([op]) => op === 'reorder')[1], { kind: 'cue', id: 'c1', propositionId: 'p1', direction: 1 });
  } finally { h.dispose(); }
});

test('memberships require one deck and deck deletion requires explicit replacement', async () => {
  const h = await setup();
  try {
    openAll(h); click(h, 'Decks…');
    const dialog = document.querySelector('[role=dialog]');
    const checkboxes = [...dialog.querySelectorAll('input')]; checkboxes.forEach(input => { input.checked = false; });
    click(h, 'Save memberships', dialog); await flush();
    assert.ok(dialog.textContent.includes('Choose at least one deck'));
    assert.equal(h.calls.some(([op]) => op === 'set-memberships'), false);
    click(h, 'Cancel', dialog);
    click(h, 'Deck settings'); click(h, 'Delete deck…', document.querySelector('[role=dialog]'));
    const deletion = [...document.querySelectorAll('[role=dialog]')].at(-1);
    assert.ok(deletion.querySelector('select'));
    click(h, 'Delete deck', deletion); await flush();
    assert.ok(deletion.textContent.includes('Choose a replacement deck'));
    assert.equal(h.calls.some(([op]) => op === 'delete-deck'), false);
  } finally { h.dispose(); }
});

test('core source/extraction events refresh Archive only while mounted', async () => {
  const h = await setup();
  try {
    h.state.propositions[0].archived = true; h.state.revision++;
    h.appEvent('sources-changed'); await flush(); assert.ok(h.app.textContent.includes('Archive'));
    h.state.propositions[0].archived = false; h.state.revision++;
    h.appEvent('activity-changed'); await flush(); assert.equal(h.app.textContent.includes('Archive'), false);
    h.unmount(); const count = h.calls.length;
    h.appEvent('activity-changed'); h.appEvent('sources-changed'); await flush(); assert.equal(h.calls.length, count);
  } finally { h.dispose(); }
});

test('visible waiting review owns exactly one timer and clears it on end', async () => {
  const h = await setup();
  const realSet = global.setTimeout, realClear = global.clearTimeout;
  const timers = new Map(); let timerId = 0;
  global.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  global.clearTimeout = id => timers.delete(id);
  try {
    h.overrides['next-review'] = async () => ({ ticket: null, nextDue: Date.now() + 60000 });
    click(h, 'Review all'); await flush(); assert.equal(timers.size, 1);
    h.notify(); await flush(); assert.equal(timers.size, 1);
    click(h, 'End review'); assert.equal(timers.size, 0);
    click(h, 'Review all'); await flush(); assert.equal(timers.size, 1);
    h.unmount(); assert.equal(timers.size, 0);
  } finally { global.setTimeout = realSet; global.clearTimeout = realClear; h.dispose(); }
});

test('stale ticket error can fetch a fresh review ticket', async () => {
  const h = await setup();
  try {
    click(h, 'Review all'); await flush(); click(h, 'Reveal answer · Space'); await flush();
    h.overrides['rate-review'] = async () => { throw new Error('This card changed elsewhere'); };
    click(h, '3 Good · 10m'); await flush();
    const before = h.calls.filter(([op]) => op === 'next-review').length;
    click(h, 'Retry next card'); await flush();
    assert.equal(h.calls.filter(([op]) => op === 'next-review').length, before + 1);
    assert.equal(h.app.querySelector('.fc-review').textContent.includes('SECRET ANSWER'), false);
  } finally { h.dispose(); }
});

test('search disables all ordering controls with an explicit explanation', async () => {
  const h = await setup();
  try {
    const search = h.app.querySelector('input[type=search]'); search.value = 'Fact';
    search.dispatchEvent(new document.defaultView.Event('input')); openAll(h);
    const controls = [...h.app.querySelectorAll('button[title="Clear search to reorder"]')];
    assert.ok(controls.length >= 6); assert.ok(controls.every(button => button.disabled));
  } finally { h.dispose(); }
});

test('activation reports missing public host capabilities clearly', async () => {
  const { activate } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  for (const missing of ['mountMarkdown', 'mountKnowledgePicker']) {
    const ui = { mountMarkdown() {}, mountKnowledgePicker() {} }; delete ui[missing];
    assert.throws(() => activate({ ui }), error => error instanceof Error && !(error instanceof TypeError) && error.message.includes(missing) && error.message.includes('update LearnHarness'));
  }
});

if (process.env.FLASHCARDS_BROWSER_FIXTURE) {
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>' + fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8') + '</style></head><body><script type="module">' + source + '\nwindow.h = (' + fixture.toString() + ')(document); activate(window.h.ctx); window.h.mount();</script></body></html>';
  fs.writeFileSync(process.env.FLASHCARDS_BROWSER_FIXTURE, html);
}
