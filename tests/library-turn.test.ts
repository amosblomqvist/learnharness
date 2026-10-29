/**
 * COURSE LIBRARY — turn composition pin (course library wave, 2026-10-29):
 * a chat WITH attachments waits for summaries, then builds its agent with
 * the COURSE MATERIALS block in the system prompt and the library tools in
 * the registry; a chat without attachments gets neither. Driven through
 * the real handleChatInput on a faux engine, isolated LH_DATA_DIR.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-library-turn-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { sofficeOverride } = await import("../src/agent/library/libreoffice.ts");
sofficeOverride.current = null;
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const server = await import("../src/server/library.ts");
const { summaryWriterOverride } = await import("../src/server/library-agent.ts");
const { stores } = await import("../src/server/stores.ts");
type BuildOpts = Parameters<typeof createTeacherAgent>[1] & { teaching: boolean };

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const PDF_FIXTURE = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf")));

function configuredChat(title: string) {
	const chat = stores.chatStore.createChat(title);
	stores.chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return chat;
}

async function runTurn(chatId: string): Promise<{ opts: BuildOpts; systemPrompt: string; tools: string[] }> {
	let captured: BuildOpts | undefined;
	let systemPrompt = "";
	let tools: string[] = [];
	const faux = createFauxCore({});
	faux.setResponses([
		(context) => {
			// Provider-facing contexts fold the prompt and tool declarations
			// into the transcript — search the whole serialized context.
			systemPrompt = JSON.stringify(context);
			tools = [...systemPrompt.matchAll(/"name":"(library_[a-z]+)"/g)].map((m) => m[1]!);
			return fauxAssistantMessage([fauxText("Let's start.")]);
		},
	]);
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const res = await handleChatInput(chatId, { type: "text", text: "help me prep for the quiz" } as never, (opts) => {
		captured = opts;
		return createTeacherAgent(undefined, { ...opts, engine, messages: opts.messages });
	});
	assert.equal(res.status, 200, await res.clone().text());
	// The POST only acknowledges — the turn runs as a background object;
	// drain its wire so the faux model call (and persist) has happened.
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
	assert.ok(captured, `the agent was built (status ${res.status})`);
	return { opts: captured!, systemPrompt, tools };
}

describe("turn composition with attachments", () => {
	it("waits for summaries, then carries the manifest and library tools", async () => {
		const unit = stores.libraryStore.createFolder(null, "Unit 1");
		const up = server.uploadLibraryFile(unit.id, "quiz1.pdf", PDF_FIXTURE);
		assert.ok(up.ok);
		stores.libraryStore.updateItem(up.item.id, { tag: "quiz" });
		const chat = configuredChat("With materials");
		server.setChatAttachments(chat.id, [unit.id]);
		let summarized = 0;
		summaryWriterOverride.current = async (file) => {
			summarized++;
			return { text: `Quiz with 3 questions on ${file.name}.`, model: "faux:model", steps: [] };
		};

		const { opts, systemPrompt, tools } = await runTurn(chat.id);
		assert.equal(summarized, 1, "the summary was written before the turn composed");
		assert.match(opts.materials ?? "", /\[Quiz\] Unit 1\/quiz1\.pdf/);
		assert.match(opts.materials ?? "", /Summary: Quiz with 3 questions/);
		assert.ok(opts.libraryTools && "library_read" in opts.libraryTools && "library_brief" in opts.libraryTools);
		assert.match(systemPrompt, /# COURSE MATERIALS/);
		for (const name of ["library_ls", "library_read", "library_search", "library_view", "library_brief"]) {
			assert.ok(tools.includes(name), `${name} reaches the model`);
		}
		summaryWriterOverride.current = undefined;
	});

	it("a chat without attachments gets no block and no library tools", async () => {
		const chat = configuredChat("Bare");
		const { opts, systemPrompt, tools } = await runTurn(chat.id);
		assert.equal(opts.materials, undefined);
		assert.equal(opts.libraryTools, undefined);
		assert.doesNotMatch(systemPrompt, /# COURSE MATERIALS \(attached/);
		assert.equal(tools.some((t) => t.startsWith("library_")), false);
	});
});
