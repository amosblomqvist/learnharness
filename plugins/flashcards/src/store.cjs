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
const defaults = () => ({ retention: 0.9, learningSteps: [1, 10], relearningSteps: [10], dayStart: 4, fuzz: false, chunkBudget: 4000, modelOverride: null });
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
