/**
 * Stand-in MCP server for tests (src/agent/tools/mcp.ts). Speaks MCP over
 * stdio with a fixed tool set:
 *   echo {text}   one text block, "echo: <text>"
 *   two_texts     two text blocks, "first" and "second"
 *   fail          an isError result whose text is "boom"
 *   image         one image block and no text
 *   audio         a text block and an audio block
 * FAKE_MCP_PID_FILE, when set, receives this process's pid at startup.
 * FAKE_MCP_PAGE_SIZE, when set, pages tools/list that many tools at a time.
 */
import { writeFileSync } from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

if (process.env.FAKE_MCP_PID_FILE) writeFileSync(process.env.FAKE_MCP_PID_FILE, String(process.pid));

const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const NO_INPUT = { type: "object", properties: {} };

const TOOLS = [
	{
		name: "echo",
		description: "Echo the given text",
		inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	},
	{ name: "two_texts", description: "Two text blocks", inputSchema: NO_INPUT },
	{ name: "fail", description: "Always fails", inputSchema: NO_INPUT },
	{ name: "image", description: "An image and nothing else", inputSchema: NO_INPUT },
	{ name: "audio", description: "A text block and an audio block", inputSchema: NO_INPUT },
];

const server = new Server({ name: "fake-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, (request) => {
	const pageSize = Number(process.env.FAKE_MCP_PAGE_SIZE) || TOOLS.length;
	const start = Number(request.params?.cursor ?? 0);
	const end = start + pageSize;
	return { tools: TOOLS.slice(start, end), ...(end < TOOLS.length ? { nextCursor: String(end) } : {}) };
});

server.setRequestHandler(CallToolRequestSchema, (request) => {
	const { name, arguments: args = {} } = request.params;
	switch (name) {
		case "echo":
			return { content: [{ type: "text", text: `echo: ${args.text}` }] };
		case "two_texts":
			return { content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] };
		case "fail":
			return { content: [{ type: "text", text: "boom" }], isError: true };
		case "image":
			return { content: [{ type: "image", data: PIXEL_PNG, mimeType: "image/png" }] };
		case "audio":
			return { content: [{ type: "text", text: "listen" }, { type: "audio", data: "AAAA", mimeType: "audio/wav" }] };
		default:
			throw new McpError(ErrorCode.InvalidParams, `unknown tool ${name}`);
	}
});

await server.connect(new StdioServerTransport());
