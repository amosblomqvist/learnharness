'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const FORMAT_VERSION = 1;
const RECORD_FILE = 'sent-record.json';
const SETTINGS_FILE = 'settings.json';
// Memories written to shared memory whose sent-record entry could not be saved.
// Kept apart from the sent record so it survives a failure to write that file.
const UNRECORDED_FILE = 'unrecorded.json';
const DEFAULT_SETTINGS = Object.freeze({ url: 'http://127.0.0.1:7820/mcp', scope: 'project:learning' });

// Write to a temporary sibling, flush it, then rename over the target.
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

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`Could not read Shared Memory ${label}: ${error.message}`);
  }
}

function validUrl(value) {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value.trim()); return url.protocol === 'http:' || url.protocol === 'https:'; }
  catch { return false; }
}

function validRecord(entry, id) {
  return entry && typeof entry === 'object' && entry.propositionId === id && typeof entry.name === 'string'
    && typeof entry.memoryId === 'string' && entry.memoryId !== '' && typeof entry.fingerprint === 'string'
    && typeof entry.sentAt === 'string' && typeof entry.retired === 'boolean';
}

/** Sent record, unrecorded memories and settings under the plugin's own data directory. */
function openStore(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const recordFile = path.join(directory, RECORD_FILE);
  const settingsFile = path.join(directory, SETTINGS_FILE);

  const loadRecords = () => {
    const savedRecord = readJson(recordFile, 'sent record');
    if (savedRecord === undefined) return {};
    if (!savedRecord || savedRecord.version !== FORMAT_VERSION || !savedRecord.propositions || typeof savedRecord.propositions !== 'object'
      || Object.entries(savedRecord.propositions).some(([id, entry]) => !validRecord(entry, id))) {
      throw new Error('Unsupported or invalid Shared Memory sent record. No data was changed.');
    }
    return savedRecord.propositions;
  };
  let records = loadRecords();

  const unrecordedFile = path.join(directory, UNRECORDED_FILE);
  const savedUnrecorded = readJson(unrecordedFile, 'unrecorded memories');
  if (savedUnrecorded !== undefined && (!savedUnrecorded || savedUnrecorded.version !== FORMAT_VERSION || !savedUnrecorded.memories
    || typeof savedUnrecorded.memories !== 'object'
    || Object.values(savedUnrecorded.memories).some(entry => !entry || typeof entry.memoryId !== 'string' || !entry.memoryId || typeof entry.writtenAt !== 'string'))) {
    throw new Error('Unsupported or invalid Shared Memory unrecorded memories. No data was changed.');
  }
  // An entry older than the proposition's saved record was already superseded by that record's write.
  const unrecorded = Object.fromEntries(Object.entries(savedUnrecorded?.memories ?? {})
    .filter(([id, entry]) => !(Object.hasOwn(records, id) && records[id].sentAt >= entry.writtenAt)));

  const savedSettings = readJson(settingsFile, 'settings');
  let settings;
  if (savedSettings === undefined) settings = { ...DEFAULT_SETTINGS };
  else {
    if (!savedSettings || savedSettings.version !== FORMAT_VERSION || !validUrl(savedSettings.url) || typeof savedSettings.scope !== 'string' || !savedSettings.scope.trim()) {
      throw new Error('Unsupported or invalid Shared Memory settings. No data was changed.');
    }
    settings = { url: savedSettings.url, scope: savedSettings.scope };
  }

  return {
    record: id => (Object.hasOwn(records, id) ? { ...records[id] } : undefined),
    records: () => Object.values(records).map(entry => ({ ...entry })),
    /** Replace one proposition's entry; memory state changes only after a durable write. */
    saveRecord(entry) {
      // Re-read from disk so another store's writes are not lost (all synchronous).
      const next = { ...loadRecords(),[entry.propositionId]: { ...entry } };
      atomicWrite(recordFile, JSON.stringify({ version: FORMAT_VERSION, propositions: next }));
      records = next;
    },
    /** The memory id written for a proposition but missing from the sent record, if any. */
    unrecorded: id => unrecorded[id]?.memoryId,
    /** Set (memoryId) or clear (undefined) one proposition's unrecorded memory. Throws when the file cannot be written. */
    saveUnrecorded(id, memoryId) {
      if (memoryId === undefined && !Object.hasOwn(unrecorded, id)) return;
      if (memoryId === undefined) delete unrecorded[id];
      else unrecorded[id] = { memoryId, writtenAt: new Date().toISOString() };
      atomicWrite(unrecordedFile, JSON.stringify({ version: FORMAT_VERSION, memories: unrecorded }));
    },
    settings: () => ({ ...settings }),
    saveSettings(next) {
      const value = { url: next.url, scope: next.scope };
      atomicWrite(settingsFile, JSON.stringify({ version: FORMAT_VERSION, ...value }));
      settings = value;
      return { ...settings };
    },
  };
}

module.exports = { openStore, validUrl, DEFAULT_SETTINGS };
