/**
 * The document-sourced session's prompt segment (issue #175): the prober
 * and the teacher get a per-session "Session source documents" segment
 * APPENDED to their composed instructions when the record carries
 * sourceDocuments; practice never does, and an ordinary session's prompt
 * is byte-identical to before (nothing appended). Also pins the handler
 * wiring: the record's sourceDocuments ride AgentBuildOptions each turn.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-source-docs-prompt-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { sourceDocumentsSegment } = await import("../src/agent/source-documents.ts");
const teacherAgent = await import("../src/agent/teacher-agent.ts");
const { createPracticeAgent, createProberAgent, createTeacherAgent } = teacherAgent;
type AgentBuildOptions = import("../src/agent/teacher-agent.ts").AgentBuildOptions;
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
import type { PiEngine } from "../src/agent/models.ts";

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const DOCS = [
	{ sourceId: "src_abc123", name: "paper.md", path: "/tmp/lh-data/graph/materials/src_abc123.md" },
	{ sourceId: "src_def456", name: "lecture.pdf", path: "/tmp/lh-data/graph/materials/src_def456.md" },
];

/** The agent's seeded system message (pi: systemPrompt becomes the leading
 *  system message at construction). */
function systemMessageOf(agent: { state: { messages: Array<{ role: string; content: unknown }> } }): string {
	const first = agent.state.messages[0]!;
	assert.equal(first.role, "system");
	return JSON.stringify(first.content);
}

function fauxEngine(): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses([() => fauxAssistantMessage([fauxText("Reply.")])]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

describe("sourceDocumentsSegment", () => {
	it("null without documents — nothing composes for an ordinary session", () => {
		assert.equal(sourceDocumentsSegment(undefined), null);
		assert.equal(sourceDocumentsSegment([]), null);
	});

	it("lists every document's name and staged path with the curriculum contract", () => {
		const segment = sourceDocumentsSegment(DOCS)!;
		assert.match(segment, /## Session source documents/);
		assert.ok(segment.includes("- paper.md — read it at `/tmp/lh-data/graph/materials/src_abc123.md`"));
		assert.ok(segment.includes("- lecture.pdf — read it at `/tmp/lh-data/graph/materials/src_def456.md`"));
		assert.match(segment, /Read the material before anything else/);
		assert.match(segment, /probe/i);
		assert.match(segment, /curriculum/i);
	});
});

describe("composed prompts", () => {
	it("teacher WITH documents: the segment rides after the static doctrine", () => {
		const agent = createTeacherAgent(undefined, { engine: fauxEngine(), sourceDocuments: DOCS, messages: [] });
		const system = systemMessageOf(agent);
		assert.ok(system.includes("Session source documents"));
		assert.ok(system.includes("src_abc123.md"));
		// The static doctrine still leads (the shared learner-files fragment).
		assert.ok(system.includes("Learner files"));
		// Joined like the other segments — the separator precedes the appendix.
		assert.ok(system.includes("---"));
	});

	it("teacher WITHOUT documents: byte-identical shape, no segment", () => {
		const agent = createTeacherAgent(undefined, { engine: fauxEngine(), messages: [] });
		assert.ok(!systemMessageOf(agent).includes("Session source documents"));
	});

	it("prober WITH documents gets the same segment", () => {
		const ctx = { chatId: "chat_probe", chatStore, deliver: () => {}, jobStore, spawn: () => {} };
		const agent = createProberAgent(ctx, { engine: fauxEngine(), sourceDocuments: DOCS, messages: [] });
		const system = systemMessageOf(agent);
		assert.ok(system.includes("Session source documents"));
		assert.ok(system.includes("paper.md"));
	});

	it("practice NEVER gets the segment (it draws from the graph)", () => {
		const ctx = { chatId: "chat_practice", chatStore: { getChat: () => null } };
		const agent = createPracticeAgent(ctx, { engine: fauxEngine(), sourceDocuments: DOCS, messages: [] });
		assert.ok(!systemMessageOf(agent).includes("Session source documents"));
	});
});

describe("handler wiring", () => {
	/** The buildAgent capture: what the handler hands the factory is exactly
	 *  what the composition consumes — the record's documents ride it. */
	it("the record's sourceDocuments ride AgentBuildOptions each turn", async () => {
		const chat = chatStore.createChat("Sourced", undefined, DOCS);
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		const captured: Array<AgentBuildOptions | undefined> = [];
		const ack = await handleChatRequest(
			new Request("http://test/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "Teach me the paper" } }),
			}),
			(opts) => {
				captured.push(opts);
				return createTeacherAgent(undefined, { engine: fauxEngine(), messages: opts.messages });
			},
		);
		assert.equal(ack.status, 200, `expected the ack, got ${ack.status}: ${await ack.text()}`);
		assert.equal(captured.length, 1);
		assert.deepEqual(captured[0]!.sourceDocuments, DOCS);
		// Let the background turn settle so no handle dangles into the next test.
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
});
