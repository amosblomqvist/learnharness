'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
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

test('converted sources use UUID-only private paths and never embed Markdown in the store state', t => {
  const dir = directory(t), store = openStore(dir), id = randomUUID(), markdown = '# Converted Markdown\n\nA supported fact.';
  const before = structuredClone(store.get());
  store.writeSource(id, markdown);
  assert.deepEqual(store.get(), before); assert.equal(fs.existsSync(path.join(dir, 'flashcards.json')), false);
  assert.equal(store.readSource(id), markdown);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sources')), [`${id}.md`]);
  assert.equal(fs.statSync(path.join(dir, 'sources', `${id}.md`)).mode & 0o777, process.platform === 'win32' ? 0o666 : 0o600);
  assert.equal(fs.statSync(path.join(dir, 'sources')).mode & 0o777, process.platform === 'win32' ? 0o666 : 0o700);
  for (const unsafe of ['../outside', '/tmp/outside', 'notes.md', '', null]) {
    assert.throws(() => store.writeSource(unsafe, markdown), /Invalid file source ID/);
    assert.throws(() => store.readSource(unsafe), /Invalid file source ID/);
    assert.throws(() => store.removeSource(unsafe), /Invalid file source ID/);
  }
  assert.equal(openStore(dir).readSource(id), markdown);
  store.removeSource(id); store.removeSource(id);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sources')), []);
});

test('failed source replacement retains accepted bytes and removes temporary files', t => {
  const dir = directory(t), store = openStore(dir), id = randomUUID();
  store.writeSource(id, 'Accepted converted Markdown');
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Source rename unavailable'); });
  try { assert.throws(() => store.writeSource(id, 'Unaccepted replacement'), /Source rename unavailable/); }
  finally { rename.mock.restore(); }
  assert.equal(store.readSource(id), 'Accepted converted Markdown');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sources')), [`${id}.md`]);
});

test('legacy cleanup is atomic, retains live manual cues and text-free receipts, and removes only deleted card text and review snapshots', t => {
  const dir = directory(t), file = path.join(dir, 'flashcards.json'), original = openStore(dir);
  original.change(s => {
    s.decks.push({ id: 'd', name: 'Kept container', propositionIds: ['p'], newLimit: 20 });
    s.propositions.p = { id: 'p', name: 'Live target', version: 1, learningCueId: 'gone', cues: [
      { id: 'kept', question: 'Kept question', answer: 'Kept answer', creation: { requestId: 'create-kept', hash: 'hash-kept' } },
      { id: 'gone', question: 'DELETED QUESTION', answer: 'DELETED ANSWER', deleted: true, creation: { requestId: 'create-gone', hash: 'hash-gone' } },
    ] };
    s.reviews.push({ id: 'r', propositionId: 'p', cueId: 'gone', question: 'OLD REVIEW QUESTION', answer: 'OLD REVIEW ANSWER', rating: 3, at: 123 });
  });
  const bytes = fs.readFileSync(file, 'utf8'), rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Migration save unavailable'); });
  try { assert.throws(() => openStore(dir), /Migration save unavailable/); }
  finally { rename.mock.restore(); }
  assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.deepEqual(fs.readdirSync(dir), ['flashcards.json']);
  const migrated = openStore(dir).get(); assert.equal(migrated.revision, original.get().revision + 1);
  assert.deepEqual(migrated.propositions.p.cues, [{ id: 'kept', question: 'Kept question', answer: 'Kept answer' }]);
  assert.equal(migrated.propositions.p.learningCueId, null); assert.equal(migrated.propositions.p.version, 2);
  assert.deepEqual(migrated.reviews, [{ id: 'r', propositionId: 'p', cueId: 'gone', rating: 3, at: 123 }]);
  assert.deepEqual(migrated.creationReceipts.map(r => r.requestId), ['create-kept', 'create-gone']);
  assert.deepEqual(openStore(dir).get(), migrated);
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
