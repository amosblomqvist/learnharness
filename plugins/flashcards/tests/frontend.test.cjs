const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { fixture, flush, deferred, createDocument } = require('./ui-fixture.cjs');
const source = buildSync({ entryPoints: [path.join(__dirname, '../src/main.js')], bundle: true, platform: 'browser', format: 'esm', write: false }).outputFiles[0].text;
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
async function setup(configure) {
  const document = createDocument();
  const { activate } = await import(moduleUrl);
  const h = fixture(document); configure?.(h); activate(h.ctx); h.mount(); await flush(); return h;
}
function click(h, name, root = h.app) {
  const button = [...root.querySelectorAll('button')].find(button => (button.getAttribute('aria-label') || button.textContent) === name);
  assert.ok(button, `Missing button: ${name}`); assert.equal(button.disabled, false, `Disabled button: ${name}`); button.click();
}
const tree = h => h.handles.find(handle => handle.kind === 'tree' && !handle.disposed);
function allRows(rows) { return rows.flatMap(row => [row, ...allRows(row.children || [])]); }
function row(h, key) { const value = allRows(tree(h).props.rows).find(row => row.key === key); assert.ok(value, `Missing row: ${key}`); return value; }
function rowNode(h, key) { const node = [...h.app.querySelectorAll('[data-fixture-row]')].find(node => node.dataset.fixtureRow === key); assert.ok(node, `Row not mounted: ${key}`); return node; }
function openAll(h) { for (const item of allRows(tree(h).props.rows)) if (item.disclosure && !item.disclosure.expanded) item.disclosure.onChange(true); }
function select(h, key, checked = true) { row(h, key).selection.onChange(checked); }
function menu(h, key) {
  const kind = key.includes(':cue:') ? 'Cue' : key.includes(':p:') ? 'Proposition' : 'Deck';
  click(h, `${kind} actions`, rowNode(h, key)); return document.querySelector('[role=menu]');
}
function closeSurface(h) { const surface = h.handles.findLast(handle => handle.kind === 'surface' && !handle.disposed); assert.ok(surface); click(h, 'Close', surface.container); }
const surfaceRoot = h => h.handles.findLast(handle => handle.kind === 'surface' && !handle.disposed).container;
function change(input, value) { input.value = value; input.dispatchEvent(new document.defaultView.Event('input')); }
function key(target, value, options = {}) {
  const event = new document.defaultView.Event('keydown', { bubbles: true, cancelable: true });
  for (const [name, property] of Object.entries({ key: value, ...options })) Object.defineProperty(event, name, { value: property });
  target.dispatchEvent(event); return event;
}
function assertInitialRegion(stage, label) {
  assert.ok(stage); assert.equal(stage.tabIndex, -1); assert.equal(stage.getAttribute('role'), 'group');
  assert.equal(stage.getAttribute('aria-label'), label); assert.ok(stage.hasAttribute('data-plugin-initial-focus'));
  assert.equal(stage.closest('[hidden]'), null, 'initial focus marker belongs to visible content');
  assert.equal(stage.querySelector('[data-plugin-initial-focus]'), null, 'no hidden heading or child steals the initial marker');
}
function settingsRow(h, key) {
  const handle = h.handles.find(handle => handle.kind === 'rows' && !handle.disposed && handle.props.rows.some(row => row.key === key));
  assert.ok(handle, `Missing settings row: ${key}`);
  return handle.props.rows.find(row => row.key === key);
}
const picker = (h, kind) => h.handles.findLast(handle => handle.kind === kind && !handle.disposed);
const savedSettings = h => h.calls.filter(([operation]) => operation === 'save-settings');
function assertModelRows(h, hidden) {
  const overrides = h.settings.querySelector('.fc-model-overrides'); assert.ok(overrides); assert.equal(overrides.hidden, hidden);
  for (const name of ['fc-model-row', 'fc-thinking-row']) {
    const row = h.settings.querySelector(`.${name}`); assert.ok(row, `Missing ${name}`); assert.equal(row.hidden, hidden);
    assert.equal(row.parentElement, overrides, 'model and thinking controls share one overrides row');
    assert.equal(row.querySelector('label,.fc-label'), null, 'picker rows add no duplicate labels');
  }
}
function assertPreview(preview) {
  assert.equal(preview.getAttribute('aria-label'), 'Fact one');
  assert.deepEqual([...preview.querySelectorAll('h2')].map(node => node.textContent), ['Fact one']);
  assert.equal(preview.querySelector('h3,.fc-label,.fc-muted'), null, 'no Question/Answer captions or duplicate muted proposition name');
  const card = preview.querySelector('.fc-review-card.fc-preview-card'); assert.ok(card);
  assert.equal(card.children[0].className, 'fc-markdown'); assert.equal(card.children[0].textContent, 'Question **one**?');
  assert.equal(card.children[1].className, 'fc-answer'); assert.equal(card.children[1].querySelector('.fc-markdown').textContent, 'SECRET ANSWER');
  assert.equal(card.children.length, 2);
  assert.equal(card.querySelector('h2,button,[role=alert]'), null);
  assert.equal(preview.querySelector('.fc-review-surface,.fc-review-stage,[data-plugin-initial-focus]'), null, 'preview is not a review surface and owns no initial-focus marker');
  return card;
}
function sharedCards(h) {
  h.state.propositions[0].cues.push({ id: 'c2', question: 'Second cue', answer: 'Second answer' });
  h.state.propositions[0].memberships.push('d2'); h.state.decks[1].propositionIds = ['p1'];
  h.state.revision++; h.notify();
}

test('native library, host placements, explicit preflight and no navigation cancellation', async () => {
  const h = await setup();
  try {
    const placement = h.registrations.find(r => r.id === 'open-sidebar');
    assert.equal(placement.location, 'sidebar');
    assert.equal(h.registrations.some(r => r.location === 'graph' || r.id === 'open-graph'), false);
    const action = h.registrations.find(r => r.id === placement.actionId);
    const icon = document.createElement('div'); icon.innerHTML = action.icon;
    assert.ok(icon.querySelector('svg'), 'sidebar action supplies SVG card artwork');
    assert.ok(icon.querySelector('svg path, svg rect, svg polyline'), 'sidebar icon is not an empty SVG');
    for (const id of ['d1', 'd2']) {
      const artwork = rowNode(h, `deck:${id}`).querySelector('.fc-tree-icon path').getAttribute('d');
      assert.ok(artwork.startsWith('M7 4h12'), 'deck rows use the stacked-card back outline, not the old folder');
      assert.ok(artwork.includes('M5 8'), 'deck rows include a separate front card');
    }
    assert.equal(tree(h).props.label, 'Flashcards library');
    assert.equal(tree(h).props.header, 'Name');
    assert.deepEqual(tree(h).props.columns.map(column => column.header), ['Propositions', 'Due', 'New today']);
    assert.deepEqual(row(h, 'deck:d1').cells, { propositions: '1', due: '1', new: '0 / 20' });
    assert.ok(h.app.textContent.includes('Notes'));
    assert.equal(h.markdowns.length, 0, 'collapsed library mounts no card content');
    click(h, 'Pick nodes'); click(h, 'Generate'); await flush();
    assert.equal(h.calls.filter(([op]) => op === 'start-generation').length, 0);
    const confirmation = document.querySelector('[role=dialog]');
    assert.ok(confirmation.textContent.includes('1 propositions'));
    assert.ok(confirmation.textContent.includes('approximately 123 input tokens'));
    assert.equal(/chunks?|Test model|preserving|Work continues/i.test(confirmation.textContent), false);
    assert.equal(confirmation.querySelector('.fc-muted').textContent, 'Generation makes model calls and may incur costs.');
    click(h, 'Start', confirmation); await flush();
    assert.equal(h.calls.filter(([op]) => op === 'start-generation').length, 1);
    h.unmount(); h.notify(); h.resync(); await flush();
    assert.equal(h.calls.filter(([op]) => op === 'cancel-generation').length, 0);
    const reads = h.calls.filter(([op]) => op === 'get-state').length;
    h.notify(); await flush(); assert.equal(h.calls.filter(([op]) => op === 'get-state').length, reads);
  } finally { h.dispose(); }
});

test('deck panel groups search, Create deck, selection and tree separately from generation', async () => {
  const h = await setup();
  try {
    const toolbar = h.app.querySelector('.fc-toolbar'), panel = h.app.querySelector('section.fc-deck-panel');
    assert.ok(panel);
    assert.deepEqual([...toolbar.querySelectorAll('button')].map(button => button.textContent), ['Pick nodes', 'Generate']);
    assert.equal(toolbar.querySelector('input[type=search]'), null);
    const deckToolbar = panel.querySelector('.fc-deck-toolbar'); assert.ok(deckToolbar);
    assert.equal(deckToolbar.querySelector('input[type=search]'), h.app.querySelector('input[type=search]'));
    assert.deepEqual([...deckToolbar.querySelectorAll('button')].map(button => button.textContent), ['Create deck']);
    assert.ok(panel.contains(h.app.querySelector('.fc-selection-actions')));
    assert.ok(panel.contains(tree(h).container));
    assert.equal(panel.contains(toolbar), false);
  } finally { h.dispose(); }
});

test('context actions stay visible with stable handles, switch between all/selected, and group count plus Clear on the right', async () => {
  const h = await setup();
  try {
    const actions = h.app.querySelector('.fc-selection-actions');
    const controls = h.handles.filter(handle => handle.kind === 'button' && actions.contains(handle.container));
    assert.equal(controls.length, 3, 'exactly two context actions and Clear');
    const [review, practice, clear] = controls;
    const labels = () => [...actions.querySelectorAll('button')].map(button => button.textContent);
    const assertStable = () => {
      assert.equal(actions.hidden, false); assert.ok(actions.isConnected);
      assert.deepEqual(h.handles.filter(handle => handle.kind === 'button' && actions.contains(handle.container)), controls);
      assert.ok(controls.every(handle => !handle.disposed));
    };
    assertStable(); assert.deepEqual(labels(), ['Review all', 'Practice all', 'Clear']);
    assert.equal(review.props.disabled, false); assert.equal(practice.props.disabled, false); assert.equal(clear.props.disabled, true);
    const count = [...actions.querySelectorAll('span')].find(node => node.textContent === '0 selected'); assert.ok(count);
    assert.equal(count.parentElement, clear.container.parentElement, 'count and Clear share a right-hand group');
    assert.equal(count.parentElement, actions.querySelector('.fc-selection-summary'));
    const scopeActions = actions.querySelector('.fc-scope-actions');
    assert.ok(scopeActions.contains(review.container)); assert.ok(scopeActions.contains(practice.container));
    assert.equal(scopeActions.compareDocumentPosition(count.parentElement) & 4, 4);
    assert.notEqual(count.parentElement, actions); assert.equal(count.parentElement.contains(review.container), false);
    select(h, 'deck:d1');
    assertStable(); assert.deepEqual(labels(), ['Review selected', 'Practice selected', 'Clear']);
    assert.equal(count.textContent, '1 selected'); assert.equal(clear.props.disabled, false);
    assert.equal(review.props.disabled, false); assert.equal(practice.props.disabled, false);
    assert.equal([...actions.querySelectorAll('button')].some(node => /^(Review|Practice) all$/.test(node.textContent)), false);
    h.state.revision++; h.notify(); await flush(); assertStable();
    change(h.app.querySelector('input[type=search]'), 'does not match anything'); assertStable();
    assert.equal(count.textContent, '1 selected', 'search does not discard hidden selections');
    click(h, 'Clear'); await flush(); assertStable(); assert.deepEqual(labels(), ['Review all', 'Practice all', 'Clear']);
    assert.equal(count.textContent, '0 selected'); assert.equal(clear.props.disabled, true);
    change(h.app.querySelector('input[type=search]'), '');
    select(h, 'deck:d2'); assertStable(); assert.deepEqual(labels(), ['Review selected', 'Practice selected', 'Clear']);
    assert.equal(count.textContent, '1 selected'); assert.equal(review.props.disabled, true); assert.equal(practice.props.disabled, true);
    assert.equal(clear.props.disabled, false);
    const calls = h.calls.length; actions.querySelectorAll('button')[0].click(); actions.querySelectorAll('button')[1].click(); await flush();
    assert.equal(h.calls.length, calls, 'empty selected branches never widen to all');
    click(h, 'Clear'); assertStable(); assert.equal(review.props.disabled, false); assert.equal(practice.props.disabled, false);
  } finally { h.dispose(); }
});

test('empty or archived-only libraries disable Practice all but leave Review all and the visible empty selection row available', async () => {
  const h = await setup();
  try {
    h.state.propositions[0].archived = true; h.state.revision++; h.notify(); await flush();
    const actions = h.app.querySelector('.fc-selection-actions');
    const find = label => [...actions.querySelectorAll('button')].find(node => node.textContent === label);
    assert.equal(actions.hidden, false); assert.equal(find('Review all').disabled, false); assert.equal(find('Practice all').disabled, true); assert.equal(find('Clear').disabled, true);
    h.state.propositions = []; h.state.revision++; h.notify(); await flush();
    assert.equal(find('Practice all').disabled, true); assert.equal(find('Review all').disabled, false);
    h.overrides['next-review'] = async () => ({ ticket: null, remaining: 0 });
    click(h, 'Review all'); await flush();
    assert.deepEqual(h.calls.findLast(([op]) => op === 'next-review')[1], {});
    assert.ok(surfaceRoot(h).textContent.includes('No cards due in this selection.'));
    closeSurface(h); select(h, 'deck:d1');
    assert.equal(find('Review selected').disabled, true); assert.equal(find('Practice selected').disabled, true);
    click(h, 'Clear'); assert.equal(find('Practice all').disabled, true);
  } finally { h.dispose(); }
});

test('library-wide dashboard follows the deck panel and updates independently of tree search and selection', async () => {
  const h = await setup();
  try {
    const panel = h.app.querySelector('.fc-deck-panel'), dashboard = h.app.querySelector('.fc-dashboard');
    assert.ok(dashboard); assert.equal(panel.contains(dashboard), false);
    assert.equal(panel.compareDocumentPosition(dashboard) & 4, 4);
    assert.equal(dashboard.getAttribute('aria-label'), 'Spaced repetition');
    assert.equal(dashboard.querySelector('[data-state=review] strong').textContent, '1');
    assert.equal(dashboard.querySelectorAll('svg[role=img]').length, 2);
    const before = dashboard.textContent;
    change(h.app.querySelector('input[type=search]'), 'No matching cards');
    assert.equal(dashboard.textContent, before, 'tree search does not scope the dashboard');
    h.state.statistics.states.new = 3; h.state.statistics.activity.at(-1).count = 5; h.state.revision++; h.notify(); await flush();
    assert.equal(h.app.querySelector('.fc-dashboard'), dashboard);
    assert.equal(dashboard.querySelector('[data-state=new] strong').textContent, '3');
    assert.ok(dashboard.querySelectorAll('svg')[1].getAttribute('aria-label').includes('Today: 5'));
    h.unmount(); assert.equal(dashboard.isConnected, false);
  } finally { h.dispose(); }
});

test('deck practice is a once-through read-only snapshot with reveal gating and no review RPCs', async () => {
  const h = await setup();
  try {
    sharedCards(h); await flush();
    const before = JSON.stringify(h.state), calls = h.calls.length;
    menu(h, 'deck:d1'); click(h, 'Practice anytime', document.querySelector('[role=menu]')); await flush();
    const stage = surfaceRoot(h).querySelector('.fc-review-stage');
    assertInitialRegion(stage, 'Flashcard practice');
    const title = stage.querySelector('h2'), footer = stage.querySelector('.fc-review-footer'), bottom = stage.querySelector('.fc-review-bottom');
    assert.equal(title.textContent, ''); assert.equal(title.hidden, true);
    assert.equal(bottom.previousElementSibling, stage.querySelector('.fc-review-card')); assert.equal(bottom.nextElementSibling, footer);
    const note = surfaceRoot(h).querySelector('.fc-practice-note');
    assert.equal(note.textContent, 'Practice mode does not change your review schedule.');
    assert.equal(stage.contains(note), false); assert.equal(bottom.contains(note), false);
    assert.equal(note.previousElementSibling, stage);
    assert.equal(bottom.querySelector('.fc-review-remaining').textContent, '1 card remaining');
    assert.equal(footer.querySelector('.fc-practice-note, .fc-review-remaining'), null);
    const reveal = h.handles.findLast(handle => handle.kind === 'button' && !handle.disposed && handle.props.label === 'Reveal answer');
    assert.equal(reveal.props.variant, 'outline');
    assert.deepEqual([...footer.querySelectorAll('.fc-shortcut')].map(node => node.textContent), ['Space']);
    assert.equal(stage.querySelector('.fc-review-card').textContent, 'Question **one**?');
    assert.equal(stage.querySelector('.fc-answer').textContent, '');
    assert.ok(stage.textContent.includes('1 card remaining'));
    assert.equal(stage.textContent.includes('Practice mode does not change your review schedule.'), false);
    assert.equal([...stage.querySelectorAll('button')].some(b => b.textContent === 'Next'), false);
    click(h, 'Reveal answer', surfaceRoot(h)); await flush();
    assert.equal(stage.querySelector('.fc-answer').textContent, 'SECRET ANSWER');
    assert.equal(stage.querySelector('h2'), title); assert.equal(title.textContent, 'Fact one'); assert.equal(title.hidden, false);
    const next = h.handles.findLast(handle => handle.kind === 'button' && !handle.disposed && handle.props.label === 'Next');
    assert.equal(next.props.variant, 'outline');
    assert.deepEqual([...footer.querySelectorAll('.fc-shortcut')].map(node => node.textContent), ['Space']);
    assert.equal(key(stage, ' ', { code: 'Space' }).defaultPrevented, true); await flush();
    assert.equal(stage.querySelector('h2'), title); assert.equal(title.textContent, ''); assert.equal(title.hidden, true);
    assert.equal(stage.querySelector('.fc-review-card').textContent, 'Second cue');
    assert.ok(stage.textContent.includes('0 cards remaining'));
    click(h, 'Reveal answer', surfaceRoot(h)); click(h, 'Next', surfaceRoot(h)); await flush();
    assert.ok(stage.textContent.includes('Practice complete.'));
    assert.equal(title.textContent, ''); assert.equal(title.hidden, true);
    assert.equal(surfaceRoot(h).querySelector('.fc-practice-note'), note);
    assert.equal(note.textContent, 'Practice mode does not change your review schedule.');
    assert.equal(stage.contains(note), false);
    assert.equal(footer.querySelector('.fc-practice-note'), null);
    assert.equal(h.calls.length, calls, 'practice makes no backend calls, even for reveal/completion');
    assert.equal(JSON.stringify(h.state), before, 'no schedules, history or daily counts change');
  } finally { h.dispose(); }
});

test('Practice selected uses exactly selected cues; Practice all deduplicates shared cues and ignores archived/deleted ones', async () => {
  const h = await setup();
  try {
    sharedCards(h);
    h.state.propositions[0].cues.push({ id: 'deleted', question: 'Deleted cue', answer: 'Deleted answer', deleted: true });
    h.state.propositions.push({ id: 'archived', name: 'Old', archived: true, cues: [{ id: 'old', question: 'Archived cue', answer: 'Old answer' }] });
    h.state.decks[0].propositionIds.push('archived'); h.state.revision++; h.notify(); await flush(); openAll(h);
    select(h, 'deck:d1:p:p1:cue:c2'); const calls = h.calls.length;
    click(h, 'Practice selected'); await flush();
    assert.equal(surfaceRoot(h).querySelector('.fc-review-card').textContent, 'Second cue');
    assert.ok(surfaceRoot(h).textContent.includes('0 cards remaining'));
    closeSurface(h);
    assert.equal([...h.app.querySelectorAll('button')].some(button => button.textContent === 'Practice all'), false);
    click(h, 'Clear'); click(h, 'Practice all'); await flush();
    assert.equal(surfaceRoot(h).querySelector('.fc-review-card').textContent, 'Question **one**?');
    assert.ok(surfaceRoot(h).textContent.includes('1 card remaining'), 'shared cues appear only once');
    assert.equal(h.calls.length, calls);
    closeSurface(h);
    menu(h, 'deck:d2'); click(h, 'Practice anytime', document.querySelector('[role=menu]')); await flush();
    assert.ok(surfaceRoot(h).textContent.includes('1 card remaining'), 'deck gear uses its own membership scope');
  } finally { h.dispose(); }
});

test('practice keeps its opening snapshot across library updates; empty practice scopes remain disabled', async () => {
  const h = await setup();
  try {
    select(h, 'deck:d2');
    const selected = [...h.app.querySelectorAll('button')].find(b => b.textContent === 'Practice selected'); assert.ok(selected.disabled);
    menu(h, 'deck:d2'); const empty = [...document.querySelectorAll('[role=menu] button')].find(b => b.textContent === 'Practice anytime'); assert.ok(empty.disabled);
    document.querySelector('[role=menu]').remove();
    click(h, 'Clear'); select(h, 'deck:d1'); click(h, 'Practice selected'); await flush();
    h.state.propositions[0].cues[0].answer = 'CHANGED AFTER OPEN'; h.state.revision++; h.notify(); await flush();
    click(h, 'Reveal answer', surfaceRoot(h)); await flush();
    assert.equal(surfaceRoot(h).querySelector('.fc-answer').textContent, 'SECRET ANSWER');
    closeSurface(h); click(h, 'Practice selected'); click(h, 'Reveal answer', surfaceRoot(h)); await flush();
    assert.equal(surfaceRoot(h).querySelector('.fc-answer').textContent, 'CHANGED AFTER OPEN');
  } finally { h.dispose(); }
});

test('successful generation clears its banner while active progress, cancellation and failures remain', async () => {
  const h = await setup();
  try {
    const batch = { id: 'b1', status: 'completed', chunks: [{ id: 'chunk1', status: 'applied', targetIds: ['p1'] }], completed: 1, total: 1, added: 2, failedTargetIds: [] };
    const publishBatch = async value => { h.state.batch = value; h.state.revision++; h.notify(); await flush(); };
    await publishBatch(batch);
    assert.equal(h.app.querySelector('.fc-batch'), null, 'successful completed batch has no banner');
    for (const status of ['running', 'pending', 'queued', 'cancelling']) {
      await publishBatch({ ...batch, status, completed: 0, chunks: [{ ...batch.chunks[0], status: 'running' }] });
      const panel = h.app.querySelector('.fc-batch'); assert.ok(panel);
      assert.ok(panel.textContent.includes(status)); assert.ok(panel.textContent.includes('0/1'));
      assert.ok([...panel.querySelectorAll('button')].some(button => button.textContent === 'Cancel generation'));
    }
    await publishBatch({ ...batch, status: 'partial', failedTargetIds: ['p1'], chunks: [{ ...batch.chunks[0], status: 'failed', error: 'Worker failed' }] });
    let panel = h.app.querySelector('.fc-batch'); assert.ok(panel.textContent.includes('Worker failed'));
    assert.ok([...panel.querySelectorAll('button')].some(button => button.textContent === 'Retry failed…'));
    await publishBatch({ ...batch, error: 'Disk write failed' });
    panel = h.app.querySelector('.fc-batch'); assert.ok(panel.textContent.includes('Disk write failed'));
    assert.ok([...panel.querySelectorAll('button')].some(button => button.textContent === 'Retry saving'));
    await publishBatch({ ...batch, chunks: [{ ...batch.chunks[0], error: 'Unresolved chunk error' }] });
    assert.ok(h.app.querySelector('.fc-batch').textContent.includes('Unresolved chunk error'));
    await publishBatch(batch); assert.equal(h.app.querySelector('.fc-batch'), null);
  } finally { h.dispose(); }
});

test('selection cascades to leaves, synchronizes shared cues and produces exact review scope', async () => {
  const h = await setup();
  try {
    sharedCards(h); await flush(); openAll(h);
    const actions = h.app.querySelector('.fc-selection-actions'); assert.equal(actions.hidden, false);
    assert.equal(actions.compareDocumentPosition(tree(h).container) & 4, 4, 'selection actions precede the tree');
    select(h, 'deck:d1:p:p1:cue:c1');
    assert.equal(actions.hidden, false);
    for (const deck of ['d1', 'd2']) {
      assert.equal(row(h, `deck:${deck}:p:p1:cue:c1`).selection.checked, true);
      assert.equal(row(h, `deck:${deck}:p:p1:cue:c2`).selection.checked, false);
      assert.equal(row(h, `deck:${deck}:p:p1`).selection.indeterminate, true);
      assert.equal(row(h, `deck:${deck}`).selection.indeterminate, true);
      assert.equal(rowNode(h, `deck:${deck}:p:p1:cue:c1`).querySelector('input[type=checkbox]').checked, true);
    }
    click(h, 'Review selected'); await flush();
    assert.deepEqual(h.calls.findLast(([op]) => op === 'next-review')[1], { propositionIds: ['p1'], cueIds: ['c1'] });
    closeSurface(h);
    select(h, 'deck:d2:p:p1');
    assert.equal(row(h, 'deck:d1').selection.checked, true);
    assert.equal(row(h, 'deck:d1').selection.indeterminate, false);
    select(h, 'deck:d1', false);
    assert.equal(row(h, 'deck:d2:p:p1:cue:c2').selection.checked, false);
    assert.equal(actions.hidden, false);
    select(h, 'deck:d1'); click(h, 'Clear'); await flush(); assert.equal(actions.hidden, false);
    assert.equal(row(h, 'deck:d2').selection.checked, false);
    select(h, 'deck:d1'); click(h, 'Clear'); click(h, 'Review all'); await flush();
    assert.deepEqual(h.calls.findLast(([op]) => op === 'next-review')[1], {});
  } finally { h.dispose(); }
});

test('empty branches can be selected but cannot start a selected-cue review', async () => {
  const h = await setup();
  try {
    select(h, 'deck:d2');
    assert.equal(h.app.querySelector('.fc-selection-actions').hidden, false);
    const review = [...h.app.querySelectorAll('button')].find(button => button.textContent === 'Review selected');
    assert.ok(review.disabled); assert.equal(h.calls.some(([op]) => op === 'next-review'), false);
    click(h, 'Clear'); assert.equal(h.app.querySelector('.fc-selection-actions').hidden, false);
  } finally { h.dispose(); }
});

test('scheduled review marks visible content before its RPC and keeps its heading empty until answer reveal', async () => {
  const h = await setup();
  try {
    const next = deferred(); let called = false;
    h.overrides['next-review'] = () => {
      called = true;
      const stage = surfaceRoot(h).querySelector('.fc-review-stage');
      assertInitialRegion(stage, 'Flashcard review');
      assert.equal(stage.querySelector('h2').textContent, ''); assert.equal(stage.querySelector('h2').hidden, true);
      return next.promise;
    };
    click(h, 'Review', rowNode(h, 'deck:d1')); assert.equal(called, true);
    const stage = surfaceRoot(h).querySelector('.fc-review-stage'), title = stage.querySelector('h2');
    assert.ok(stage.textContent.includes('Loading next card…'));
    next.resolve({ ticket: { id: 't1', question: 'Question **one**?', propositionName: 'Fact one' }, remaining: 1 }); await flush();
    assert.equal(stage.querySelector('h2'), title); assert.equal(title.textContent, ''); assert.equal(title.hidden, true);
    const reveal = deferred(); h.overrides['reveal-review'] = () => reveal.promise;
    click(h, 'Reveal answer', surfaceRoot(h)); await flush();
    assert.equal(title.textContent, ''); assert.equal(title.hidden, true, 'pending reveal does not expose the proposition');
    reveal.resolve({ answer: 'SECRET ANSWER', intervals: { 1: 60000, 2: 300000, 3: 600000, 4: 86400000 } }); await flush();
    assert.equal(stage.querySelector('h2'), title); assert.equal(title.textContent, 'Fact one'); assert.equal(title.hidden, false);
  } finally { h.dispose(); }
});

test('outlined deck Review keeps QA separate from controls and bottom counts; ratings use four custom color palettes', async () => {
  const h = await setup();
  try {
    const inline = h.handles.find(handle => handle.kind === 'button' && handle.props.label === 'Review');
    click(h, 'Review', rowNode(h, 'deck:d1')); await flush();
    assert.deepEqual(h.calls.find(([op]) => op === 'next-review')[1], { deckIds: ['d1'] });
    assert.equal(h.handles.filter(handle => handle.kind === 'surface').length, 1);
    const stage = surfaceRoot(h).querySelector('.fc-review-stage'), title = stage.querySelector('h2'), card = stage.querySelector('.fc-review-card');
    assertInitialRegion(stage, 'Flashcard review');
    assert.equal(title.textContent, ''); assert.equal(title.hidden, true);
    const footer = stage.querySelector('.fc-review-footer'), bottom = stage.querySelector('.fc-review-bottom');
    assert.equal(bottom.previousElementSibling, card); assert.equal(bottom.nextElementSibling, footer);
    assert.equal(footer.contains(bottom), false);
    assert.equal(bottom.querySelector('.fc-review-remaining').textContent, '1 ready');
    assert.equal(footer.querySelector('.fc-review-remaining'), null);
    const reveal = h.handles.findLast(handle => handle.kind === 'button' && !handle.disposed && handle.props.label === 'Reveal answer');
    assert.equal(reveal.props.variant, 'outline');
    assert.deepEqual([...footer.querySelectorAll('.fc-shortcut')].map(node => node.textContent), ['Space']);
    assert.equal(card.contains(title), false); assert.equal(card.querySelector('button, [role=alert], h2'), null);
    assert.equal(card.textContent, 'Question **one**?');
    assert.ok(stage.textContent.includes('1 ready')); assert.equal(card.textContent.includes('ready'), false);
    assert.ok(stage.textContent.includes('Space')); assert.equal(card.textContent.includes('Space'), false);
    assert.equal(h.markdowns.some(item => item.text === 'SECRET ANSWER'), false);
    assert.equal([...surfaceRoot(h).querySelectorAll('button')].some(button => button.textContent === 'End review'), false);
    click(h, 'Reveal answer', surfaceRoot(h)); await flush();
    assert.equal(stage.querySelector('h2'), title); assert.equal(title.textContent, 'Fact one'); assert.equal(title.hidden, false);
    assert.equal(h.markdowns.filter(item => item.text === 'SECRET ANSWER').length, 1);
    assert.ok(card.textContent.includes('SECRET ANSWER')); assert.equal(card.querySelector('button'), null);
    const ratings = h.handles.filter(handle => handle.kind === 'button' && /^(Again|Hard|Good|Easy) · /.test(handle.props.label));
    assert.deepEqual(ratings.map(handle => handle.props.label), ['Again · 1m', 'Hard · 5m', 'Good · 10m', 'Easy · 1d']);
    for (const [index, label] of ['Again', 'Hard', 'Good', 'Easy'].entries()) {
      const color = `var(--fc-rating-${label.toLowerCase()})`, tint = percent => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
      assert.equal(ratings[index].props.variant, 'custom');
      assert.deepEqual(ratings[index].props.colors, {
        background: tint(12), text: color, border: tint(55),
        hover: { background: tint(20), border: tint(75) },
        active: { background: tint(28), border: color },
        focusVisible: { border: color, ring: tint(50) },
      });
    }
    assert.equal(new Set(ratings.map(handle => handle.props.colors.text)).size, 4);
    assert.deepEqual([...footer.querySelectorAll('.fc-shortcut')].map(node => node.textContent), ['1', '2', '3', '4']);
    assert.equal(stage.textContent.includes('Space rates Good'), false);
    h.overrides['rate-review'] = async () => { throw new Error('Save unavailable'); };
    click(h, 'Good · 10m', surfaceRoot(h)); await flush();
    assert.ok(stage.textContent.includes('Save unavailable')); assert.equal(card.textContent.includes('Save unavailable'), false);
    assert.equal(card.querySelector('button, [role=alert]'), null);
    h.overrides['rate-review'] = async () => ({ ok: true });
    click(h, 'Good · 10m', surfaceRoot(h)); await flush();
    const rates = h.calls.filter(([op]) => op === 'rate-review');
    assert.equal(rates.length, 2); assert.equal(rates[0][1].requestId, rates[1][1].requestId);
    assert.equal(stage.querySelector('h2'), title); assert.equal(title.textContent, ''); assert.equal(title.hidden, true);
    assert.equal(surfaceRoot(h).textContent.includes('SECRET ANSWER'), false);
    assert.equal(inline.props.variant, 'outline');
  } finally { h.dispose(); }
});

test('scheduled Space reveals but never rates, suppressing native rating-button Space while numeric grading remains', async () => {
  const h = await setup();
  try {
    click(h, 'Review', rowNode(h, 'deck:d1')); await flush();
    const stage = surfaceRoot(h).querySelector('.fc-review-stage');
    assert.equal(key(stage, ' ', { code: 'Space' }).defaultPrevented, true); await flush();
    assert.equal(h.calls.filter(([op]) => op === 'reveal-review').length, 1);
    assert.ok(stage.querySelector('.fc-answer').textContent.includes('SECRET ANSWER'));
    const good = [...stage.querySelectorAll('button')].find(button => button.textContent === 'Good · 10m');
    for (const target of [stage, good]) for (const repeat of [false, true]) {
      const event = key(target, ' ', { code: 'Space', repeat });
      assert.equal(event.defaultPrevented, true, 'scheduled revealed Space cannot activate a native rating button');
    }
    await flush(); assert.equal(h.calls.some(([op]) => op === 'rate-review'), false);
    assert.equal(key(stage, '3').defaultPrevented, true); await flush();
    assert.equal(h.calls.filter(([op]) => op === 'rate-review').length, 1);
    assert.equal(h.calls.find(([op]) => op === 'rate-review')[1].rating, 3);
    assert.equal(stage.querySelector('h2').textContent, ''); assert.equal(stage.querySelector('h2').hidden, true);
  } finally { h.dispose(); }
});

test('host surface close blocks late reveal and next-card responses', async () => {
  const h = await setup();
  try {
    click(h, 'Review', rowNode(h, 'deck:d1')); await flush();
    const wait = deferred(); h.overrides['reveal-review'] = () => wait.promise;
    click(h, 'Reveal answer', surfaceRoot(h)); closeSurface(h);
    wait.resolve({ answer: 'LATE SECRET', intervals: {} }); await flush();
    assert.equal(h.markdowns.some(item => item.text === 'LATE SECRET'), false);
    const next = deferred(); h.overrides['next-review'] = () => next.promise;
    click(h, 'Review', rowNode(h, 'deck:d1')); closeSurface(h);
    next.resolve({ ticket: { id: 'late', question: 'LATE QUESTION' } }); await flush();
    assert.equal(document.body.textContent.includes('LATE QUESTION'), false);
  } finally { h.dispose(); }
});

test('cue menu editor retains failed drafts and sends version; preview and Archive stay distinct', async () => {
  const h = await setup();
  try {
    openAll(h); click(h, 'Edit', menu(h, 'deck:d1:p:p1:cue:c1'));
    const dialog = document.querySelector('[role=dialog]');
    const question = dialog.querySelector('textarea'); question.value = 'Edited draft';
    h.overrides['save-cue'] = async () => { throw new Error('Version conflict'); };
    click(h, 'Save', dialog); await flush();
    assert.equal(question.value, 'Edited draft'); assert.ok(dialog.textContent.includes('Version conflict'));
    assert.equal(h.calls.find(([op]) => op === 'save-cue')[1].version, 1);
    click(h, 'Cancel', dialog);
    click(h, 'Question **one**?', rowNode(h, 'deck:d1:p:p1:cue:c1'));
    let preview = document.querySelector('[role=dialog]');
    const card = assertPreview(preview);
    assert.ok([...preview.querySelectorAll('button')].some(button => button.textContent === 'Edit'));
    const deletion = h.handles.findLast(handle => handle.kind === 'button' && !handle.disposed && preview.contains(handle.container) && handle.props.label === 'Delete');
    assert.equal(deletion.props.variant, 'destructive');
    const calls = h.calls.length;
    assert.equal(key(card, ' ', { code: 'Space' }).defaultPrevented, false); key(card, '3'); await flush();
    assert.equal(h.calls.length, calls, 'preview installs no review keyboard behavior');
    click(h, 'Edit', preview);
    assert.equal(preview.isConnected, false);
    const editor = document.querySelector('[role=dialog]'); assert.equal(editor.getAttribute('aria-label'), 'Edit cue');
    assert.equal(editor.querySelector('textarea').value, 'Question **one**?');
    click(h, 'Cancel', editor);
    click(h, 'Question **one**?', rowNode(h, 'deck:d1:p:p1:cue:c1'));
    preview = document.querySelector('[role=dialog]'); assertPreview(preview); click(h, 'Close', preview);
    h.state.propositions[0].archived = true; h.state.revision++; h.notify(); await flush(); openAll(h);
    assert.ok(h.app.textContent.includes('Archive'));
    assert.equal(row(h, 'archive:p:p1:cue:c1').selection, undefined);
    assert.equal(rowNode(h, 'archive:p:p1:cue:c1').querySelector('button[title="Cue actions"]'), null);
    click(h, 'Question **one**?', rowNode(h, 'archive:p:p1:cue:c1'));
    preview = document.querySelector('[role=dialog]'); assertPreview(preview);
    assert.equal([...preview.querySelectorAll('button')].some(button => ['Edit', 'Delete'].includes(button.textContent)), false);
  } finally { h.dispose(); }
});

test('preview Delete is destructive but only the explicit confirmation deletes a cue', async () => {
  const h = await setup();
  try {
    openAll(h);
    const openPreview = () => { click(h, 'Question **one**?', rowNode(h, 'deck:d1:p:p1:cue:c1')); return document.querySelector('[role=dialog]'); };
    const before = JSON.stringify(h.state), mutations = () => h.calls.filter(([op]) => op === 'delete-cue');
    let preview = openPreview(); assertPreview(preview);
    const deletion = h.handles.findLast(handle => handle.kind === 'button' && !handle.disposed && preview.contains(handle.container) && handle.props.label === 'Delete');
    assert.equal(deletion.props.variant, 'destructive');
    click(h, 'Delete', preview);
    assert.equal(preview.isConnected, false);
    let confirmation = document.querySelector('[role=dialog]'); assert.equal(confirmation.getAttribute('aria-label'), 'Delete cue?');
    assert.ok(confirmation.textContent.includes('other cues and history are retained'));
    assert.equal(mutations().length, 0); assert.equal(JSON.stringify(h.state), before);
    click(h, 'Cancel', confirmation); assert.equal(mutations().length, 0); assert.equal(JSON.stringify(h.state), before);
    preview = openPreview(); click(h, 'Delete', preview);
    confirmation = document.querySelector('[role=dialog]'); assert.equal(mutations().length, 0);
    const confirmButton = h.handles.findLast(handle => handle.kind === 'button' && !handle.disposed && confirmation.contains(handle.container) && handle.props.label === 'Delete cue');
    assert.equal(confirmButton.props.variant, 'destructive');
    click(h, 'Delete cue', confirmation); await flush();
    assert.deepEqual(mutations().map(([, input]) => input), [{ propositionId: 'p1', cueId: 'c1', version: 1 }]);
    assert.equal(h.state.propositions[0].cues[0].deleted, true);
    assert.equal(confirmation.isConnected, false);
    assert.equal(h.calls.some(([op]) => ['rate-review', 'reveal-review'].includes(op)), false);
  } finally { h.dispose(); }
});

test('inline rename commits PATCH on Enter/blur, cancels on Escape and retains failed drafts across updates', async () => {
  const h = await setup();
  try {
    const deck = rowNode(h, 'deck:d1'); click(h, 'Notes', deck);
    let input = deck.querySelector('input[aria-label="Deck name"]'); change(input, 'Renamed'); key(input, 'Enter'); await flush();
    assert.deepEqual(h.calls.findLast(([op]) => op === 'save-deck')[1], { id: 'd1', name: 'Renamed' });
    click(h, 'Renamed', deck); input = deck.querySelector('input[aria-label="Deck name"]'); change(input, 'Cancel me'); key(input, 'Escape');
    assert.equal(deck.querySelector('input[aria-label="Deck name"]'), null);
    assert.equal(h.calls.filter(([op]) => op === 'save-deck').length, 1);
    click(h, 'Renamed', deck); input = deck.querySelector('input[aria-label="Deck name"]'); change(input, 'Blur saved'); input.dispatchEvent(new document.defaultView.Event('blur')); await flush();
    assert.deepEqual(h.calls.findLast(([op]) => op === 'save-deck')[1], { id: 'd1', name: 'Blur saved' });
    h.overrides['save-deck'] = async () => { throw new Error('Rename failed'); };
    click(h, 'Blur saved', deck); input = deck.querySelector('input[aria-label="Deck name"]'); change(input, 'Keep draft'); key(input, 'Enter'); await flush();
    assert.equal(input.value, 'Keep draft'); assert.ok(deck.textContent.includes('Rename failed'));
    const content = row(h, 'deck:d1').content; h.state.revision++; h.notify(); await flush();
    assert.equal(row(h, 'deck:d1').content, content, 'row content factory identity stays stable');
    assert.equal(deck.querySelector('input[aria-label="Deck name"]'), input, 'controlled updates preserve mounted drafts');
    assert.equal(input.value, 'Keep draft'); assert.ok(deck.textContent.includes('Rename failed'));
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

test('Follow cheap slot has its own toggle row; OFF pins current slot atomically and ON clears both overrides', async () => {
  const h = await setup();
  try {
    h.mountSettings(); await flush();
    const general = h.handles.find(handle => handle.kind === 'rows');
    assert.ok(general.props.rows.some(row => row.key === 'retention'));
    assert.equal(general.props.rows.some(row => row.key === 'followCheapSlot'), false);
    const toggle = () => settingsRow(h, 'followCheapSlot');
    assert.equal(toggle().type, 'toggle'); assert.equal(toggle().value, true); assertModelRows(h, true);
    assert.equal([...h.settings.querySelectorAll('button')].some(node => node.textContent === 'Follow cheap slot'), false);
    assert.equal(savedSettings(h).length, 0, 'opening settings never pins the slot');
    await toggle().onChange(false);
    assert.deepEqual(savedSettings(h).at(-1)[1], { modelOverride: { provider: 'test', id: 'cheap' }, thinkingOverride: 'low' });
    assert.equal(toggle().value, false); assertModelRows(h, false);
    assert.deepEqual(picker(h, 'model').props.value, { provider: 'test', id: 'cheap' });
    assert.deepEqual(picker(h, 'thinking').props.model, { provider: 'test', id: 'cheap' });
    assert.equal(picker(h, 'thinking').props.value, 'low'); assert.equal(picker(h, 'thinking').props.disabled, false);
    assert.equal(h.settings.querySelector('.fc-model-settings button'), null, 'no reset/default-thinking buttons remain');
    await picker(h, 'thinking').props.onChange('high');
    assert.equal(h.state.settings.thinkingOverride, 'high');
    await toggle().onChange(true);
    assert.deepEqual(savedSettings(h).at(-1)[1], { modelOverride: null, thinkingOverride: null });
    assert.equal(toggle().value, true); assertModelRows(h, true);
    assert.equal(h.state.settings.modelOverride, null); assert.equal(h.state.settings.thinkingOverride ?? null, null);
    assert.equal(Object.hasOwn(h.state.settings, 'followCheapSlot'), false, 'UI mode is not a new backend setting');
  } finally { h.dispose(); }
});

test('Model settings delegate the full label/toggle row to native rows and keep only a sibling picker row', async () => {
  const h = await setup();
  try {
    h.mountSettings(); await flush();
    const area = h.settings.querySelector('.fc-model-settings'), follow = area.querySelector('.fc-follow-cheap-row');
    assert.ok(follow); assert.equal(follow.parentElement, area, 'the native settings row slot is a direct full-width child');
    assert.equal(area.querySelector('.fc-model-setting,.fc-label'), null, 'no plugin-owned Model label or label wrapper remains');
    assert.equal([...area.children].some(node => node.tagName === 'SPAN'), false);
    const toggle = h.handles.find(handle => handle.kind === 'rows' && !handle.disposed && handle.props.rows.some(row => row.key === 'followCheapSlot'));
    assert.equal(toggle.container, follow);
    assert.deepEqual(toggle.props.rows.map(({ key, label, description, type }) => ({ key, label, description, type })), [{ key: 'followCheapSlot', label: 'Model', description: 'Follow cheap slot', type: 'toggle' }]);
    assert.equal(Object.hasOwn(settingsRow(h, 'followCheapSlot'), 'controlLabel'), false, 'uses the existing native description field, not a caption API');
    assert.equal(follow.getAttribute('style'), null, 'the native row slot adds no inline font or alignment overrides');
    assert.ok(follow.textContent.includes('Model')); assert.ok(follow.textContent.includes('Follow cheap slot'));
    assert.equal(area.querySelector('p'), null, 'the plugin-owned explanatory paragraph is removed');
    assert.equal(area.querySelector('button'), null, 'there are no standalone follow/reset/default-thinking buttons');
    assertModelRows(h, true);
    await settingsRow(h, 'followCheapSlot').onChange(false);
    assert.equal(settingsRow(h, 'followCheapSlot').label, 'Model');
    assert.equal(settingsRow(h, 'followCheapSlot').description, 'Follow cheap slot');
    const overrides = area.querySelector('.fc-model-overrides');
    assert.equal(overrides.parentElement, area); assert.equal(overrides.previousElementSibling, follow);
    assertModelRows(h, false); assert.equal(overrides.children.length, 2);
    assert.ok(overrides.children[0].classList.contains('fc-model-row')); assert.ok(overrides.children[1].classList.contains('fc-thinking-row'));
    assert.ok(overrides.children[0].contains(picker(h, 'model').container));
    assert.ok(overrides.children[1].contains(picker(h, 'thinking').container));
    assert.equal(overrides.querySelector('label,.fc-label,p,button'), null, 'only native picker mounts remain, with no duplicate labels or controls');
    assert.equal(area.querySelector('button'), null);
    await settingsRow(h, 'followCheapSlot').onChange(true); assertModelRows(h, true);
    assert.equal(settingsRow(h, 'followCheapSlot').description, 'Follow cheap slot');
  } finally { h.dispose(); }
});

test('turning Follow cheap slot OFF without a slot thinking level pins null rather than inventing a level', async () => {
  const h = await setup(h => { delete h.catalog.slots.cheap.thinkingLevel; });
  try {
    h.mountSettings(); await flush();
    await settingsRow(h, 'followCheapSlot').onChange(false);
    assert.deepEqual(savedSettings(h).at(-1)[1], { modelOverride: { provider: 'test', id: 'cheap' }, thinkingOverride: null });
    assert.equal(settingsRow(h, 'followCheapSlot').value, false); assertModelRows(h, false);
  } finally { h.dispose(); }
});

test('thinking-only overrides stay OFF and resolve the current cheap model without autosaving or migrating settings', async () => {
  const pending = deferred();
  const h = await setup(h => { h.state.settings.thinkingOverride = 'high'; h.overrides['get-catalog'] = () => pending.promise; });
  try {
    h.mountSettings(); await flush();
    assert.equal(settingsRow(h, 'followCheapSlot').value, false); assertModelRows(h, false);
    assert.equal(picker(h, 'thinking').props.disabled, true, 'catalog has not supplied an effective model yet');
    const before = JSON.stringify(h.state.settings);
    const effective = { provider: 'test', id: 'updated-cheap' };
    pending.resolve({ slots: { cheap: { model: effective, thinkingLevel: 'low' } } }); await flush();
    assert.equal(settingsRow(h, 'followCheapSlot').value, false);
    assert.deepEqual(picker(h, 'model').props.value, effective);
    assert.deepEqual(picker(h, 'thinking').props.model, effective);
    assert.equal(picker(h, 'thinking').props.value, 'high'); assert.equal(picker(h, 'thinking').props.disabled, false);
    assert.equal(savedSettings(h).length, 0); assert.equal(JSON.stringify(h.state.settings), before);
  } finally { h.dispose(); }
});

test('delayed catalog updates the effective slot while following and OFF explicitly pins the newly received model only on request', async () => {
  const pending = deferred();
  const h = await setup(h => { h.overrides['get-catalog'] = () => pending.promise; });
  try {
    h.mountSettings(); await flush();
    assert.equal(settingsRow(h, 'followCheapSlot').value, true); assertModelRows(h, true);
    const effective = { provider: 'test', id: 'new-cheap' };
    pending.resolve({ slots: { cheap: { model: effective, thinkingLevel: 'medium' } } }); await flush();
    assert.equal(savedSettings(h).length, 0); assert.equal(settingsRow(h, 'followCheapSlot').value, true); assertModelRows(h, true);
    await settingsRow(h, 'followCheapSlot').onChange(false);
    assert.deepEqual(savedSettings(h).at(-1)[1], { modelOverride: effective, thinkingOverride: 'medium' });
  } finally { h.dispose(); }
});

test('OFF without a cheap model is a local draft; selecting a model persists it and reopening restores acknowledged overrides', async () => {
  const h = await setup(h => { h.catalog.slots = {}; });
  try {
    h.mountSettings(); await flush();
    await settingsRow(h, 'followCheapSlot').onChange(false);
    assert.equal(settingsRow(h, 'followCheapSlot').value, false); assertModelRows(h, false);
    assert.equal(picker(h, 'model').props.value, undefined); assert.equal(picker(h, 'thinking').props.disabled, true);
    assert.equal(savedSettings(h).length, 0); assert.equal(h.state.settings.modelOverride, null);
    h.state.revision++; h.notify(); await flush();
    assert.equal(settingsRow(h, 'followCheapSlot').value, false, 'unrelated acknowledgements do not erase an unsaved OFF draft');
    const model = { provider: 'test', id: 'chosen' };
    await picker(h, 'model').props.onChange(model);
    assert.deepEqual(savedSettings(h).at(-1)[1], { modelOverride: model, thinkingOverride: null });
    assert.equal(settingsRow(h, 'followCheapSlot').value, false); assert.equal(picker(h, 'thinking').props.disabled, false);
    await picker(h, 'thinking').props.onChange('high');
    const saves = savedSettings(h).length;
    h.unmountSettings(); h.mountSettings(); await flush();
    assert.equal(savedSettings(h).length, saves, 'reopening does not rewrite persisted overrides');
    assert.equal(settingsRow(h, 'followCheapSlot').value, false); assertModelRows(h, false);
    assert.deepEqual(picker(h, 'model').props.value, model); assert.equal(picker(h, 'thinking').props.value, 'high');
  } finally { h.dispose(); }
});

test('OFF draft survives a late catalog without auto-saving, including after a failed attempt to turn following back ON', async () => {
  const pending = deferred();
  const h = await setup(h => { h.overrides['get-catalog'] = () => pending.promise; });
  try {
    h.mountSettings(); await flush();
    await settingsRow(h, 'followCheapSlot').onChange(false);
    assert.equal(settingsRow(h, 'followCheapSlot').value, false); assert.equal(savedSettings(h).length, 0);
    h.overrides['save-settings'] = async () => { throw new Error('Cannot clear overrides'); };
    await Promise.resolve(settingsRow(h, 'followCheapSlot').onChange(true)).catch(() => {});
    assert.ok(h.settings.textContent.includes('Cannot clear overrides'));
    assert.equal(settingsRow(h, 'followCheapSlot').value, false); assertModelRows(h, false);
    const model = { provider: 'test', id: 'late-cheap' };
    pending.resolve({ slots: { cheap: { model, thinkingLevel: 'low' } } }); await flush();
    assert.equal(savedSettings(h).length, 1, 'catalog arrival must not trigger a second save');
    assert.equal(settingsRow(h, 'followCheapSlot').value, false); assertModelRows(h, false);
    assert.deepEqual(picker(h, 'model').props.value, model); assert.equal(picker(h, 'thinking').props.disabled, false);
    assert.equal(h.state.settings.modelOverride, null);
    delete h.overrides['save-settings'];
    await settingsRow(h, 'followCheapSlot').onChange(true);
    assert.equal(settingsRow(h, 'followCheapSlot').value, true); assertModelRows(h, true);
  } finally { h.dispose(); }
});

test('pending model saves disable toggle and pickers; failures restore acknowledged modes and values with visible errors', async () => {
  const h = await setup();
  try {
    h.mountSettings(); await flush();
    const failed = deferred(); h.overrides['save-settings'] = () => failed.promise;
    const turningOff = Promise.resolve(settingsRow(h, 'followCheapSlot').onChange(false)).catch(() => {});
    assert.equal(settingsRow(h, 'followCheapSlot').disabled, true);
    assert.equal(picker(h, 'model').props.disabled, true); assert.equal(picker(h, 'thinking').props.disabled, true);
    failed.reject(new Error('Pin unavailable')); await turningOff; await flush();
    assert.ok(h.settings.textContent.includes('Pin unavailable'));
    assert.equal(settingsRow(h, 'followCheapSlot').value, true); assert.equal(settingsRow(h, 'followCheapSlot').disabled, false); assertModelRows(h, true);
    assert.equal(h.state.settings.modelOverride, null);
    delete h.overrides['save-settings']; await settingsRow(h, 'followCheapSlot').onChange(false);
    const acknowledged = JSON.stringify(h.state.settings);
    h.overrides['save-settings'] = async () => { throw new Error('Clear unavailable'); };
    await Promise.resolve(settingsRow(h, 'followCheapSlot').onChange(true)).catch(() => {});
    assert.ok(h.settings.textContent.includes('Clear unavailable'));
    assert.equal(settingsRow(h, 'followCheapSlot').value, false); assertModelRows(h, false);
    assert.deepEqual(picker(h, 'model').props.value, { provider: 'test', id: 'cheap' });
    assert.equal(picker(h, 'thinking').props.value, 'low');
    assert.equal(JSON.stringify(h.state.settings), acknowledged);
  } finally { h.dispose(); }
});

test('failed model and thinking edits retain the acknowledged override values and OFF mode', async () => {
  const original = { provider: 'test', id: 'original' };
  const h = await setup(h => { h.state.settings.modelOverride = original; h.state.settings.thinkingOverride = 'high'; });
  try {
    h.mountSettings(); await flush();
    const before = JSON.stringify(h.state.settings), pending = deferred();
    h.overrides['save-settings'] = () => pending.promise;
    const changing = Promise.resolve(picker(h, 'model').props.onChange({ provider: 'test', id: 'replacement' })).catch(() => {});
    assert.equal(settingsRow(h, 'followCheapSlot').disabled, true);
    assert.equal(picker(h, 'model').props.disabled, true); assert.equal(picker(h, 'thinking').props.disabled, true);
    assert.equal(h.settings.querySelector('.fc-model-settings button'), null, 'busy state does not recreate a reset control');
    pending.reject(new Error('Model update failed')); await changing; await flush();
    assert.ok(h.settings.textContent.includes('Model update failed'));
    assert.deepEqual(picker(h, 'model').props.value, original); assert.equal(picker(h, 'thinking').props.value, 'high');
    assert.equal(settingsRow(h, 'followCheapSlot').value, false); assertModelRows(h, false);
    assert.equal(JSON.stringify(h.state.settings), before);
    h.overrides['save-settings'] = async () => { throw new Error('Thinking update failed'); };
    await Promise.resolve(picker(h, 'thinking').props.onChange('low')).catch(() => {});
    assert.ok(h.settings.textContent.includes('Thinking update failed'));
    assert.equal(picker(h, 'thinking').props.value, 'high'); assert.equal(settingsRow(h, 'followCheapSlot').value, false);
    assert.equal(JSON.stringify(h.state.settings), before);
  } finally { h.dispose(); }
});

test('late catalog resolution after Settings unmount cannot remount controls, save settings, or affect a fresh reopen', async () => {
  const pending = deferred();
  const h = await setup(h => { h.overrides['get-catalog'] = () => pending.promise; });
  try {
    h.mountSettings(); await flush();
    const oldModel = picker(h, 'model'), oldThinking = picker(h, 'thinking');
    h.unmountSettings(); const handles = h.handles.length, calls = h.calls.length;
    pending.resolve({ slots: { cheap: { model: { provider: 'test', id: 'stale-cheap' }, thinkingLevel: 'high' } } }); await flush();
    assert.equal(oldModel.disposed, true); assert.equal(oldThinking.disposed, true);
    assert.equal(h.settings.children.length, 0); assert.equal(h.handles.length, handles); assert.equal(h.calls.length, calls);
    delete h.overrides['get-catalog'];
    h.catalog.slots.cheap.model.id = 'fresh-cheap'; h.catalog.slots.cheap.thinkingLevel = 'medium';
    h.mountSettings(); await flush();
    assert.notEqual(picker(h, 'model'), oldModel); assert.equal(settingsRow(h, 'followCheapSlot').value, true);
    await settingsRow(h, 'followCheapSlot').onChange(false);
    assert.deepEqual(savedSettings(h).at(-1)[1], { modelOverride: { provider: 'test', id: 'fresh-cheap' }, thinkingOverride: 'medium' });
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

test('native row menus preserve deck, proposition and cue reorder scopes', async () => {
  const h = await setup();
  try {
    h.state.propositions.push({ ...JSON.parse(JSON.stringify(h.state.propositions[0])), id: 'p2', name: 'Fact two', cues: [{ id: 'c2', question: 'Second cue', answer: 'Second answer' }] });
    h.state.decks[0].propositionIds = ['p2', 'p1'];
    h.state.propositions[0].cues.push({ id: 'c3', question: 'Third cue', answer: 'Third answer' });
    h.state.revision++; h.notify(); await flush(); openAll(h);
    assert.deepEqual(row(h, 'deck:d1').children.map(row => row.selection.label), ['Select Fact two', 'Select Fact one']);
    assert.equal(rowNode(h, 'deck:d1').querySelector('button[title="Deck actions"]').getAttribute('aria-label'), 'Deck actions');
    click(h, 'Move down', menu(h, 'deck:d1')); await flush();
    assert.deepEqual(h.calls.findLast(([op]) => op === 'reorder')[1], { kind: 'deck', id: 'd1', direction: 1 });
    assert.deepEqual(tree(h).props.rows.map(row => row.key), ['deck:d2', 'deck:d1']);
    click(h, 'Move up', menu(h, 'deck:d1:p:p1')); await flush();
    assert.deepEqual(h.calls.findLast(([op]) => op === 'reorder')[1], { kind: 'proposition', id: 'p1', deckId: 'd1', direction: -1 });
    click(h, 'Move down', menu(h, 'deck:d1:p:p1:cue:c1')); await flush();
    assert.deepEqual(h.calls.findLast(([op]) => op === 'reorder')[1], { kind: 'cue', id: 'c1', propositionId: 'p1', direction: 1 });
  } finally { h.dispose(); }
});

test('every row menu uses an accessible icon-only gear with explicit icon geometry, never an ellipsis', async () => {
  const h = await setup();
  try {
    openAll(h);
    const occurrences = [['deck:d1', 'Deck actions'], ['deck:d2', 'Deck actions'], ['deck:d1:p:p1', 'Proposition actions'], ['deck:d1:p:p1:cue:c1', 'Cue actions']];
    for (const [key, label] of occurrences) {
      const node = rowNode(h, key);
      const gear = h.handles.find(handle => handle.kind === 'button' && !handle.disposed && node.contains(handle.container) && handle.props.label === label);
      assert.ok(gear); assert.equal(gear.props.iconOnly, true);
      assert.ok(gear.container.closest('.fc-tree-more'), 'gear remains in its own muted actions wrapper');
      assert.equal(gear.props.size, 'icon-sm'); assert.equal(gear.props.variant, 'ghost');
      assert.equal(gear.props.title, label); assert.ok(gear.props.icon.trim());
      const artwork = document.createElement('div'); artwork.innerHTML = gear.props.icon;
      assert.ok(artwork.querySelector('svg polygon').getAttribute('points').trim());
      assert.ok(Number(artwork.querySelector('svg circle').getAttribute('r')) > 0);
      const button = gear.container.querySelector('button');
      assert.equal(button.getAttribute('aria-label'), label);
      assert.equal(button.textContent.includes(label), false, 'accessible label is not rendered visibly');
      assert.ok(button.querySelector('[aria-hidden=true] svg'));
      const popup = menu(h, key); assert.equal(popup.getAttribute('aria-label'), label);
      h.handles.findLast(handle => handle.kind === 'menu').dispose();
      gear.update({ disabled: true });
      assert.ok(button.disabled); assert.equal(button.getAttribute('aria-label'), label); assert.ok(button.querySelector('svg'));
      gear.update({ disabled: false });
    }
    assert.equal(h.app.textContent.includes('⋯'), false);
    assert.equal(h.handles.some(handle => handle.kind === 'button' && handle.props.label === '⋯'), false);
  } finally { h.dispose(); }
});

test('memberships require one deck and deck deletion requires explicit replacement', async () => {
  const h = await setup();
  try {
    openAll(h); click(h, 'Decks…', menu(h, 'deck:d1:p:p1'));
    const dialog = document.querySelector('[role=dialog]');
    const checkboxes = [...dialog.querySelectorAll('input')]; checkboxes.forEach(input => { input.checked = false; });
    click(h, 'Save memberships', dialog); await flush();
    assert.ok(dialog.textContent.includes('Choose at least one deck'));
    assert.equal(h.calls.some(([op]) => op === 'set-memberships'), false);
    click(h, 'Cancel', dialog);
    click(h, 'Deck settings', menu(h, 'deck:d1')); click(h, 'Delete deck…', document.querySelector('[role=dialog]'));
    const deletion = [...document.querySelectorAll('[role=dialog]')].at(-1);
    assert.ok(deletion.querySelector('select'));
    click(h, 'Delete deck', deletion); await flush();
    assert.ok(deletion.textContent.includes('Choose a replacement deck'));
    assert.equal(h.calls.some(([op]) => op === 'delete-deck'), false);
  } finally { h.dispose(); }
});

test('core source/extraction events refresh Archive only while mounted and dispose the native tree', async () => {
  const h = await setup();
  try {
    const nativeTree = tree(h);
    h.state.propositions[0].archived = true; h.state.revision++;
    h.appEvent('sources-changed'); await flush(); assert.ok(h.app.textContent.includes('Archive'));
    h.state.propositions[0].archived = false; h.state.revision++;
    h.appEvent('activity-changed'); await flush(); assert.equal(h.app.textContent.includes('Archive'), false);
    h.unmount(); assert.equal(nativeTree.disposed, true); const count = h.calls.length;
    h.appEvent('activity-changed'); h.appEvent('sources-changed'); await flush(); assert.equal(h.calls.length, count);
  } finally { h.dispose(); }
});

test('visible waiting review owns exactly one timer and clears it on host close or unmount', async () => {
  const h = await setup();
  const realSet = global.setTimeout, realClear = global.clearTimeout;
  const timers = new Map(); let timerId = 0;
  global.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  global.clearTimeout = id => timers.delete(id);
  try {
    h.overrides['next-review'] = async () => ({ ticket: null, nextDue: Date.now() + 60000 });
    click(h, 'Review', rowNode(h, 'deck:d1')); await flush(); assert.equal(timers.size, 1);
    h.notify(); await flush(); assert.equal(timers.size, 1);
    closeSurface(h); assert.equal(timers.size, 0);
    click(h, 'Review', rowNode(h, 'deck:d1')); await flush(); assert.equal(timers.size, 1);
    h.unmount(); assert.equal(timers.size, 0);
  } finally { global.setTimeout = realSet; global.clearTimeout = realClear; h.dispose(); }
});

test('search keeps native hierarchy and disables ordering through menu items', async () => {
  const h = await setup();
  try {
    const search = h.app.querySelector('input[type=search]'); change(search, 'Fact');
    for (const id of ['deck:d1', 'deck:d1:p:p1', 'deck:d1:p:p1:cue:c1']) {
      const popup = menu(h, id); const controls = [...popup.querySelectorAll('button')].filter(button => /^Move (up|down)$/.test(button.textContent));
      assert.equal(controls.length, 2); assert.ok(controls.every(button => button.disabled));
      h.handles.findLast(handle => handle.kind === 'menu').dispose();
    }
    assert.equal(h.calls.some(([op]) => op === 'reorder'), false);
  } finally { h.dispose(); }
});

test('activation reports missing public host capabilities clearly', async () => {
  const { activate } = await import(moduleUrl);
  const methods = ['mountMarkdown', 'mountKnowledgePicker', 'mountTree', 'openSurface', 'openMenu'];
  for (const missing of methods) {
    const ui = Object.fromEntries(methods.filter(method => method !== missing).map(method => [method, () => {}]));
    assert.throws(() => activate({ ui }), error => error instanceof Error && !(error instanceof TypeError) && error.message.includes(missing) && error.message.includes('update LearnHarness'));
  }
});

if (process.env.FLASHCARDS_BROWSER_FIXTURE) {
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>' + fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8') + '</style></head><body><script type="module">' + source + '\nwindow.h = (' + fixture.toString() + ')(document); activate(window.h.ctx); window.h.mount();</script></body></html>';
  fs.writeFileSync(process.env.FLASHCARDS_BROWSER_FIXTURE, html);
}
