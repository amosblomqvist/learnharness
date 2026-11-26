import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-graph-costs-cache-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { graphCosts } = await import("../src/server/graph.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("graphCosts per-chat extraction cache", () => {
	it("reflects new extraction runs, renames, and deletions without stale cache hits", () => {
		const chat = chatStore.createChat("Physics notes");
		assert.equal(graphCosts().runs.length, 0);

		chatStore.appendExtractionUsage(chat.id, {
			startedAt: 1000,
			at: "2026-01-01T00:00:00.000Z",
			durationMs: 120,
			stages: {
				extractor: { model: "openai:gpt-4o-mini", steps: [] },
				auditor: { model: "openai:gpt-4o-mini", steps: [] },
			},
		});

		const afterAppend = graphCosts();
		assert.equal(afterAppend.runs.length, 1);
		assert.equal(afterAppend.runs[0]?.title, "Physics notes");

		chatStore.renameChat(chat.id, "Quantum Mechanics");
		assert.equal(graphCosts().runs[0]?.title, "Quantum Mechanics");

		assert.equal(chatStore.deleteChat(chat.id), true);
		assert.equal(graphCosts().runs.length, 0);
	});
});
