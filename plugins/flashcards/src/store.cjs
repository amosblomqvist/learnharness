'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function atomicWrite(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, content); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
// Keep retry receipts separate from card text so deletion can be physical.
function migrate(state) {
  let changed = false;
  for (const p of Object.values(state.propositions)) {
    for (const cue of p.cues) if (cue.creation) {
      state.creationReceipts ??= [];
      if (!state.creationReceipts.some(r => r.requestId === cue.creation.requestId)) state.creationReceipts.push({ ...cue.creation, propositionId: p.id, cueId: cue.id });
      delete cue.creation; changed = true;
    }
    const active = p.cues.filter(c => !c.deleted);
    if (active.length !== p.cues.length || !active.length) {
      changed = true;
      if (active.length) {
        p.cues = active; p.version++;
        if (!active.some(c => c.id === p.learningCueId)) p.learningCueId = null;
      } else {
        delete state.propositions[p.id];
        for (const d of state.decks) d.propositionIds = d.propositionIds.filter(id => id !== p.id);
      }
    }
  }
  // Older deck-only deletion could leave an upload record that recreated the
  // deleted deck. Source assets now belong strictly to an existing deck.
  for (const source of Object.values(state.fileSources ?? {})) if (!state.decks.some(d => d.id === source.deckId)) {
    delete state.fileSources[source.id];
    state.pendingSourceRemovals ??= [];
    if (!state.pendingSourceRemovals.includes(source.id)) state.pendingSourceRemovals.push(source.id);
    changed = true;
  }
  // Ratings/timing/schedule snapshots suffice for statistics and retry receipts.
  for (const r of state.reviews) for (const key of ['question', 'answer']) if (Object.hasOwn(r, key)) { delete r[key]; changed = true; }
  if (!state.settings?.language) { if (state.settings) state.settings.language = 'auto'; changed = true; }
  return changed;
}
const defaults = () => ({ retention: 0.9, learningSteps: [1, 10], relearningSteps: [10], dayStart: 4, fuzz: false, chunkBudget: 4000, modelOverride: null, language: 'auto' });
function openStore(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'flashcards.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not read Flashcards data: ${error.message}`);
    state = { version: 1, revision: 0, settings: defaults(), decks: [], propositions: {}, reviews: [], batches: [] };
  }
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || !Array.isArray(state.decks) || !Array.isArray(state.reviews) || !Array.isArray(state.batches) || !state.propositions || !state.settings) throw new Error('Unsupported or invalid Flashcards data. No data was changed.');
  const migrated = structuredClone(state);
  if (migrate(migrated)) {
    migrated.revision++;
    atomicWrite(file, JSON.stringify(migrated));
    state = migrated;
  }
  const sourceFile = id => {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid file source ID.');
    return path.join(directory, 'sources', `${id}.md`);
  };
  return {
    get: () => state,
    writeSource(id, markdown) { const file = sourceFile(id); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); atomicWrite(file, markdown); },
    readSource(id) { return fs.readFileSync(sourceFile(id), 'utf8'); },
    removeSource(id) { try { fs.unlinkSync(sourceFile(id)); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
    change(update) {
      const next = structuredClone(state);
      const result = update(next);
      next.revision++;
      atomicWrite(file, JSON.stringify(next));
      state = next;
      return result;
    },
  };
}
module.exports = { openStore, defaults };
