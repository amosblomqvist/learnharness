'use strict';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport, StreamableHTTPError } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js');

/** Fixed per-write deadline (connection included). Deliberately not a setting. */
const WRITE_TIMEOUT_MS = 15_000;
// Shared memory may still have stored the memory; its id is unknown, so a resend cannot supersede it.
const TIMEOUT_MESSAGE = `No response from shared memory within ${WRITE_TIMEOUT_MS / 1000} seconds. The memory may still have been written; sending again can create a duplicate.`;

/** A classified write failure: unreachable, timeout or rejected (server message verbatim). */
class WriteFailure extends Error {
  constructor(kind, message) { super(message); this.name = 'WriteFailure'; this.kind = kind; }
}

function networkMessage(error) {
  const cause = error?.cause;
  const detail = cause ? (cause.code || cause.message) : '';
  const message = error instanceof Error ? error.message : String(error);
  return detail && !message.includes(detail) ? `${message} (${detail})` : message;
}

// McpError prefixes the server's JSON-RPC message with "MCP error <code>: ".
function serverMessage(error) {
  return error.message.replace(/^MCP error -?\d+: /, '');
}

// StreamableHTTPError prefixes the server's HTTP answer with "Streamable HTTP error: " and the step.
function httpMessage(error) {
  return error.message.replace(/^Streamable HTTP error: /, '').replace(/^Error POSTing to endpoint: /, '');
}

function toolText(result) {
  return (Array.isArray(result?.content) ? result.content : [])
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n');
}

/** One MCP session to the shared-memory server, reused for a batch of writes. */
function createSharedMemoryClient(url) {
  let client = null;

  async function discard() {
    const current = client; client = null;
    if (current) { try { await current.close(); } catch { /* the session is already unusable */ } }
  }

  async function connect(signal) {
    const candidate = new Client({ name: 'learnharness-shared-memory', version: '0.1.0' });
    try {
      await candidate.connect(new StreamableHTTPClientTransport(new URL(url)), { signal });
    } catch (error) {
      try { await candidate.close(); } catch { /* nothing to release */ }
      throw error;
    }
    client = candidate;
  }

  /** Call the write tool once. Resolves with the new memory id or throws a WriteFailure. */
  async function write(args) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error('Shared memory write timed out.')); }, WRITE_TIMEOUT_MS);
    try {
      if (!client) await connect(controller.signal);
      const result = await client.callTool({ name: 'write', arguments: args }, undefined, { signal: controller.signal });
      const text = toolText(result);
      if (result.isError) throw new WriteFailure('rejected', text || 'Shared memory rejected the write.');
      let id;
      try { id = JSON.parse(text)?.id; } catch { id = undefined; }
      if (typeof id !== 'string' || !id) throw new WriteFailure('rejected', `Shared memory returned no memory id: ${text}`);
      return id;
    } catch (error) {
      if (timedOut) { await discard(); throw new WriteFailure('timeout', TIMEOUT_MESSAGE); }
      if (error instanceof WriteFailure) throw error;
      await discard();
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) throw new WriteFailure('timeout', TIMEOUT_MESSAGE);
      if (error instanceof McpError && error.code !== ErrorCode.ConnectionClosed) throw new WriteFailure('rejected', serverMessage(error));
      if (error instanceof StreamableHTTPError && Number.isInteger(error.code) && error.code >= 100) throw new WriteFailure('rejected', httpMessage(error));
      throw new WriteFailure('unreachable', `Could not connect to shared memory at ${url}: ${networkMessage(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return { write, close: discard };
}

module.exports = { createSharedMemoryClient, WriteFailure, WRITE_TIMEOUT_MS };
