'use strict';
const { randomUUID, createHash } = require('node:crypto');
const path = require('node:path');
const { openStore } = require('./store.cjs');
const scheduler = require('./scheduler.cjs');
const { statistics } = require('./statistics.cjs');
const fileGeneration = require('./file-generation.cjs');

const { graphInstructions: instructions, graphPromptFor: promptFor } = require('./generation-prompts.cjs');
const resultSchema = {
  type: 'object', additionalProperties: false, required: ['propositions'], properties: {
    propositions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['propositionId', 'cards'], properties: {
      propositionId: { type: 'string', minLength: 1 }, cards: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['question', 'answer'], properties: { question: { type: 'string', minLength: 1 }, answer: { type: 'string', minLength: 1 } } } },
    } } },
  },
};
const estimate = (input, language) => Math.ceil(Buffer.byteLength(instructions + JSON.stringify(resultSchema) + promptFor(input, language), 'utf8') / 3) + 256;
const fingerprint = (input) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const activeBatch = (s) => s.batches.findLast(b => ['running', 'cancelling'].includes(b.status));
const memberships = (s, id) => s.decks.filter(d => d.propositionIds.includes(id)).map(d => d.id);
const isLocal = p => p.origin === 'file' || p.origin === 'manual';
const reviewConfiguration = s => fingerprint({ retention: s.retention, learningSteps: s.learningSteps, relearningSteps: s.relearningSteps, dayStart: s.dayStart, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
const fail = (message) => { throw new Error(message); };
function requiredText(value, label) { if (typeof value !== 'string' || !value.trim()) fail(`${label} must not be blank.`); return value; }
function validateSettings(patch, old) {
  const allowed = new Set(['retention', 'learningSteps', 'relearningSteps', 'dayStart', 'chunkBudget', 'modelOverride', 'thinkingOverride', 'language']);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) fail(`Unsupported setting: ${key}`);
  const s = { ...old, ...patch };
  if (s.thinkingOverride === null) delete s.thinkingOverride;
  if (!Number.isFinite(s.retention) || s.retention < .7 || s.retention > .99) fail('Desired retention must be between 70% and 99%.');
  for (const key of ['learningSteps', 'relearningSteps']) {
    if (!Array.isArray(s[key]) || !s[key].length || s[key].some((v, i, a) => !Number.isSafeInteger(v) || v < 1 || v >= 1440 || (i > 0 && v <= a[i - 1]))) fail('Use nonempty, increasing whole-minute steps shorter than one day.');
  }
  if (!Number.isInteger(s.dayStart) || s.dayStart < 0 || s.dayStart > 23) fail('Study-day start must be a whole hour from 0 to 23.');
  if (!Number.isSafeInteger(s.chunkBudget) || s.chunkBudget < 1) fail('Input budget must be a positive safe whole number.');
  if (s.modelOverride !== null && (!s.modelOverride || typeof s.modelOverride.provider !== 'string' || typeof s.modelOverride.id !== 'string')) fail('Invalid model override.');
  if (s.thinkingOverride !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(s.thinkingOverride)) fail('Invalid thinking level.');
  if (s.language !== undefined && (typeof s.language !== 'string' || !s.language.trim())) fail('Language must be a nonempty text string.');
  if (s.language) s.language = s.language.trim();
  return s;
}
function validateResult(result, context) {
  const input = context.input;
  if (!result || !Array.isArray(result.propositions)) fail('Return a propositions array.');
  const remaining = new Set(input.targets);
  for (const row of result.propositions) {
    if (!remaining.delete(row.propositionId)) fail(`Unknown or repeated target: ${row.propositionId}`);
    if (!Array.isArray(row.cards)) fail('Each target needs a cards array.');
    const known = input.cards.find(c => c.propositionId === row.propositionId);
    const questions = new Set((known?.active ?? []).map(c => c.question.trim()));
    for (const card of row.cards) {
      requiredText(card.question, 'Question'); requiredText(card.answer, 'Answer');
      if (questions.has(card.question.trim())) fail(`Duplicate question for ${row.propositionId}; propose a distinct missing cue.`);
      questions.add(card.question.trim());
    }
  }
  if (remaining.size) fail(`Missing targets: ${[...remaining].join(', ')}`);
}
function pack(graph, ids, state) {
  const nodes = new Map(graph.propositions.map(n => [n.id, n]));
  const targets = [...new Set(ids)];
  if (!targets.length) fail('Select at least one proposition.');
  for (const id of targets) if (!nodes.has(id)) fail(`Selected proposition is no longer in the graph: ${id}`);
  function assemble(selected) {
    const selectedSet = new Set(selected);
    const chains = graph.chains.filter(c => selectedSet.has(c.conclusion) || c.premises.some(id => selectedSet.has(id)));
    const needed = new Set([...selected, ...chains.flatMap(c => [...c.premises, c.conclusion])]);
    const propositions = [...needed].map(id => {
      const n = nodes.get(id); if (!n) fail(`Incomplete reasoning chain: ${id}`);
      return { id, name: n.name, statement: n.statement };
    });
    const sources = selected.map(id => {
      const node = nodes.get(id), sourceId = node.provenance[0]?.chatId;
      if (!sourceId) fail(`No birth source is recorded for ${node.name}.`);
      const label = graph.sessions[sourceId] ?? (graph.fileSources[sourceId] ? path.basename(graph.fileSources[sourceId]) : sourceId);
      return { propositionId: id, sourceId, label, node };
    });
    const cards = selected.map(id => {
      const cues = state.propositions[id]?.cues ?? [];
      return { propositionId: id, active: cues.filter(c => !c.deleted).map(({ question, answer }) => ({ question, answer })) };
    });
    return { targets: selected, propositions, chains: chains.map(({ id, premises, conclusion }) => ({ id, premises, conclusion })), cards, sources };
  }
  // Like core extraction, the chunk budget covers source material only.
  // Instructions, schema, chains and existing cards still count in estimate()
  // for full-request cost and model-context checks, but not for chunk grouping.
  const chunks = []; let current = [], currentTokens = 0;
  for (const id of targets) {
    const node = nodes.get(id), tokens = Math.ceil(`${node.name}\n${node.statement}`.length / 4);
    if (current.length && currentTokens + tokens > state.settings.chunkBudget) {
      chunks.push(assemble(current)); current = []; currentTokens = 0;
    }
    // An indivisible over-budget target rides alone, as a core message does.
    current.push(id); currentTokens += tokens;
  }
  if (current.length) chunks.push(assemble(current));
  return chunks;
}

function activate(ctx) {
  if (!ctx.workers?.register || !ctx.learning?.graph) fail('This app build does not provide the plugin capabilities required by Flashcards.');
  const store = openStore(ctx.dataDirectory);
  const preflights = new Map(), tickets = new Map(), observers = new Map(), applicationErrors = new Map();
  let disposed = false, sourceCleanupError = null;
  const alive = () => { if (disposed || ctx.signal.aborted) fail('Flashcards is disabled.'); };
  const notify = (topic = 'changed') => { if (!disposed && !ctx.signal.aborted) ctx.events.emit(topic); };
  function change(update, topic) { alive(); const result = store.change(update); notify(topic); return result; }
  // Commit metadata removal first; a durable queue makes file cleanup retryable
  // after unlink/save failures without resurrecting decks or source records.
  function finishSourceCleanup() {
    const pending = store.get().pendingSourceRemovals ?? [];
    if (!pending.length) { sourceCleanupError = null; return; }
    try {
      for (const id of pending) store.removeSource(id);
      change(s => { delete s.pendingSourceRemovals; });
      sourceCleanupError = null;
    } catch (error) {
      sourceCleanupError = `Content was deleted, but saved-file cleanup is pending: ${error.message}. Retry deletion or reload Flashcards to finish cleanup.`;
      throw new Error(sourceCleanupError);
    }
  }
  try { finishSourceCleanup(); } catch { /* expose pending cleanup in the view; retry on deletion or next activation */ }
  function graphNow() { const g = ctx.learning.graph(); if (!Array.isArray(g.propositions) || !Array.isArray(g.chains)) fail('Could not read the knowledge graph.'); return g; }
  const prop = (s, id) => Object.hasOwn(s.propositions, id) ? s.propositions[id] : fail('Proposition not found.');
  const deck = (s, id) => s.decks.find(d => d.id === id) ?? fail('Deck not found.');
  const fileSource = (s, id) => Object.hasOwn(s.fileSources ?? {}, id) ? s.fileSources[id] : fail('File source not found.');
  function liveIds(s) { return new Set([...graphNow().propositions.map(p => p.id), ...Object.values(s.propositions).filter(isLocal).map(p => p.id)]); }
  function counts(s, now) {
    const { start, end } = scheduler.dayBounds(now, s.settings.dayStart);
    const result = Object.fromEntries(s.decks.map(d => [d.id, 0]));
    for (const review of s.reviews) if (review.introduced && review.at >= start && review.at < end) for (const id of review.deckIds) if (id in result) result[id]++;
    return result;
  }
  function view() {
    alive(); const s = store.get(), live = liveIds(s), now = Date.now();
    const newCounts = counts(s, now);
    const propositions = Object.values(s.propositions).map(p => ({ ...p, memberships: memberships(s, p.id), archived: !live.has(p.id) }));
    const decks = s.decks.map(d => ({ ...d, newToday: newCounts[d.id], due: propositions.filter(p => !p.archived && d.propositionIds.includes(p.id) && p.cues.some(c => !c.deleted) && p.schedule.state !== 0 && scheduler.isDue(p.schedule, now, s.settings.dayStart)).length }));
    const b = s.batches.at(-1);
    const batch = b ? { ...b, kind: b.kind ?? 'graph', chunks: b.chunks.map(c => {
      if (applicationErrors.has(c.id)) return { ...c, error: applicationErrors.get(c.id) };
      if (['queued', 'running'].includes(c.status) && c.taskId) { try { const t = ctx.workers.get(c.taskId); return { ...c, status: t.status === 'succeeded' ? 'saving' : t.status }; } catch { /* keep durable application status */ } }
      return c;
    }), added: b.chunks.reduce((n, c) => n + (c.added || 0), 0), completed: b.chunks.filter(c => ['applied', 'failed', 'cancelled', 'interrupted'].includes(c.status)).length, total: b.chunks.length,
      failedTargetIds: b.chunks.filter(c => ['failed', 'cancelled', 'interrupted'].includes(c.status)).flatMap(c => c.targetIds ?? []),
      ...(b.kind === 'file' ? { failedChunkIds: b.chunks.filter(c => ['failed', 'cancelled', 'interrupted'].includes(c.status)).map(c => c.id) } : {}),
      error: b.chunks.map(c => applicationErrors.get(c.id)).find(Boolean),
    } : null;
    return { revision: s.revision, settings: s.settings, decks, propositions, batch, statistics: statistics(s, live, now), ...(sourceCleanupError ? { cleanupError: sourceCleanupError } : {}) };
  }
  function finishBatch(s, b) {
    if (b.chunks.some(c => !['applied', 'failed', 'cancelled', 'interrupted'].includes(c.status))) return;
    b.status = b.cancelRequested ? 'cancelled' : b.chunks.every(c => c.status === 'applied') ? 'completed' : b.chunks.every(c => c.status === 'interrupted') ? 'interrupted' : 'partial';
  }
  function applyOutcome(batchId, chunkId, task) {
    if (disposed || ctx.signal.aborted) return;
    try {
      change(s => {
        const b = s.batches.find(b => b.id === batchId), c = b?.chunks.find(c => c.id === chunkId);
        if (!c || c.status === 'applied' || ['failed', 'cancelled', 'interrupted'].includes(c.status)) return;
        if (b.cancelRequested) { c.status = 'cancelled'; finishBatch(s, b); return; }
        if (task.status !== 'succeeded') { c.status = task.status === 'cancelled' ? 'cancelled' : task.status === 'interrupted' ? 'interrupted' : 'failed'; c.error = `Worker did not return a result (${task.error?.code || task.status}). Check Background agents for details.`; finishBatch(s, b); return; }
        let added = 0;
        if (b.kind === 'file') {
          const source = fileSource(s, b.sourceId), destination = deck(s, source.deckId);
          for (const row of task.result.facts) {
            let p = Object.values(s.propositions).find(p => p.origin === 'file' && p.sourceId === source.id && p.statement.trim() === row.statement.trim());
            if (!p) {
              p = { id: `file:${randomUUID()}`, origin: 'file', sourceId: source.id, name: row.name, statement: row.statement, cues: [], schedule: scheduler.createSchedule(), firstReviewedAt: null, learningCueId: null, version: 0 };
              s.propositions[p.id] = p; destination.propositionIds.push(p.id);
            }
            const seen = new Set(p.cues.map(c => c.question.trim()));
            for (const card of row.cards) if (!seen.has(card.question.trim())) {
              seen.add(card.question.trim()); p.cues.push({ id: randomUUID(), question: card.question, answer: card.answer, latestRating: null }); p.version++; added++;
            }
          }
        } else for (const row of task.result.propositions) {
          const source = task.input.sources.find(x => x.propositionId === row.propositionId);
          let p = s.propositions[row.propositionId];
          const seen = new Set((p?.cues ?? []).map(c => c.question.trim()));
          const additions = row.cards.filter(card => { const q = card.question.trim(); if (seen.has(q)) return false; seen.add(q); return true; });
          if (!p && additions.length) {
            let destination = s.decks.find(d => d.sourceId === source.sourceId);
            if (!destination) { destination = { id: randomUUID(), name: source.label, sourceId: source.sourceId, newLimit: 20, propositionIds: [] }; s.decks.push(destination); }
            p = { id: row.propositionId, origin: 'graph', name: source.node.name, statement: source.node.statement, snapshot: source.node, cues: [], schedule: scheduler.createSchedule(), firstReviewedAt: null, learningCueId: null, version: 0 };
            s.propositions[p.id] = p; destination.propositionIds.push(p.id);
          }
          if (p) for (const card of additions) { p.cues.push({ id: randomUUID(), question: card.question, answer: card.answer, latestRating: null }); p.version++; added++; }
        }
        c.status = 'applied'; c.added = added; finishBatch(s, b);
      }, 'batch-changed');
      applicationErrors.delete(chunkId);
    } catch (error) { applicationErrors.set(chunkId, `Result could not be saved: ${error.message}`); notify('batch-changed'); }
  }
  function watch(batchId, chunkId, taskId) {
    if (observers.has(taskId)) return;
    let last = '';
    const unsubscribe = ctx.workers.subscribe(taskId, task => {
      const current = `${task.status}:${task.turns}:${task.activity}`;
      if (current !== last) { last = current; notify('batch-changed'); }
    });
    observers.set(taskId, unsubscribe);
    ctx.workers.wait(taskId, ctx.signal).then(() => {
      if (disposed || ctx.signal.aborted) return;
      applyOutcome(batchId, chunkId, ctx.workers.get(taskId));
      observers.get(taskId)?.(); observers.delete(taskId);
    }).catch(error => { if (!disposed && !ctx.signal.aborted) { applicationErrors.set(chunkId, error.message); notify('batch-changed'); } });
  }
  function reconcile() {
    alive(); const tasks = ctx.workers.list();
    for (const b of store.get().batches) for (const c of b.chunks) {
      if (['applied', 'failed', 'cancelled', 'interrupted'].includes(c.status)) continue;
      const t = tasks.find(t => t.requestId === c.requestId);
      if (!t) {
        if (c.taskId && !b.cancelRequested) { applicationErrors.set(c.id, 'The worker record could not be read. No result has been assumed.'); continue; }
        change(s => { const batch = s.batches.find(x => x.id === b.id), chunk = batch.chunks.find(x => x.id === c.id); chunk.status = batch.cancelRequested ? 'cancelled' : 'interrupted'; finishBatch(s, batch); }, 'batch-changed'); continue;
      }
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(t.status)) applyOutcome(b.id, c.id, t);
      else {
        if (!c.taskId) change(s => { const chunk = s.batches.find(x => x.id === b.id).chunks.find(x => x.id === c.id); chunk.taskId = t.id; chunk.status = t.status; }, 'batch-changed');
        watch(b.id, c.id, t.id);
      }
    }
  }
  ctx.cleanup(ctx.workers.register({ id: 'generate-cues-v1', instructions, resultSchema, validateResult }));
  ctx.cleanup(ctx.workers.register({ id: 'generate-file-facts-v1', instructions: fileGeneration.instructions, resultSchema: fileGeneration.resultSchema, validateResult: fileGeneration.validateResult }));
  reconcile();

  async function resolveModel(settings) {
    const catalog = await ctx.inference.catalog(); alive();
    const pin = settings.modelOverride ? { model: settings.modelOverride } : catalog.slots?.cheap;
    if (!pin?.model) fail('Configure the cheap model slot or choose a Flashcards model override.');
    const entry = catalog.models.find(m => m.provider === pin.model.provider && m.id === pin.model.id);
    if (!entry) fail('The selected model is unavailable. Choose a configured model.');
    const thinkingLevel = settings.thinkingOverride ?? pin.thinkingLevel;
    if (thinkingLevel && !entry.supportedLevels.includes(thinkingLevel)) fail('The selected thinking level is not supported by this model.');
    return { spec: { ...pin.model, ...(thinkingLevel ? { thinkingLevel } : {}) }, entry };
  }
  function register(name, handler) { ctx.handle(name, (input = {}) => { alive(); if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid operation input.'); return handler(input); }); }
  register('get-state', view);
  register('get-catalog', () => ctx.inference.catalog());
  register('save-settings', patch => { change(s => { s.settings = validateSettings(patch, s.settings); }); return view(); });
  register('create-deck', ({ name }) => { change(s => s.decks.push({ id: randomUUID(), name: requiredText(name, 'Deck name').trim(), newLimit: 20, propositionIds: [] })); return view(); });
  function createManualCard(input, newTarget) {
    const requestId = requiredText(input.requestId, 'Request ID');
    const question = requiredText(input.question, 'Question'), answer = requiredText(input.answer, 'Answer');
    const destination = newTarget
      ? { deckId: requiredText(input.deckId, 'Deck ID'), name: requiredText(input.name, 'Name').trim() }
      : { propositionId: requiredText(input.propositionId, 'Target ID') };
    const hash = fingerprint({ kind: newTarget ? 'create-card' : 'create-cue', ...destination, question, answer });
    const prior = store.get().creationReceipts?.find(r => r.requestId === requestId);
    if (prior) {
      if (prior.hash !== hash) fail('This request ID was already used for different work.');
      return { state: view(), propositionId: prior.propositionId, cueId: prior.cueId };
    }
    const created = change(s => {
      let p;
      if (newTarget) {
        const d = deck(s, destination.deckId);
        p = { id: `manual:${randomUUID()}`, origin: 'manual', name: destination.name, statement: '', cues: [], schedule: scheduler.createSchedule(), firstReviewedAt: null, learningCueId: null, version: 0 };
        s.propositions[p.id] = p; d.propositionIds.push(p.id);
      } else {
        p = prop(s, destination.propositionId);
        if (!isLocal(p) && !graphNow().propositions.some(node => node.id === p.id)) fail('The target is no longer in the graph.');
      }
      const cue = { id: randomUUID(), question, answer, latestRating: null };
      p.cues.push(cue); p.version++;
      s.creationReceipts ??= [];
      s.creationReceipts.push({ requestId, hash, propositionId: p.id, cueId: cue.id });
      return { propositionId: p.id, cueId: cue.id };
    });
    return { state: view(), ...created };
  }
  register('create-card', input => createManualCard(input, true));
  register('create-cue', input => createManualCard(input, false));
  register('save-deck', patch => {
    change(s => {
      const d = deck(s, patch.id);
      if (Object.hasOwn(patch, 'name')) d.name = requiredText(patch.name, 'Deck name').trim();
      if (Object.hasOwn(patch, 'newLimit')) { if (!Number.isSafeInteger(patch.newLimit) || patch.newLimit < 0) fail('Daily limit must be a nonnegative safe whole number.'); d.newLimit = patch.newLimit; }
      for (const source of Object.values(s.fileSources ?? {})) if (source.deckId === d.id) { source.deckName = d.name; source.newLimit = d.newLimit; }
    }); return view();
  });
  function deleteContent(input) {
    const requestId = requiredText(input.requestId, 'Request ID');
    const ids = key => {
      const values = input[key] === undefined ? [] : input[key];
      if (!Array.isArray(values) || values.some(id => typeof id !== 'string' || !id.trim())) fail(`Invalid ${key} deletion selection.`);
      return [...new Set(values)].sort();
    };
    const scope = { deckIds: ids('deckIds'), propositionIds: ids('propositionIds'), cueIds: ids('cueIds'), deleteEmptyDecks: input.deleteEmptyDecks, revision: input.revision };
    if (typeof scope.deleteEmptyDecks !== 'boolean' || !Number.isSafeInteger(scope.revision)) fail('Invalid deletion options.');
    if (!scope.deckIds.length && !scope.propositionIds.length && !scope.cueIds.length) fail('Select content to delete.');
    const hash = fingerprint(scope), prior = store.get().deletionReceipts?.find(r => r.requestId === requestId);
    if (prior) {
      if (prior.hash !== hash) fail('This request ID was already used for different work.');
      finishSourceCleanup(); return view();
    }
    change(s => {
      if (activeBatch(s)) fail('Wait for generation to finish or cancel it before deleting content.');
      if (s.revision !== scope.revision) fail('The library changed. Reload and confirm the deletion again.');
      const whole = new Set(scope.propositionIds), cueIds = new Set(scope.cueIds), affectedDecks = new Set(scope.deckIds);
      for (const id of scope.deckIds) for (const pid of deck(s, id).propositionIds) whole.add(pid);
      for (const id of whole) prop(s, id);
      const owners = new Map(Object.values(s.propositions).flatMap(p => p.cues.map(c => [c.id, p.id])));
      for (const id of cueIds) if (!owners.has(id)) fail('Selected card no longer exists.');
      const affected = new Set([...whole, ...[...cueIds].map(id => owners.get(id))]);
      for (const id of affected) {
        const p = prop(s, id);
        for (const deckId of memberships(s, id)) affectedDecks.add(deckId);
        p.cues = whole.has(id) ? [] : p.cues.filter(c => !cueIds.has(c.id));
        if (!p.cues.length) {
          delete s.propositions[id];
          for (const d of s.decks) d.propositionIds = d.propositionIds.filter(pid => pid !== id);
        } else {
          if (!p.cues.some(c => c.id === p.learningCueId)) p.learningCueId = null;
          p.version++;
        }
      }
      if (scope.deleteEmptyDecks) s.decks = s.decks.filter(d => !affectedDecks.has(d.id) || d.propositionIds.length);
      for (const source of Object.values(s.fileSources ?? {})) if (!s.decks.some(d => d.id === source.deckId)) {
        // Only decks removed by this action own the sources being cleaned up.
        if (!affectedDecks.has(source.deckId) || !scope.deleteEmptyDecks) continue;
        delete s.fileSources[source.id];
        s.pendingSourceRemovals ??= [];
        if (!s.pendingSourceRemovals.includes(source.id)) s.pendingSourceRemovals.push(source.id);
      }
      s.deletionReceipts ??= []; s.deletionReceipts.push({ requestId, hash });
    });
    finishSourceCleanup(); return view();
  }
  register('delete-content', deleteContent);
  register('delete-deck', ({ id, replacementDeckId }) => {
    if (replacementDeckId !== undefined) fail('Replacement decks are no longer used. Reload Flashcards.');
    return deleteContent({ deckIds: [id], deleteEmptyDecks: true, revision: store.get().revision, requestId: randomUUID() });
  });
  register('set-memberships', ({ propositionId, deckIds }) => {
    change(s => {
      if (!Array.isArray(deckIds) || !deckIds.length || deckIds.some(id => typeof id !== 'string')) fail('Keep at least one deck membership.');
      const selected = new Set(deckIds); for (const id of selected) deck(s, id);
      const p = prop(s, propositionId);
      for (const d of s.decks) { d.propositionIds = d.propositionIds.filter(id => id !== p.id || selected.has(d.id)); if (selected.has(d.id) && !d.propositionIds.includes(p.id)) d.propositionIds.push(p.id); }
      p.version++;
    }); return view();
  });
  register('save-cue', ({ propositionId, cueId, question, answer, version }) => {
    requiredText(question, 'Question'); requiredText(answer, 'Answer');
    change(s => { const p = prop(s, propositionId); if (p.version !== version) fail('This card changed elsewhere. Reload before saving.'); const c = p.cues.find(c => c.id === cueId && !c.deleted) ?? fail('Card not found.'); c.question = question; c.answer = answer; p.version++; }); return view();
  });
  register('delete-cue', ({ propositionId, cueId, version }) => {
    const p = prop(store.get(), propositionId);
    if (p.version !== version) fail('This card changed elsewhere. Reload before deleting.');
    if (!p.cues.some(c => c.id === cueId)) fail('Card not found.');
    return deleteContent({ cueIds: [cueId], deleteEmptyDecks: true, revision: store.get().revision, requestId: randomUUID() });
  });
  register('reorder', ({ kind, id, deckId, propositionId, direction }) => {
    if (![-1, 1].includes(direction)) fail('Invalid order direction.');
    const live = kind === 'proposition' ? liveIds(store.get()) : null;
    change(s => {
      const list = kind === 'deck' ? s.decks : kind === 'proposition' ? deck(s, deckId).propositionIds : kind === 'cue' ? prop(s, propositionId).cues : fail('Invalid order kind.');
      const positions = list.flatMap((x, i) => (kind === 'cue' ? !x.deleted : kind === 'proposition' ? live.has(x) : true) ? [i] : []);
      const index = positions.findIndex(i => (typeof list[i] === 'string' ? list[i] : list[i].id) === id);
      if (index < 0) fail('Item not found.');
      const other = index + direction;
      if (other >= 0 && other < positions.length) { const a = positions[index], b = positions[other]; [list[a], list[b]] = [list[b], list[a]]; }
    }); return view();
  });
  register('preflight', async ({ propositionIds }) => {
    if (!Array.isArray(propositionIds) || propositionIds.some(id => typeof id !== 'string')) fail('Select proposition IDs.');
    if (activeBatch(store.get())) fail('A generation batch is already active.');
    const resolved = await resolveModel(store.get().settings);
    const state = store.get(), chunks = pack(graphNow(), propositionIds, state);
    const plans = chunks.map(input => {
      const tokens = estimate(input, state.settings.language);
      const maxTokens = Math.min(8192, resolved.entry.maxTokens ?? 8192, (resolved.entry.contextWindow ?? Infinity) - tokens - 256);
      if (maxTokens < 1024) fail('The selected model cannot fit this context and an output allowance. Reduce the chunk budget or choose another model.');
      return { input, prompt: promptFor(input, state.settings.language), maxTokens, tokens };
    });
    const id = randomUUID();
    preflights.set(id, { kind: 'graph', revision: state.revision, settingsHash: fingerprint(state.settings), model: resolved.spec, plans, createdAt: Date.now() });
    for (const [key, value] of preflights) if (Date.now() - value.createdAt > 600000) preflights.delete(key);
    return { id, chunkCount: plans.length, propositionCount: new Set(propositionIds).size, estimatedTokens: plans.reduce((n, p) => n + p.tokens, 0), modelLabel: resolved.entry.name };
  });
  function rememberFilePlan(file, resolved, state, source, ranges, retryOf) {
    const plans = fileGeneration.prepareFileChunks({ name: file.name, markdown: file.markdown, chunkBudget: state.settings.chunkBudget, entry: resolved.entry, ...(ranges ? { ranges } : {}), language: state.settings.language || 'auto' });
    const id = randomUUID(), sourceId = source?.id ?? randomUUID(), deckId = source?.deckId ?? randomUUID();
    preflights.set(id, { kind: 'file', file, sourceId, deckId, retryOf, revision: state.revision, settingsHash: fingerprint(state.settings), model: resolved.spec, plans, createdAt: Date.now() });
    for (const [key, value] of preflights) if (Date.now() - value.createdAt > 600000) preflights.delete(key);
    return { id, kind: 'file', name: file.name, chunkCount: plans.length, estimatedTokens: plans.reduce((n, p) => n + p.tokens, 0), modelLabel: resolved.entry.name };
  }
  register('preflight-file', async input => {
    const file = fileGeneration.validateFileInput(input), state = store.get();
    const previous = Object.values(state.fileSources ?? {}).find(source => source.fingerprint === file.fingerprint);
    if (previous) return { existingSourceId: previous.id, ...(state.decks.some(d => d.id === previous.deckId) ? { deckId: previous.deckId } : {}), name: previous.name };
    if (activeBatch(state)) fail('A generation batch is already active.');
    const resolved = await resolveModel(state.settings);
    const latest = store.get(), concurrent = Object.values(latest.fileSources ?? {}).find(source => source.fingerprint === file.fingerprint);
    if (concurrent) return { existingSourceId: concurrent.id, ...(latest.decks.some(d => d.id === concurrent.deckId) ? { deckId: concurrent.deckId } : {}), name: concurrent.name };
    if (activeBatch(latest)) fail('A generation batch is already active.');
    return rememberFilePlan(file, resolved, latest);
  });
  register('open-file-deck', ({ sourceId }) => {
    const source = fileSource(store.get(), sourceId);
    deck(store.get(), source.deckId);
    return { state: view(), deckId: source.deckId };
  });
  register('preflight-file-retry', async ({ batchId }) => {
    const state = store.get(), batch = state.batches.find(b => b.id === batchId);
    if (!batch || batch.kind !== 'file') fail('File generation batch not found.');
    if (activeBatch(state)) fail('A generation batch is already active.');
    let ranges = batch.chunks.filter(c => ['failed', 'cancelled', 'interrupted'].includes(c.status)).map(({ start, end }) => ({ start, end }));
    // Old batch IDs cannot replay portions already accepted by a later retry.
    for (const b of state.batches.filter(b => b.sourceId === batch.sourceId)) for (const c of b.chunks.filter(c => c.status === 'applied')) {
      ranges = ranges.flatMap(r => c.end <= r.start || c.start >= r.end ? [r] : [r.start < c.start ? { start: r.start, end: c.start } : null, c.end < r.end ? { start: c.end, end: r.end } : null].filter(Boolean));
    }
    if (!ranges.length) fail('No failed file chunks remain to retry.');
    const source = fileSource(state, batch.sourceId), file = fileGeneration.validateFileInput({ name: source.name, markdown: store.readSource(source.id) });
    if (file.fingerprint !== source.fingerprint) fail('The saved file source changed. Retry was not started.');
    const resolved = await resolveModel(state.settings);
    return rememberFilePlan(file, resolved, state, source, ranges, batch.id);
  });
  register('start-generation', async ({ preflightId, requestId }) => {
    requiredText(requestId, 'Request ID');
    const previous = store.get().batches.find(b => b.requestId === requestId);
    if (previous) { if (previous.preflightId !== preflightId) fail('This request ID was already used for different work.'); return view(); }
    const plan = preflights.get(preflightId) ?? fail('The generation plan expired. Run preflight again.');
    const resolved = await resolveModel(store.get().settings);
    const accepted = store.get().batches.find(b => b.requestId === requestId);
    if (accepted) { if (accepted.preflightId !== preflightId) fail('This request ID was already used for different work.'); return view(); }
    if (plan.revision !== store.get().revision || plan.settingsHash !== fingerprint(store.get().settings) || fingerprint(plan.model) !== fingerprint(resolved.spec)) fail('The library or model changed. Run preflight again.');
    if (plan.kind === 'file') {
      const checked = fileGeneration.validateFileInput(plan.file);
      if (checked.fingerprint !== plan.file.fingerprint) fail('The file changed. Run preflight again.');
      if (plan.retryOf) fileSource(store.get(), plan.sourceId);
    } else {
      const live = new Set(graphNow().propositions.map(n => n.id));
      if (plan.plans.some(p => p.input.targets.some(id => !live.has(id)))) fail('Selected knowledge changed. Run preflight again.');
    }
    const batchId = randomUUID();
    const newSource = plan.kind === 'file' && !Object.hasOwn(store.get().fileSources ?? {}, plan.sourceId);
    if (newSource) store.writeSource(plan.sourceId, plan.file.markdown);
    try {
      change(s => {
        if (activeBatch(s)) fail('A generation batch is already active.');
        if (plan.kind === 'file') {
          s.fileSources ??= {};
          s.fileSources[plan.sourceId] ??= { id: plan.sourceId, name: plan.file.name, fingerprint: plan.file.fingerprint, deckId: plan.deckId, deckName: plan.file.name, newLimit: 20 };
          const source = fileSource(s, plan.sourceId);
          if (newSource) s.decks.push({ id: source.deckId, name: source.deckName, newLimit: source.newLimit, propositionIds: [] });
          else deck(s, source.deckId);
        }
        s.batches.push({ id: batchId, kind: plan.kind ?? 'graph', requestId, preflightId, status: 'running', cancelRequested: false, createdAt: Date.now(),
          ...(plan.kind === 'file' ? { sourceId: plan.sourceId, deckId: plan.deckId, name: plan.file.name } : {}),
          chunks: plan.plans.map(p => ({ id: randomUUID(), requestId: randomUUID(), ...(plan.kind === 'file' ? { start: p.start, end: p.end } : { targetIds: p.input.targets }), status: 'pending', taskId: null, added: 0 })) });
      }, 'batch-changed');
    } catch (error) { if (newSource && !Object.hasOwn(store.get().fileSources ?? {}, plan.sourceId)) store.removeSource(plan.sourceId); throw error; }
    preflights.delete(preflightId);
    // Dispatch is backend-owned; navigation cannot stop accepted work.
    queueMicrotask(() => {
      const chunks = store.get().batches.find(b => b.id === batchId).chunks;
      chunks.forEach((chunk, index) => {
        if (disposed || ctx.signal.aborted) return;
        try {
          if (store.get().batches.find(b => b.id === batchId).cancelRequested) return;
          const p = plan.plans[index];
          const task = ctx.workers.start(plan.kind === 'file' ? 'generate-file-facts-v1' : 'generate-cues-v1', { requestId: chunk.requestId, input: plan.kind === 'file' ? { ...p.input, sourceId: plan.sourceId } : p.input, prompt: p.prompt, model: plan.model, purpose: 'user', maxTurns: 4, options: { maxTokens: p.maxTokens, timeoutMs: 120000, maxRetries: 0 } });
          change(s => { const c = s.batches.find(b => b.id === batchId).chunks.find(c => c.id === chunk.id); c.taskId = task.id; c.status = 'queued'; }, 'batch-changed');
          watch(batchId, chunk.id, task.id);
        } catch (error) {
          // If acceptance happened, the durable request ID is enough to recover it.
          const accepted = ctx.workers.list().find(t => t.requestId === chunk.requestId);
          if (accepted) { watch(batchId, chunk.id, accepted.id); applicationErrors.set(chunk.id, error.message); }
          else { try { change(s => { const b = s.batches.find(b => b.id === batchId), c = b.chunks.find(c => c.id === chunk.id); c.status = 'failed'; c.error = error.message; finishBatch(s, b); }, 'batch-changed'); } catch (failure) { applicationErrors.set(chunk.id, failure.message); } }
        }
      });
    });
    return view();
  });
  register('cancel-generation', ({ batchId }) => {
    const b = store.get().batches.find(b => b.id === batchId) ?? fail('Batch not found.');
    change(s => { const current = s.batches.find(x => x.id === b.id); current.cancelRequested = true; current.status = 'cancelling'; for (const c of current.chunks) if (c.status === 'pending') c.status = 'cancelled'; finishBatch(s, current); }, 'batch-changed');
    for (const c of b.chunks) { const t = ctx.workers.list().find(t => t.requestId === c.requestId); if (t && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(t.status)) ctx.workers.cancel(t.id); }
    reconcile(); return view();
  });
  register('resume-results', () => { reconcile(); return view(); });

  function scopeIds(s, scope) {
    if (scope.deckIds !== undefined && (!Array.isArray(scope.deckIds) || scope.deckIds.some(id => !s.decks.some(d => d.id === id)))) fail('Selected deck no longer exists.');
    if (scope.propositionIds !== undefined && !Array.isArray(scope.propositionIds)) fail('Invalid review selection.');
    if (scope.cueIds !== undefined && (!Array.isArray(scope.cueIds) || scope.cueIds.some(id => typeof id !== 'string'))) fail('Invalid cue selection: use an array of cue IDs.');
    const ds = scope.deckIds ? s.decks.filter(d => scope.deckIds.includes(d.id)) : s.decks;
    let ids = [...new Set(ds.flatMap(d => d.propositionIds))];
    if (scope.propositionIds) ids = ids.filter(id => scope.propositionIds.includes(id));
    return { decks: ds, ids };
  }
  function reviewCues(p, scope) {
    const active = p.cues.filter(c => !c.deleted);
    if (scope.cueIds === undefined) return active;
    const pinned = [1, 3].includes(p.schedule.state) && active.find(c => c.id === p.learningCueId);
    // Do not switch away from an active learning cue just because it is unselected.
    if (pinned && !scope.cueIds.includes(pinned.id)) return [];
    return active.filter(c => scope.cueIds.includes(c.id));
  }
  function validTicket(id, mustReveal = false, now = Date.now()) {
    const t = tickets.get(id) ?? fail('This review expired. Load the next card.');
    const s = store.get(), p = prop(s, t.propositionId);
    if (p.version !== t.version || reviewConfiguration(s.settings) !== t.settingsHash || scheduler.studyDay(now, s.settings.dayStart) !== t.day) fail('This review changed elsewhere. Load the next card.');
    if (!isLocal(p) && !graphNow().propositions.some(n => n.id === p.id)) fail('The proposition is no longer in the graph.');
    const { ids } = scopeIds(s, t.scope);
    if (!ids.includes(p.id)) fail('The review selection changed. Load the next card.');
    const c = reviewCues(p, t.scope).find(c => c.id === t.cueId) ?? fail('This card is no longer available in the review selection.');
    if (mustReveal && !t.revealed) fail('Reveal the answer before rating.');
    if (p.schedule.state === 0) { const d = deck(s, t.admittingDeckId); if (counts(s, now)[d.id] >= d.newLimit) fail('The new-proposition limit has been reached for this deck.'); }
    else if (!scheduler.isDue(p.schedule, now, s.settings.dayStart)) fail('This proposition is not due.');
    return { t, p, c, s };
  }
  register('next-review', scope => {
    const s = store.get(), live = liveIds(s), now = Date.now();
    const selection = scopeIds(s, scope), used = counts(s, now);
    const candidates = selection.ids.map(id => s.propositions[id]).filter(p => p && live.has(p.id) && reviewCues(p, scope).length);
    const ready = candidates.filter(p => p.schedule.state !== 0 && scheduler.isDue(p.schedule, now, s.settings.dayStart));
    ready.sort((a, b) => ((a.schedule.state === 1 || a.schedule.state === 3) ? 0 : 1) - ((b.schedule.state === 1 || b.schedule.state === 3) ? 0 : 1) || a.schedule.due - b.schedule.due);
    let p = ready[0], admittingDeckId = null;
    if (!p) {
      for (const d of selection.decks) {
        if (used[d.id] >= d.newLimit) continue;
        p = candidates.find(p => p.schedule.state === 0 && d.propositionIds.includes(p.id));
        if (p) { admittingDeckId = d.id; break; }
      }
    }
    if (!p) {
      const future = candidates.filter(p => [1, 3].includes(p.schedule.state) && p.schedule.due > now).map(p => p.schedule.due);
      return { ticket: null, ...(future.length ? { nextDue: Math.min(...future) } : {}), remaining: 0 };
    }
    // Count introductions in the same deterministic admission order without
    // consuming allowances, changing schedules, or making additional cue choices.
    let remaining = ready.length;
    const simulated = { ...used }, introduced = new Set();
    for (const d of selection.decks) for (const candidate of candidates) {
      if (simulated[d.id] >= d.newLimit) break;
      if (candidate.schedule.state !== 0 || introduced.has(candidate.id) || !d.propositionIds.includes(candidate.id)) continue;
      introduced.add(candidate.id); remaining++;
      for (const id of memberships(s, candidate.id)) simulated[id]++;
    }
    const active = reviewCues(p, scope);
    const chosen = ([1, 3].includes(p.schedule.state) && active.find(c => c.id === p.learningCueId)) || scheduler.chooseCue(active);
    const id = randomUUID();
    tickets.set(id, { id, propositionId: p.id, cueId: chosen.id, version: p.version, settingsHash: reviewConfiguration(s.settings), day: scheduler.studyDay(now, s.settings.dayStart), scope: structuredClone(scope), admittingDeckId, revealed: false });
    return { ticket: { id, propositionId: p.id, cueId: chosen.id, question: chosen.question, propositionName: p.name }, remaining };
  });
  register('reveal-review', ({ ticketId }) => {
    const now = Date.now();
    const { t, p, c, s } = validTicket(ticketId, false, now); t.revealed = true;
    const previews = scheduler.preview(p.schedule, now, s.settings);
    return { answer: c.answer, intervals: Object.fromEntries([1, 2, 3, 4].map(r => [r, previews[r].state === 2 ? previews[r].scheduled_days * 86400000 : previews[r].due - now])) };
  });
  register('rate-review', ({ ticketId, rating, requestId }) => {
    requiredText(requestId, 'Request ID');
    const previous = store.get().reviews.find(r => r.requestId === requestId);
    if (previous) { if (previous.ticketId !== ticketId || previous.rating !== rating) fail('This request ID was already used for different work.'); return { ok: true }; }
    if (![1, 2, 3, 4].includes(rating)) fail('Invalid rating.');
    const now = Date.now(), { t } = validTicket(ticketId, true, now);
    change(s => {
      const p = prop(s, t.propositionId), c = p.cues.find(c => c.id === t.cueId);
      const before = p.schedule, introduced = p.firstReviewedAt == null;
      p.schedule = scheduler.rate(before, rating, now, s.settings);
      p.learningCueId = [1, 3].includes(p.schedule.state) ? c.id : null;
      p.firstReviewedAt ??= now; c.latestRating = rating; c.lastReviewedAt = now; p.version++;
      s.reviews.push({ id: randomUUID(), requestId, ticketId, propositionId: p.id, cueId: c.id, rating, at: now, before, after: p.schedule, introduced, deckIds: introduced ? memberships(s, p.id) : [], settings: structuredClone(s.settings) });
    });
    tickets.delete(ticketId); return { ok: true };
  });
  const cleanup = () => { disposed = true; for (const stop of observers.values()) stop(); observers.clear(); preflights.clear(); tickets.clear(); };
  ctx.cleanup(cleanup);
}
module.exports = { activate, pack, validateResult, estimate, instructions, resultSchema, validateSettings };
