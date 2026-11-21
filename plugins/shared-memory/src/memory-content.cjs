'use strict';
const { createHash } = require('node:crypto');

// Fixed fields of every memory this plugin writes (spec: memory fields).
const MEMORY_KIND = 'semantic';
const MEMORY_PROVENANCE = 'agent_inferred';
const SOURCE_AGENT = 'learnharness';
const BASE_TAG = 'learnharness';
const RETIREMENT_BODY = 'LearnHarness の知識グラフから消えたため廃止した。';

// Same rule as the app's notes label: the file name without its extension.
function noteName(filePath) {
  const base = String(filePath).split(/[\\/]/).pop() || String(filePath);
  return base.replace(/\.[^.]+$/, '') || base;
}

// The calendar date (YYYY-MM-DD) of an ISO timestamp, or null when unreadable.
function dateOf(timestamp) {
  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}

/** Index a graph snapshot once so many propositions can be described cheaply. */
function indexGraph(graph) {
  const propositions = new Map();
  for (const node of graph.propositions) propositions.set(node.id, node);
  const chainsByConclusion = new Map();
  for (const chain of [...graph.chains].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const list = chainsByConclusion.get(chain.conclusion) ?? [];
    list.push(chain);
    chainsByConclusion.set(chain.conclusion, list);
  }
  const clusterLabels = new Map();
  for (const cluster of graph.clusters ?? []) {
    if (typeof cluster.label !== 'string' || !cluster.label.trim()) continue;
    for (const member of cluster.members) if (!clusterLabels.has(member)) clusterLabels.set(member, cluster.label);
  }
  return { graph, propositions, chainsByConclusion, clusterLabels };
}

/** The content of one proposition: everything its memory and fingerprint depend on. */
function describe(index, node) {
  const premises = (index.chainsByConclusion.get(node.id) ?? [])
    .map(chain => chain.premises.map(id => index.propositions.get(id)?.statement).filter(text => typeof text === 'string'))
    .filter(list => list.length > 0);
  const date = dateOf(node.createdAt);
  const sources = [];
  for (const point of node.provenance ?? []) {
    const id = point.chatId;
    let line = null;
    if (Object.hasOwn(index.graph.sessions ?? {}, id)) line = date ? `${index.graph.sessions[id]} (${date})` : index.graph.sessions[id];
    else if (Object.hasOwn(index.graph.fileSources ?? {}, id)) line = noteName(index.graph.fileSources[id]);
    if (line !== null && !sources.includes(line)) sources.push(line);
  }
  const cluster = index.clusterLabels.get(node.id) ?? null;
  return { statement: node.statement, aliases: [...(node.aliases ?? [])], premises, sources, cluster };
}

/** Hash of the statement, aliases, premises, sources and cluster name. */
function fingerprint(content) {
  return createHash('sha256').update(JSON.stringify([content.statement, content.aliases, content.premises, content.sources, content.cluster])).digest('hex');
}

function body(content) {
  const sections = [content.statement];
  if (content.aliases.length) sections.push(`別名: ${content.aliases.join(', ')}`);
  if (content.premises.length) {
    // One bulleted list per chain, separated by a blank line.
    sections.push(`## 前提（この命題を導く推論の連鎖）\n${content.premises.map(list => list.map(text => `- ${text}`).join('\n')).join('\n\n')}`);
  }
  if (content.sources.length) sections.push(`## 出典\n${content.sources.map(line => `- ${line}`).join('\n')}`);
  return sections.join('\n\n');
}

/** The write arguments for a proposition's memory (without scope and supersedes). */
function propositionMemory(node, content) {
  return { title: node.name, content: body(content), tags: content.cluster ? [BASE_TAG, content.cluster] : [BASE_TAG] };
}

/** The write arguments for a retirement memory (without scope and supersedes). */
function retirementMemory(name) {
  return { title: `廃止: ${name}`, content: RETIREMENT_BODY, tags: [BASE_TAG] };
}

/** Complete write-tool arguments. source_path is deliberately never sent. */
function writeArguments(memory, scope, supersedes) {
  return {
    title: memory.title,
    content: memory.content,
    scope,
    kind: MEMORY_KIND,
    provenance: MEMORY_PROVENANCE,
    source_agent: SOURCE_AGENT,
    tags: memory.tags,
    ...(supersedes ? { supersedes } : {}),
  };
}

module.exports = { indexGraph, describe, fingerprint, propositionMemory, retirementMemory, writeArguments };
