'use strict';
// A loopback stand-in for the shared-memory MCP server. It speaks real MCP over
// Streamable HTTP (stateless: one SDK server per HTTP request), records every
// write call it receives, and answers as the test's behavior function says:
// success (a new memory id), rejection (a tool error), or a delayed answer.
// httpAnswer can also answer a request with a plain HTTP status and body.
const http = require('node:http');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const WRITE_TOOL = { name: 'write', description: 'Create a new memory.', inputSchema: { type: 'object' } };

async function startFakeSharedMemory() {
  const writes = [];
  const pending = new Set();
  let requests = 0, issued = 0;
  const fake = {
    writes,
    get requests() { return requests; },
    /** (args, index) => undefined | { reject: message } | { delayMs }; may be async to hold a write. */
    behavior: () => undefined,
    /** (JSON-RPC body) => undefined | { status, body }: answer at the HTTP level, before MCP sees the request. */
    httpAnswer: () => undefined,
    url: '',
  };
  const sleep = ms => new Promise(resolve => {
    const timer = setTimeout(() => { pending.delete(entry); resolve(); }, ms);
    const entry = { timer, resolve };
    pending.add(entry);
  });

  function mcpServer() {
    const server = new Server({ name: 'fake-shared-memory', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [WRITE_TOOL] }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      if (request.params.name !== 'write') return { isError: true, content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }] };
      const args = structuredClone(request.params.arguments ?? {});
      const index = writes.length;
      writes.push(args);
      const action = (await fake.behavior(args, index)) ?? {};
      if (action.delayMs) await sleep(action.delayMs);
      if (action.reject) return { isError: true, content: [{ type: 'text', text: action.reject }] };
      const id = `mem-${++issued}`;
      return { content: [{ type: 'text', text: JSON.stringify({ id, path: `memories/${id}.md` }) }] };
    });
    return server;
  }

  const readBody = req => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const httpServer = http.createServer(async (req, res) => {
    requests++;
    try {
      const text = await readBody(req);
      const body = text ? JSON.parse(text) : undefined;
      const answer = fake.httpAnswer(body);
      if (answer) { res.writeHead(answer.status, { 'content-type': 'text/plain' }); res.end(answer.body); return; }
      const server = mcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) { res.writeHead(500); res.end(String(error)); }
    }
  });
  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(0, '127.0.0.1', resolve); });
  fake.url = `http://127.0.0.1:${httpServer.address().port}/mcp`;
  fake.close = () => new Promise(resolve => {
    for (const entry of pending) { clearTimeout(entry.timer); entry.resolve(); }
    pending.clear();
    httpServer.closeAllConnections();
    httpServer.close(() => resolve());
  });
  return fake;
}

/** A loopback URL with nothing listening on it. */
async function unreachableUrl() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return `http://127.0.0.1:${port}/mcp`;
}

module.exports = { startFakeSharedMemory, unreachableUrl };
