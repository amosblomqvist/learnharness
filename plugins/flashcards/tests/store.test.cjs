'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../src/store.cjs');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flashcards-store-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('failed mutation and atomic write leave memory and persisted store unchanged', t => {
  const dir = directory(t), file = path.join(dir, 'flashcards.json');
  const store = openStore(dir);
  store.change(s => s.decks.push({ id: 'kept', name: 'Kept', propositionIds: [], newLimit: 20 }));
  const before = structuredClone(store.get()), bytes = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.change(s => { s.decks.length = 0; throw new Error('Invalid update'); }), /Invalid update/);
  assert.deepEqual(store.get(), before);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Synthetic rename failure'); });
  try {
    assert.throws(() => store.change(s => { s.decks.length = 0; }), /Synthetic rename failure/);
  } finally { rename.mock.restore(); }
  assert.deepEqual(store.get(), before);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(fs.readdirSync(dir), ['flashcards.json']);
  assert.deepEqual(openStore(dir).get(), before);
  store.change(s => { s.decks[0].name = 'Next successful write'; });
  assert.equal(openStore(dir).get().decks[0].name, 'Next successful write');
  assert.equal(store.get().revision, before.revision + 1);
});

test('malformed and unsupported stores fail closed without overwriting original bytes', t => {
  const dir = directory(t), file = path.join(dir, 'flashcards.json');
  for (const bytes of ['{"broken":', JSON.stringify({ version: 99, revision: 0, decks: [], reviews: [], batches: [], propositions: {}, settings: {} })]) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => openStore(dir), /Could not read Flashcards data|Unsupported or invalid/);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.deepEqual(fs.readdirSync(dir), ['flashcards.json']);
  }
});
