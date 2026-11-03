'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

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
  return {
    get: () => state,
    change(update) {
      const next = structuredClone(state);
      const result = update(next);
      next.revision++;
      const temporary = `${file}.${randomUUID()}.tmp`;
      let fd;
      try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(next));
        fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        fs.renameSync(temporary, file);
        state = next;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return result;
    },
  };
}
module.exports = { openStore, defaults };
