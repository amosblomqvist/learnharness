/**
 * The BIRTH STAMP (per-session models, owner ruling 2026-09-28): every
 * session owns its model + thinking level from birth — POST /api/chats
 * stamps the newborn chat verbatim from the settings record's STRONG
 * slot, the new-session default. From then on the strong slot never
 * reaches the session again (in-session picks write the session's own
 * record; resolveConversationSpec prefers chat.settings.model).
 *
 * This pin drives the actual route handler (framework-free
 * Request/Response) under an isolated LH_DATA_DIR — the seam must be set
 * before the first import that transitively loads config.ts, so every
 * app-module import is dynamic (the prompt-overrides discipline).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-birth-stamp-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { POST } = await import("../app/api/chats/route.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { chatStore } = await import("../src/store/chats.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function post(): Promise<Response> {
	return POST(new Request("http://test/api/chats", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title: "teach me the chain rule" }),
	}));
}

describe("POST /api/chats — the birth stamp", () => {
	it("stamps the newborn verbatim from the strong slot (model + thinking level)", async () => {
		writeSettings({
			version: 1,
			models: {
				strong: {
					model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
					thinkingLevel: "low",
				},
			},
		});
		const res = await post();
		assert.equal(res.status, 200);
		const { id } = (await res.json()) as { id: string };
		const record = chatStore.getChat(id);
		assert.ok(record);
		assert.deepEqual(record.settings, {
			model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
			thinkingLevel: "low",
		});
	});

	it("no strong slot configured (fresh BYOK boot) → NO stamp; the turn gate refuses downstream", async () => {
		fs.rmSync(path.join(TMP_DATA, "settings.json"), { force: true });
		assert.equal(readSettings(), null);
		const res = await post();
		assert.equal(res.status, 200);
		const { id } = (await res.json()) as { id: string };
		const record = chatStore.getChat(id);
		assert.ok(record);
		assert.equal(record.settings, undefined, "nothing stamped — nothing to lie about");
	});

	it("an unset thinking level rides as-is — the session's level resolves (strong's, then the model's ladder)", async () => {
		writeSettings({
			version: 1,
			models: { strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } } },
		});
		const res = await post();
		const { id } = (await res.json()) as { id: string };
		const record = chatStore.getChat(id);
		assert.ok(record);
		assert.equal(record.settings?.thinkingLevel, undefined);
		assert.deepEqual(record.settings, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	});

	it("changing the strong slot afterward NEVER touches existing sessions — the stamp is a copy, not a live view", async () => {
		writeSettings({
			version: 1,
			models: { strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "low" } },
		});
		const first = (await (await post()).json()) as { id: string };
		writeSettings({
			version: 1,
			models: { strong: { model: { provider: "openai", id: "gpt-6-luna" }, thinkingLevel: "low" } },
		});
		const second = (await (await post()).json()) as { id: string };
		// The pre-change session keeps its stamp; the post-change session
		// carries the new default. This is the regression pin for the
		// reported bug (2026-09-28): both UIs showed the strong slot while
		// every chat ran a fossil stamp.
		const firstRecord = chatStore.getChat(first.id);
		const secondRecord = chatStore.getChat(second.id);
		assert.ok(firstRecord && secondRecord);
		assert.equal(firstRecord.settings?.model?.id, "z-ai/glm-5.3-flash");
		assert.equal(secondRecord.settings?.model?.id, "gpt-6-luna");
	});
});
