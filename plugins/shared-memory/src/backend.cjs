'use strict';
const { openStore, validUrl } = require('./sent-record.cjs');
const { indexGraph, describe, fingerprint, propositionMemory, retirementMemory, writeArguments } = require('./memory-content.cjs');
const { createSharedMemoryClient, WriteFailure } = require('./shared-memory-client.cjs');

// Proposition states relative to shared memory. Only the first three are listed
// (and sendable); sent and retired propositions have nothing left to do.
const UNSENT = 'unsent', CHANGED = 'changed', REMOVED = 'removed', SENT = 'sent', RETIRED = 'retired';
const ACTIONABLE = new Set([UNSENT, CHANGED, REMOVED]);

const fail = message => { throw new Error(message); };

function objectInput(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) fail('Invalid operation input.');
  return input;
}

function activate(ctx) {
  if (typeof ctx.learning?.graph !== 'function' || typeof ctx.handle !== 'function' || typeof ctx.events?.emit !== 'function') {
    fail('This app build does not provide the plugin capabilities required by Shared Memory.');
  }
  // Activation only opens local plugin data; shared memory is contacted on send.
  const store = openStore(ctx.dataDirectory);
  const failures = new Map();
  let run = null, disposed = false;
  const active = () => !disposed && !ctx.signal?.aborted;
  const notify = (topic, data) => { if (active()) ctx.events.emit(topic, data); };
  const progress = () => (run ? { sending: true, total: run.total, done: run.done, stopping: run.stopRequested } : { sending: false });

  function graphNow() {
    const graph = ctx.learning.graph();
    if (!graph || !Array.isArray(graph.propositions) || !Array.isArray(graph.chains)) fail('Could not read the knowledge graph.');
    return graph;
  }

  /** Every proposition known to the graph or the sent record, with its current state. */
  function classify(graph) {
    const index = indexGraph(graph), entries = new Map();
    for (const node of graph.propositions) {
      const record = store.record(node.id), content = describe(index, node), print = fingerprint(content);
      const state = !record || record.retired ? UNSENT : record.fingerprint === print ? SENT : CHANGED;
      entries.set(node.id, { id: node.id, name: node.name, statement: node.statement, state, node, content, fingerprint: print, record });
    }
    for (const record of store.records()) {
      if (entries.has(record.propositionId)) continue;
      entries.set(record.propositionId, { id: record.propositionId, name: record.name, statement: null, state: record.retired ? RETIRED : REMOVED, record });
    }
    return entries;
  }

  function list() {
    const items = [];
    for (const entry of classify(graphNow()).values()) {
      if (!ACTIONABLE.has(entry.state)) continue;
      const reason = failures.get(entry.id);
      items.push({ id: entry.id, name: entry.name, statement: entry.statement, state: entry.state, ...(reason ? { reason: { ...reason } } : {}) });
    }
    return { items, progress: progress() };
  }

  // The memory one actionable proposition becomes, and the sent-record entry
  // that replaces its old one once the write has succeeded.
  function plan(entry, scope) {
    const previous = entry.record?.memoryId;
    if (entry.state === REMOVED) {
      return { args: writeArguments(retirementMemory(entry.record.name), scope, previous), next: memoryId => ({ ...entry.record, memoryId, sentAt: new Date().toISOString(), retired: true }) };
    }
    return {
      args: writeArguments(propositionMemory(entry.node, entry.content), scope, previous),
      next: memoryId => ({ propositionId: entry.id, name: entry.name, memoryId, fingerprint: entry.fingerprint, sentAt: new Date().toISOString(), retired: false }),
    };
  }

  async function send(input) {
    const { ids } = objectInput(input);
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id)) fail('Select at least one proposition.');
    if (run) fail('Shared Memory is already sending.');
    const targets = [...new Set(ids)];
    const { url, scope } = store.settings();
    const entries = classify(graphNow());
    run = { total: targets.length, done: 0, stopRequested: false };
    const results = [];
    const client = createSharedMemoryClient(url);
    notify('progress', progress());
    try {
      for (const id of targets) {
        // Stopping never cancels the write in flight; it only keeps later turns from starting.
        if (run.stopRequested || !active()) { results.push({ id, outcome: 'not-sent' }); continue; }
        const entry = entries.get(id);
        if (!entry || !ACTIONABLE.has(entry.state)) {
          results.push({ id, outcome: 'skipped', state: entry?.state ?? null });
        } else {
          const { args, next } = plan(entry, scope);
          // A memory written but not recorded locally must be replaced, not duplicated.
          const lost = store.unrecorded(id);
          if (lost) args.supersedes = lost;
          let memoryId;
          try {
            memoryId = await client.write(args);
          } catch (error) {
            if (!(error instanceof WriteFailure)) throw error;
            const reason = { kind: error.kind, message: error.message };
            failures.set(id, reason);
            results.push({ id, outcome: 'failed', state: entry.state, reason });
            run.done++;
            notify('progress', progress());
            continue;
          }
          try {
            store.saveRecord(next(memoryId));
            // A stale entry left by a failed clear is dropped on the next load (older than the record).
            try { store.saveUnrecorded(id, undefined); } catch { /* see above */ }
            failures.delete(id);
            results.push({ id, outcome: 'written', state: entry.state, memoryId });
          } catch (error) {
            let message = error.message;
            // The store keeps the id in memory even when its own file cannot be written.
            try { store.saveUnrecorded(id, memoryId); } catch { message += ' The written memory is remembered only until Shared Memory restarts.'; }
            const reason = { kind: 'unrecorded', message };
            failures.set(id, reason);
            results.push({ id, outcome: 'failed', state: entry.state, reason, memoryId });
            run.stopRequested = true;
          }
        }
        run.done++;
        notify('progress', progress());
      }
      return { stopped: run.stopRequested, total: run.total, done: run.done, results };
    } finally {
      const summary = { stopped: run.stopRequested, total: run.total, done: run.done };
      run = null;
      await client.close();
      notify('finished', summary);
    }
  }

  function stop() {
    if (!run) return { stopping: false };
    run.stopRequested = true;
    notify('progress', progress());
    return { stopping: true };
  }

  function setSettings(input) {
    const patch = objectInput(input);
    for (const key of Object.keys(patch)) if (key !== 'url' && key !== 'scope') fail(`Unsupported setting: ${key}`);
    if (!Object.keys(patch).length) fail('Provide a URL or a scope.');
    const next = store.settings();
    if (patch.url !== undefined) {
      if (!validUrl(patch.url)) fail('The URL must be an http or https URL.');
      next.url = patch.url.trim();
    }
    if (patch.scope !== undefined) {
      if (typeof patch.scope !== 'string' || !patch.scope.trim()) fail('The scope must not be blank.');
      next.scope = patch.scope.trim();
    }
    return store.saveSettings(next);
  }

  ctx.handle('list', input => { objectInput(input); return list(); });
  ctx.handle('send', send);
  ctx.handle('stop', input => { objectInput(input); return stop(); });
  ctx.handle('get-settings', input => { objectInput(input); return store.settings(); });
  ctx.handle('set-settings', setSettings);
  ctx.cleanup(() => { disposed = true; if (run) run.stopRequested = true; });
}

module.exports = { activate };
