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
  loadRecords(); // Fail activation early on an unreadable or invalid sent record.

  const unrecordedFile = path.join(directory, UNRECORDED_FILE);
  const validUnrecorded = entry => entry && typeof entry === 'object' && typeof entry.memoryId === 'string' && entry.memoryId !== ''
    && typeof entry.name === 'string' && (entry.previousMemoryId === null || typeof entry.previousMemoryId === 'string');
  const loadUnrecordedFile = () => {
    const saved = readJson(unrecordedFile, 'unrecorded memories');
    if (saved === undefined) return {};
    if (!saved || saved.version !== FORMAT_VERSION || !saved.memories || typeof saved.memories !== 'object'
      || Object.values(saved.memories).some(entry => !validUnrecorded(entry))) {
      throw new Error('Unsupported or invalid Shared Memory unrecorded memories. No data was changed.');
    }
    return saved.memories;
  };
  loadUnrecordedFile();
  // Changes this store could not write to the file: an entry, or null for a cleared one.
  const notWritten = {};
  const loadUnrecorded = records => {
    const merged = { ...loadUnrecordedFile() };
    for (const [id, entry] of Object.entries(notWritten)) { if (entry) merged[id] = entry; else delete merged[id]; }
    // An entry whose proposition's sent record has moved on since it was written was superseded by
    // that record's write (a send passes the unrecorded memory as supersedes), so it is stale.
    return Object.fromEntries(Object.entries(merged).filter(([id, entry]) => (records[id]?.memoryId ?? null) === entry.previousMemoryId));
  };

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
    /**
     * The sent record and the unrecorded memories as they are on disk now, so writes made by
     * an earlier activation of this plugin are seen. Unrecorded memories are memories written to
     * shared memory whose sent-record entry could not be saved: { memoryId, name, previousMemoryId }.
     */
    snapshot() {
      const records = loadRecords();
      return { records: structuredClone(records), unrecorded: structuredClone(loadUnrecorded(records)) };
    },
    /** Replace one proposition's entry; memory state changes only after a durable write. */
    saveRecord(entry) {
      // Re-read from disk so another store's writes are not lost (all synchronous).
      const next = { ...loadRecords(), [entry.propositionId]: { ...entry } };
      atomicWrite(recordFile, JSON.stringify({ version: FORMAT_VERSION, propositions: next }));
    },
    /**
     * Set ({ memoryId, name, previousMemoryId }) or clear (undefined) one proposition's unrecorded
     * memory. Throws when the file cannot be written; this store then still remembers the change.
     */
    saveUnrecorded(id, entry) {
      try {
        const next = { ...loadUnrecordedFile() };
        if (entry) next[id] = { ...entry }; else delete next[id];
        atomicWrite(unrecordedFile, JSON.stringify({ version: FORMAT_VERSION, memories: next }));
        delete notWritten[id];
      } catch (error) {
        notWritten[id] = entry ? { ...entry } : null;
        throw error;
      }
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
