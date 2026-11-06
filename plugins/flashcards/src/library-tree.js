// Plugin-owned data/actions inside the shared native tree. No host implementation imports.
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
function icon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  svg.classList.add('fc-tree-icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', kind === 'deck' ? 'M7 4h12a1 1 0 0 1 1 1v12M5 8h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2ZM6 12h8M6 16h5' : kind === 'proposition' ? 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z' : 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm3 5h10M7 13h7');
  svg.append(path); return svg;
}

const settingsIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><polygon points="20,12 21.81,13.95 21.24,15.83 18.65,16.44 17.66,17.66 17.56,20.31 15.83,21.24 13.56,19.85 12,20 10.05,21.81 8.17,21.24 7.56,18.65 6.34,17.66 3.69,17.56 2.76,15.83 4.15,13.56 4,12 2.19,10.05 2.76,8.17 5.35,7.56 6.34,6.34 6.44,3.69 8.17,2.76 10.44,4.15 12,4 13.95,2.19 15.83,2.76 16.44,5.35 17.66,6.34 20.31,6.44 21.24,8.17 19.85,10.44"/><circle cx="12" cy="12" r="3"/></svg>';

export function mountLibraryTree({ ctx, container, signal, button, onReview, onPractice, onPreview, onEdit, onDelete, onDeckSettings, onMemberships, onReorder, onRename, onSelection, onError }) {
  const viewport = el('div', 'fc-tree-viewport');
  const inner = el('div', 'fc-tree-inner');
  const empty = el('p', 'fc-muted');
  viewport.append(inner); container.append(viewport, empty);
  const selected = new Set(), expanded = new Set(), factories = new Map(), records = new Map(), mounted = new Map(), drafts = new Map();
  let state = null, query = '', disposed = false;
  const live = () => !disposed && !signal.aborted;
  const cueToken = id => `cue:${id}`;
  const propTokens = p => p.cues.filter(c => !c.deleted).map(c => cueToken(c.id));
  const leaves = p => { const ids = propTokens(p); return ids.length ? ids : [`proposition:${p.id}`]; };
  function selection() {
    const cueIds = [], propositionIds = [];
    for (const p of state?.propositions ?? []) {
      if (p.archived) continue;
      const cues = p.cues.filter(c => !c.deleted && selected.has(cueToken(c.id)));
      if (cues.length) { propositionIds.push(p.id); cueIds.push(...cues.map(c => c.id)); }
    }
    return { cueIds, propositionIds, count: selected.size };
  }
  const run = action => async () => { try { await action(); } catch (error) { if (live()) onError(error instanceof Error ? error.message : String(error)); } };
  function rowSelection(tokens, label) {
    const count = tokens.filter(key => selected.has(key)).length;
    return { label: `Select ${label}`, checked: count === tokens.length, indeterminate: count > 0 && count < tokens.length, onChange(value) {
      if (!live()) return;
      for (const token of tokens) { if (value) selected.add(token); else selected.delete(token); }
      render();
    } };
  }
  function disclosure(key, label) {
    return { label: `Toggle ${label}`, expanded: expanded.has(key) || !!query, onChange(value) {
      if (!live()) return;
      if (value) expanded.add(key); else expanded.delete(key);
      // Explicit folds during search should not instantly reopen themselves.
      if (query) searchFolds[value ? 'delete' : 'add'](key);
      render();
    } };
  }
  const searchFolds = new Set();
  function menuItems(record) {
    const { kind, deck, p, cue, archive } = record;
    if (archive) return [];
    const items = kind === 'deck' ? [
      { key: 'practice', label: 'Practice anytime', disabled: !state.propositions.some(p => !p.archived && deck.propositionIds.includes(p.id) && p.cues.some(c => !c.deleted)), onSelect: run(() => onPractice({ deckIds: [deck.id] })) },
      { key: 'settings', label: 'Deck settings', onSelect: run(() => onDeckSettings(record.deck)) },
    ]
      : kind === 'proposition' ? [{ key: 'memberships', label: 'Decks…', onSelect: run(() => onMemberships(record.p)) }]
      : [{ key: 'edit', label: 'Edit', onSelect: run(() => onEdit(record.p, record.cue)) }, { key: 'delete', label: 'Delete', onSelect: run(() => onDelete(record.p, record.cue)) }];
    const ids = kind === 'deck' ? state.decks.map(d => d.id) : kind === 'proposition' ? deck.propositionIds.filter(id => state.propositions.some(p => p.id === id && !p.archived)) : p.cues.filter(c => !c.deleted).map(c => c.id);
    const id = kind === 'deck' ? deck.id : kind === 'proposition' ? p.id : cue.id;
    for (const direction of [-1, 1]) items.push({ key: direction === -1 ? 'up' : 'down', label: direction === -1 ? 'Move up' : 'Move down', disabled: !!query || ids.indexOf(id) + direction < 0 || ids.indexOf(id) + direction >= ids.length, onSelect: run(() => onReorder({ kind, id, ...(kind === 'proposition' ? { deckId: deck.id } : kind === 'cue' ? { propositionId: p.id } : {}), direction })) });
    return items;
  }
  function content(key) {
    if (factories.has(key)) return factories.get(key);
    const factory = (slot, mountSignal) => {
      if (mountSignal.aborted || !live()) return;
      const record = records.get(key);
      const root = el('div', 'fc-tree-row-content');
      root.dataset.fcOccurrence = key;
      root.append(icon(record.kind === 'archive' ? 'deck' : record.kind));
      const labelSlot = el('span', 'fc-tree-name'); root.append(labelSlot);
      const label = el(record.kind === 'deck' || record.kind === 'cue' ? 'button' : 'span', 'fc-tree-label');
      if (label.tagName === 'BUTTON') label.type = 'button';
      labelSlot.append(label);
      const metadata = el('span', 'fc-tree-metadata'); root.append(metadata);
      let draft, input, error;
      if (record.kind === 'deck') {
        if (!drafts.has(record.deck.id)) drafts.set(record.deck.id, { editing: false, value: '', saving: false, error: '' });
        draft = drafts.get(record.deck.id);
        input = el('input', 'fc-tree-rename'); input.type = 'text'; input.setAttribute('aria-label', 'Deck name');
        error = el('span', 'fc-tree-rename-error'); error.setAttribute('role', 'alert');
        const commit = async () => {
          if (!live() || mountSignal.aborted || !draft.editing || draft.saving) return;
          const value = draft.value.trim();
          if (!value || value === record.deck.name) { draft.editing = false; draft.error = ''; refresh(); return; }
          draft.saving = true; refresh();
          try { await onRename(record.deck.id, value); draft.editing = false; draft.error = ''; }
          catch (cause) { draft.error = cause instanceof Error ? cause.message : String(cause); }
          finally { draft.saving = false; if (!mountSignal.aborted && live()) refresh(); }
        };
        label.addEventListener('click', event => { event.stopPropagation(); draft.editing = true; draft.value = record.deck.name; draft.error = ''; refresh(); input.focus(); input.select?.(); }, { signal: mountSignal });
        input.addEventListener('input', () => { draft.value = input.value; }, { signal: mountSignal });
        input.addEventListener('blur', () => { void commit(); }, { signal: mountSignal });
        input.addEventListener('keydown', event => {
          if (event.isComposing || event.keyCode === 229) return;
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!draft.saving) { draft.editing = false; draft.error = ''; refresh(); } }
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void commit(); }
        }, { signal: mountSignal });
        labelSlot.append(error);
        button(root, 'Review', run(() => onReview({ deckIds: [record.deck.id] })), mountSignal, { size: 'xs', variant: 'outline' });
      } else if (record.kind === 'cue') {
        label.addEventListener('click', event => { event.stopPropagation(); onPreview(record.p, record.cue, record.archive); }, { signal: mountSignal });
      }
      if (!record.archive && record.kind !== 'archive') {
        const more = el('span', 'fc-tree-more'); root.append(more);
        const actionsLabel = `${record.kind === 'deck' ? 'Deck' : record.kind === 'proposition' ? 'Proposition' : 'Cue'} actions`;
        button(more, actionsLabel, () => { ctx.ui.openMenu(more, { label: actionsLabel, items: menuItems(record) }, { signal: mountSignal }); }, mountSignal, { icon: settingsIcon, iconOnly: true, size: 'icon-sm', variant: 'ghost', title: actionsLabel });
      }
      function refresh() {
        const title = record.kind === 'deck' ? record.deck.name : record.kind === 'proposition' ? record.p.name : record.kind === 'cue' ? record.cue.question.replace(/\s+/g, ' ').trim() || 'Cue' : 'Archive';
        label.textContent = title;
        label.title = record.kind === 'proposition' ? record.p.statement || title : record.kind === 'deck' ? 'Rename deck' : title;
        metadata.textContent = record.kind === 'proposition' ? `${record.p.cues.filter(c => !c.deleted).length} cues` : '';
        if (draft) {
          label.hidden = draft.editing;
          if (draft.editing) { if (input.parentElement !== labelSlot) labelSlot.prepend(input); if (input.value !== draft.value) input.value = draft.value; }
          else input.remove();
          input.disabled = draft.saving; error.textContent = draft.error;
        }
      }
      mounted.set(key, refresh); slot.append(root); refresh();
      return () => { if (mounted.get(key) === refresh) mounted.delete(key); root.remove(); };
    };
    factories.set(key, factory); return factory;
  }
  function remember(key, data) {
    if (records.has(key)) Object.assign(records.get(key), data); else records.set(key, data);
    return content(key);
  }
  let tree = ctx.ui.mountTree(inner, { label: 'Flashcards library', header: 'Name', rows: [], columns: [
    { key: 'propositions', header: 'Propositions', width: '6.5rem', align: 'right' },
    { key: 'due', header: 'Due', width: '3rem', align: 'right' },
    { key: 'new', header: 'New today', width: '6rem', align: 'right' },
  ] }, { signal });
  function render() {
    if (!live() || !state) return;
    const liveProps = state.propositions.filter(p => !p.archived), byId = new Map(liveProps.map(p => [p.id, p]));
    const allowed = new Set([...state.decks.filter(d => !d.propositionIds.some(id => byId.has(id))).map(d => `deck:${d.id}`), ...liveProps.flatMap(leaves)]);
    for (const key of selected) if (!allowed.has(key)) selected.delete(key);
    const includes = p => !query || [p.name, p.statement, ...p.cues.filter(c => !c.deleted).flatMap(c => [c.question, c.answer])].some(text => String(text || '').toLocaleLowerCase().includes(query));
    const seen = new Set();
    function row(key, data, label, tokens, children) {
      seen.add(key);
      const branch = children?.length ? { children, disclosure: disclosure(key, label) } : {};
      if (branch.disclosure && query && searchFolds.has(key)) branch.disclosure.expanded = false;
      return { key, content: remember(key, data), ...(tokens ? { selection: rowSelection(tokens, label) } : {}), ...branch };
    }
    function proposition(p, deck, archive) {
      const key = archive ? `archive:p:${p.id}` : `deck:${deck.id}:p:${p.id}`;
      const children = p.cues.filter(c => !c.deleted).map(cue => row(`${key}:cue:${cue.id}`, { kind: 'cue', p, cue, archive }, cue.question, archive ? null : [cueToken(cue.id)]));
      return row(key, { kind: 'proposition', p, deck, archive }, p.name, archive ? null : leaves(p), children);
    }
    const rows = [];
    for (const deck of state.decks) {
      const all = deck.propositionIds.map(id => byId.get(id)).filter(Boolean);
      const deckMatches = !query || deck.name.toLocaleLowerCase().includes(query);
      const matching = all.filter(p => deckMatches || includes(p));
      if (query && !deckMatches && !matching.length) continue;
      const key = `deck:${deck.id}`, tokens = all.length ? [...new Set(all.flatMap(leaves))] : [`deck:${deck.id}`];
      const r = row(key, { kind: 'deck', deck, archive: false }, deck.name, tokens, matching.map(p => proposition(p, deck, false)));
      r.cells = { propositions: String(all.length), due: String(deck.due), new: `${deck.newToday} / ${deck.newLimit}` }; rows.push(r);
    }
    const archived = state.propositions.filter(p => p.archived && includes(p));
    if (archived.length) {
      const r = row('archive', { kind: 'archive', archive: true }, 'Archive', null, archived.map(p => proposition(p, null, true)));
      r.cells = { propositions: String(archived.length) }; rows.push(r);
    }
    tree.update({ rows });
    for (const [key, refresh] of mounted) if (seen.has(key)) refresh();
    empty.textContent = rows.length ? '' : query ? 'No matching flashcards.' : 'No flashcards yet. Pick knowledge or upload a file above to generate your first cues.';
    empty.hidden = !!rows.length;
    onSelection(selection());
  }
  const dispose = () => { if (disposed) return; disposed = true; tree.dispose(); viewport.remove(); empty.remove(); selected.clear(); records.clear(); factories.clear(); mounted.clear(); drafts.clear(); };
  signal.addEventListener('abort', dispose, { once: true });
  return {
    update(next, search = '') { if (!live()) return; const q = search.toLocaleLowerCase().trim(); if (q !== query) searchFolds.clear(); query = q; state = next; render(); },
    selection,
    clearSelection() { if (!live()) return; selected.clear(); render(); },
    revealDeck(id) {
      if (!live() || !state?.decks.some(deck => deck.id === id)) return false;
      query = ''; searchFolds.clear(); expanded.add(`deck:${id}`); render();
      // Only scroll plugin-owned content while focus remains in this library.
      if (container.closest('.fc-root')?.contains(document.activeElement)) {
        const node = [...inner.querySelectorAll('[data-fc-occurrence]')].find(node => node.dataset.fcOccurrence === `deck:${id}`);
        node?.scrollIntoView?.({ block: 'nearest' });
      }
      return true;
    },
    dispose,
  };
}
