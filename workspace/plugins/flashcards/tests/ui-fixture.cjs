const { parseHTML } = require('linkedom');

// Public controlled UI contract only; no native widget implementation imports.
function fixture(document) {
  const app = document.createElement('main'); document.body.append(app);
  const settings = document.createElement('aside'); document.body.append(settings);
  const controller = new AbortController();
  const calls = [], conversions = [], markdowns = [], registrations = [], handles = [], cleanups = [];
  const listeners = new Set(), resync = new Set(), appEvents = new Set();
  let view, settingsMount;
  const day = offset => {
    const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  let state = {
    revision: 1,
    statistics: {
      states: { new: 0, learning: 0, review: 1, relearning: 0 },
      due: [{ day: null, count: 0 }, ...Array.from({ length: 8 }, (_, i) => ({ day: day(i), count: i === 0 ? 1 : 0 }))],
      activity: Array.from({ length: 14 }, (_, i) => ({ day: day(i - 13), count: i === 13 ? 1 : 0 })),
    },
    settings: { retention: .9, learningSteps: [1, 10], relearningSteps: [10], dayStart: 4, fuzz: false, chunkBudget: 4000, modelOverride: null },
    decks: [{ id: 'd1', name: 'Notes', newLimit: 20, newToday: 0, due: 1, propositionIds: ['p1'] }, { id: 'd2', name: 'Custom', newLimit: 20, newToday: 0, due: 0, propositionIds: [] }],
    propositions: [{ id: 'p1', name: 'Fact one', statement: 'A useful statement', memberships: ['d1'], cues: [{ id: 'c1', question: 'Question **one**?', answer: 'SECRET ANSWER' }], schedule: {}, archived: false, version: 1 }], batch: null,
  };
  const overrides = {};
  let filePreflight;
  const manualReceipts = new Map(), deletionReceipts = new Map();
  const catalog = { slots: { cheap: { model: { provider: 'test', id: 'cheap' }, thinkingLevel: 'low' } } };
  const clone = value => JSON.parse(JSON.stringify(value));
  function handle(kind, container, props, signal, render, cleanup) {
    let current = props, disposed = false;
    const mount = { kind, container, get props() { return current; }, signal,
      update(next) { if (!disposed) { current = { ...current, ...next }; render?.(current); } },
      dispose() { if (disposed) return; disposed = true; cleanup?.(); container.replaceChildren(); },
      get disposed() { return disposed; },
    };
    handles.push(mount); signal.addEventListener('abort', () => mount.dispose(), { once: true }); render?.(current); return mount;
  }
  function overlay(kind, props, { signal }) {
    const container = document.createElement('section'); container.setAttribute('role', 'dialog');
    container.setAttribute('aria-label', props.title); document.body.append(container);
    const scope = new AbortController(); let disposed = false, cleanup;
    const mount = { kind, container, props, signal,
      dispose() { if (disposed) return; disposed = true; scope.abort(); cleanup?.(); container.remove(); },
      close() { mount.dispose(); props.onClose?.(); },
      update() {}, get disposed() { return disposed; },
    };
    handles.push(mount);
    const close = document.createElement('button'); close.textContent = 'Close'; close.setAttribute('aria-label', 'Close');
    close.onclick = () => mount.close(); container.append(close);
    cleanup = props.content(container, scope.signal);
    signal.addEventListener('abort', () => mount.dispose(), { once: true });
    if (signal.aborted) mount.dispose();
    return mount;
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
    documents: {
      async toMarkdown(file, options = {}) {
        conversions.push({ file, signal: options.signal });
        if (overrides.toMarkdown) return overrides.toMarkdown(file, options);
        return { name: file.name, markdown: '# Imported\n\nUseful fact.', notices: [] };
      },
    },
    async call(operation, input) {
      calls.push([operation, input]);
      if (overrides[operation]) return overrides[operation](input);
      if (operation === 'get-state' || operation === 'resume-results') return clone(state);
      if (operation === 'get-catalog') return clone(catalog);
      if (operation === 'preflight') return { id: 'pf', propositionCount: input.propositionIds.length, chunkCount: 1, estimatedTokens: 123, modelLabel: 'Test model' };
      if (operation === 'preflight-file' || operation === 'preflight-file-retry') {
        filePreflight = { id: operation === 'preflight-file' ? 'pf-file' : 'pf-file-retry', kind: 'file', name: input.name || state.batch.name, chunkCount: 1, estimatedTokens: 321, modelLabel: 'Test file model' };
        return clone(filePreflight);
      }
      if (operation === 'open-file-deck') {
        const deck = state.decks.find(deck => deck.sourceId === input.sourceId);
        if (!deck) throw new Error('File source not found');
        return { state: clone(state), deckId: deck.id };
      }
      if (operation === 'create-card' || operation === 'create-cue') {
        for (const key of ['question', 'answer', 'requestId', ...(operation === 'create-card' ? ['name'] : [])]) {
          if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`${key} must not be blank.`);
        }
        const signature = JSON.stringify([operation, input]), prior = manualReceipts.get(input.requestId);
        if (prior) {
          if (prior.signature !== signature) throw new Error('This request ID was already used for different work.');
          return { state: clone(state), ...prior.ids };
        }
        let p;
        if (operation === 'create-card') {
          const deck = state.decks.find(d => d.id === input.deckId); if (!deck) throw new Error('Deck not found.');
          p = { id: `manual:${input.requestId}`, origin: 'manual', name: input.name.trim(), statement: '', memberships: [deck.id], cues: [], schedule: { state: 0 }, firstReviewedAt: null, learningCueId: null, archived: false, version: 0 };
          state.propositions.push(p); deck.propositionIds.push(p.id); state.statistics.states.new++;
        } else {
          p = state.propositions.find(p => p.id === input.propositionId);
          if (!p || p.archived) throw new Error('Target unavailable.');
        }
        const cueId = `cue:${input.requestId}`;
        p.cues.push({ id: cueId, question: input.question, answer: input.answer, latestRating: null }); p.version++; state.revision++;
        const ids = { propositionId: p.id, cueId }; manualReceipts.set(input.requestId, { signature, ids });
        return { state: clone(state), ...ids };
      }
      if (operation === 'next-review') return { ticket: { id: 't1', propositionId: 'p1', cueId: 'c1', question: 'Question **one**?', propositionName: 'Fact one' }, remaining: 1 };
      if (operation === 'reveal-review') return { answer: 'SECRET ANSWER', intervals: { 1: 60000, 2: 300000, 3: 600000, 4: 86400000 } };
      if (operation === 'rate-review') return { ok: true };
      if (operation === 'save-settings') { state.settings = { ...state.settings, ...input }; if (state.settings.thinkingOverride === null) delete state.settings.thinkingOverride; }
      if (operation === 'save-deck') Object.assign(state.decks.find(d => d.id === input.id), input);
      if (operation === 'save-cue') { Object.assign(state.propositions[0].cues[0], { question: input.question, answer: input.answer }); state.propositions[0].version++; }
      if (operation === 'delete-content') {
        const signature = JSON.stringify(input), prior = deletionReceipts.get(input.requestId);
        if (prior) {
          if (prior !== signature) throw new Error('This request ID was already used for different work.');
          return clone(state);
        }
        if (['running', 'cancelling'].includes(state.batch?.status)) throw new Error('Wait for generation to finish or cancel it before deleting content.');
        if (input.revision !== state.revision) throw new Error('The library changed. Reload and confirm the deletion again.');
        const whole = new Set(input.propositionIds ?? []), cues = new Set(input.cueIds ?? []), affected = new Set(input.deckIds ?? []);
        for (const d of state.decks) if (affected.has(d.id)) for (const id of d.propositionIds) whole.add(id);
        const touched = new Set();
        for (const p of state.propositions) if (whole.has(p.id) || p.cues.some(c => cues.has(c.id))) {
          touched.add(p.id);
          for (const id of p.memberships) affected.add(id);
          p.cues = whole.has(p.id) ? [] : p.cues.filter(c => !cues.has(c.id)); p.version++;
          if (!p.cues.some(c => c.id === p.learningCueId)) p.learningCueId = null;
          if (!p.cues.length) for (const d of state.decks) d.propositionIds = d.propositionIds.filter(id => id !== p.id);
        }
        state.propositions = state.propositions.filter(p => !touched.has(p.id) || p.cues.length);
        if (input.deleteEmptyDecks) state.decks = state.decks.filter(d => !affected.has(d.id) || d.propositionIds.length);
        deletionReceipts.set(input.requestId, signature); state.revision++;
        return clone(state);
      }
      if (operation === 'set-memberships') state.propositions[0].memberships = input.deckIds;
      if (operation === 'reorder') {
        const list = input.kind === 'deck' ? state.decks : input.kind === 'proposition' ? state.decks.find(d => d.id === input.deckId).propositionIds : state.propositions.find(p => p.id === input.propositionId).cues;
        const index = list.findIndex(item => (typeof item === 'string' ? item : item.id) === input.id);
        const other = index + input.direction; [list[index], list[other]] = [list[other], list[index]];
      }
      if (operation === 'start-generation') {
        state.batch = { id: 'b1', status: 'running', chunks: [{ id: 'chunk1', status: 'running', targetIds: ['p1'] }], added: 0, completed: 0, total: 1, failedTargetIds: [] };
        if (filePreflight?.id === input.preflightId) {
          if (!state.decks.some(deck => deck.id === 'file-deck')) state.decks.push({ id: 'file-deck', sourceId: 'file-source', name: filePreflight.name, propositionIds: [], newLimit: 20, newToday: 0, due: 0 });
          Object.assign(state.batch, { kind: 'file', sourceId: 'file-source', deckId: 'file-deck', name: filePreflight.name, failedChunkIds: [] });
        }
      }
      state.revision++; return clone(state);
    },
    ui: {
      mountButton(container, props, { signal }) {
        const button = document.createElement('button'); container.append(button);
        button.addEventListener('click', () => { if (!button.disabled) Promise.resolve(mount.props.onClick()).catch(() => {}); });
        const mount = handle('button', container, props, signal, p => {
          if (p.iconOnly && (!p.label?.trim() || !p.icon?.trim())) throw new Error('Icon-only buttons require a label and icon');
          button.replaceChildren(); button.disabled = !!p.disabled;
          if (p.title) button.title = p.title; else button.removeAttribute('title');
          if (p.icon) { const icon = document.createElement('span'); icon.setAttribute('aria-hidden', 'true'); icon.innerHTML = p.icon; button.append(icon); }
          if (p.iconOnly) button.setAttribute('aria-label', p.label);
          else { button.removeAttribute('aria-label'); button.append(document.createTextNode(p.label)); }
        }); return mount;
      },
      mountMarkdown(container, props, { signal }) { markdowns.push({ text: props.text, signal }); return handle('markdown', container, props, signal, p => { container.textContent = p.text; }); },
      mountKnowledgePicker(container, props, { signal }) {
        const button = document.createElement('button'); button.textContent = 'Pick nodes'; container.append(button);
        const mount = handle('knowledge', container, props, signal); button.onclick = () => mount.props.onChange(['p1']); return mount;
      },
      mountSettingsRows(container, props, { signal }) {
        return handle('rows', container, props, signal, p => { container.textContent = p.rows.map(row => `${row.label}: ${row.value}${row.description ? `\n${row.description}` : ''}`).join('\n'); });
      },
      mountModelPicker(container, props, { signal }) { return handle('model', container, props, signal); },
      mountThinkingPicker(container, props, { signal }) { return handle('thinking', container, props, signal); },
      mountTree(container, props, { signal }) {
        const entries = new Map();
        function drop(entry) { for (const slot of entry.slots.values()) { slot.scope?.abort(); slot.cleanup?.(); } entry.node.remove(); }
        function content(entry, key, value) {
          let slot = entry.slots.get(key);
          if (!slot) { slot = { node: document.createElement('span') }; entry.slots.set(key, slot); entry.node.append(slot.node); }
          if (slot.value === value) return;
          slot.scope?.abort(); slot.cleanup?.(); slot.node.replaceChildren(); slot.value = value;
          if (typeof value === 'function') { slot.scope = new AbortController(); slot.cleanup = value(slot.node, slot.scope.signal); }
          else if (value?.nodeType) slot.node.append(value);
          else slot.node.textContent = String(value ?? '');
        }
        function render(p) {
          const visible = new Set();
          function rows(list) { for (const row of list) {
            visible.add(row.key); let entry = entries.get(row.key);
            if (!entry) { entry = { node: document.createElement('div'), slots: new Map() }; entry.node.dataset.fixtureRow = row.key; entries.set(row.key, entry); }
            container.append(entry.node);
            if (row.selection) {
              if (!entry.checkbox) { entry.checkbox = document.createElement('input'); entry.checkbox.type = 'checkbox'; entry.checkbox.addEventListener('change', () => entry.selection?.onChange(entry.checkbox.checked)); entry.node.prepend(entry.checkbox); }
              entry.selection = row.selection; entry.checkbox.setAttribute('aria-label', row.selection.label); entry.checkbox.checked = row.selection.checked;
              entry.checkbox.indeterminate = !!row.selection.indeterminate; entry.checkbox.disabled = !!row.selection.disabled;
            } else { entry.checkbox?.remove(); entry.checkbox = null; }
            if (row.disclosure) {
              if (!entry.toggle) { entry.toggle = document.createElement('button'); entry.toggle.addEventListener('click', () => entry.disclosure.onChange(!entry.disclosure.expanded)); entry.node.prepend(entry.toggle); }
              entry.disclosure = row.disclosure; entry.toggle.textContent = row.disclosure.label; entry.toggle.setAttribute('aria-expanded', String(row.disclosure.expanded));
            } else { entry.toggle?.remove(); entry.toggle = null; }
            content(entry, 'content', row.content);
            for (const column of p.columns ?? []) content(entry, column.key, row.cells?.[column.key]);
            if (row.disclosure?.expanded) rows(row.children ?? []);
          } }
          rows(p.rows);
          for (const [key, entry] of entries) if (!visible.has(key)) { drop(entry); entries.delete(key); }
        }
        return handle('tree', container, props, signal, render, () => { for (const entry of entries.values()) drop(entry); entries.clear(); });
      },
      openDialog(props, options) { return overlay('dialog', props, options); },
      openSurface(props, options) {
        if (arguments.length !== 2 || typeof props?.content !== 'function') throw new Error('Expected targetless openSurface(props, options)');
        return overlay('surface', props, options);
      },
      openMenu(anchor, props, { signal }) {
        if (!anchor?.nodeType) throw new Error('Expected public menu anchor');
        const container = document.createElement('div'); container.setAttribute('role', 'menu'); container.setAttribute('aria-label', props.label || 'Actions'); document.body.append(container);
        let mount;
        mount = handle('menu', container, props, signal, p => {
          container.replaceChildren();
          for (const item of p.items) {
            const button = document.createElement('button'); button.textContent = item.label; button.disabled = !!item.disabled; button.setAttribute('role', 'menuitem'); container.append(button);
            button.onclick = () => { if (!button.disabled) { mount.dispose(); props.onClose?.(); Promise.resolve(item.onSelect()).catch(() => {}); } };
          }
        }, () => container.remove());
        return mount;
      },
    },
  };
  let viewController, viewCleanup, settingsController, settingsCleanup;
  return {
    ctx, app, settings, calls, conversions, markdowns, handles, registrations, overrides, catalog,
    get state() { return state; },
    mount() { viewController = new AbortController(); viewCleanup = view.mount(app, viewController.signal); },
    unmount() { viewController?.abort(); viewCleanup?.(); },
    mountSettings() { this.unmountSettings(); settingsController = new AbortController(); settingsCleanup = settingsMount(settings, settingsController.signal); },
    unmountSettings() { settingsController?.abort(); settingsCleanup?.(); settingsCleanup = undefined; },
    notify() { for (const fn of listeners) fn({ pluginId: 'flashcards', topic: 'changed' }); },
    resync() { for (const fn of resync) fn(); },
    appEvent(type) { for (const fn of appEvents) fn({ type }); },
    dispose() { this.unmount(); this.unmountSettings(); controller.abort(); for (const fn of cleanups) fn(); app.remove(); settings.remove(); },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function createDocument() {
  const { document } = parseHTML('<html><body></body></html>');
  global.document = document;
  if (!global.crypto) global.crypto = require('node:crypto').webcrypto;
  return document;
}
module.exports = { fixture, flush, deferred, createDocument };
