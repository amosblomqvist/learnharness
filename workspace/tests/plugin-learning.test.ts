import assert from "node:assert/strict";
import { it } from "node:test";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import { createPluginLearningData } from "../src/server/plugin-learning.ts";

it("plugin learning reader preserves native data and provides reads only", () => {
	const record = { id: "chat_a", createdAt: "2026-01-01", updatedAt: "2026-01-01", messages: [{ role: "user", content: "Learner thought", timestamp: 1 }], title: "Source" };
	const nodes = [{ id: "node", name: "Evidence", statement: "Evidence", aliases: [], createdAt: "2026-01-01", provenance: [{ chatId: "chat_a", messageId: "message_a" }] }];
	const sources = [{ id: "source", filePath: "/notes.pdf" }];
	const checkpoints = [{ chatId: "chat_a", foldedAt: "2026-01-01" }];
	const reader = createPluginLearningData({ directory: "/learning", isBusy: () => true, isCompacting: () => false,
		chatStore: { getChat: (id: string) => id === "chat_a" ? record : null, listChats: () => [{ id: "chat_a", kind: "teach" }] } as unknown as ChatStore,
		graphStore: { readNodes: () => nodes, readChains: () => [], readCheckpoints: () => checkpoints, readCoverage: () => [], readSources: () => sources, readPositions: () => ({ node: { x: 1, y: 2 } }) } as unknown as GraphStore,
		readMetadata: (name) => name === "format.json" ? { version: 1 } : { enabled: true },
	});
	assert.equal(reader.directory, "/learning");
	assert.deepEqual(reader.getSession("chat_a"), record);
	assert.equal(reader.getSession("missing"), null);
	assert.deepEqual(reader.listSessions(), [{ id: "chat_a", kind: "teach", busy: true, compacting: false }]);
	assert.deepEqual(reader.readGraphFile("nodes.jsonl"), nodes);
	assert.deepEqual(reader.readGraphFile("sources.json"), sources);
	assert.deepEqual(reader.readGraphFile("sessions.jsonl"), checkpoints);
	assert.deepEqual(reader.readGraphFile("positions.json"), { node: { x: 1, y: 2 } });
	assert.deepEqual(reader.readGraphFile("format.json"), { version: 1 });
	const graph = reader.graph();
	assert.deepEqual(graph.propositions, nodes);
	assert.deepEqual(graph.sessions, { chat_a: "Source" });
	assert.deepEqual(graph.positions, { node: { x: 1, y: 2 } });
	assert.throws(() => reader.getSession("../../auth"), /Invalid/);
	assert.throws(() => reader.readGraphFile("../../auth.json" as never), /Unknown/);
	assert.deepEqual(Object.keys(reader).sort(), ["directory", "getSession", "graph", "listSessions", "readGraphFile"]);
});
