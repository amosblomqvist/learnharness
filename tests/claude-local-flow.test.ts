/**
 * Local Claude route (2026-10-27): one lesson turn end to end through the
 * real chat handler — the probe admits a fake plan login, the chat pins
 * the route, the turn runs on the adapter against the fake Claude Code,
 * the record persists in pi's shape and the usage log stamps the route's
 * provider; a disabled route refuses the turn with the Providers wording.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-local-flow-"));
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
delete process.env.LH_DESKTOP_SERVER; delete process.env.LH_DESKTOP_API_SECRET;
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });

const { setClaudeQueryForTests } = await import("../src/agent/claude-local/sdk.ts");
const { refreshClaudeLocal, invalidateClaudeLocal } = await import("../src/server/claude-local.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { fakeClaude } = await import("./claude-local-fake.ts");
import type { AssistantMessage } from "@earendil-works/pi-ai";

const posix = process.platform !== "win32";
after(() => { setClaudeQueryForTests(undefined); fs.rmSync(directory, { recursive: true, force: true }); });

function fakeBinary(): string {
	const dir = path.join(directory, "bin"); fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "claude");
	fs.writeFileSync(file, '#!/bin/sh\necho "2.1.311 (Claude Code)"\n', { mode: 0o755 });
	return file;
}
function post(chatId: string, text: string): Request {
	return new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, input: { type: "text", text } }) });
}
async function drainTurn(chatId: string, req: Request): Promise<Response> {
	const ack = await handleChatRequest(req);
	if (ack.status !== 200) return ack;
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
	return ack;
}

describe("a Local Claude lesson turn through the chat handler", { skip: !posix }, () => {
	it("runs on the adapter, persists pi-shaped messages, stamps claude-local usage, and refuses when the route is off", async () => {
		const fake = fakeClaude((blocks) => [{ text: `Reply to ${blocks.length - 1} message(s).` }]);
		setClaudeQueryForTests(fake.query);
		writeSettings({ version: 1, claudeLocal: { enabled: true, binaryPath: fakeBinary() } });
		const status = await refreshClaudeLocal({ force: true });
		assert.equal(status.state, "ready", status.error);
		const chat = chatStore.createChat("Local Claude lesson");
		chatStore.saveSettings(chat.id, { model: { provider: "claude-local", id: "claude-haiku-5-5" }, thinkingLevel: "low" });
		const ack = await drainTurn(chat.id, post(chat.id, "Teach me tides."));
		assert.equal(ack.status, 200, await ack.text());
		const record = chatStore.getChat(chat.id)!;
		assert.deepEqual(record.messages.map((m) => m.role), ["user", "assistant"]);
		const reply = record.messages[1] as AssistantMessage;
		assert.equal(reply.provider, "claude-local"); assert.equal(reply.model, "claude-haiku-5-5"); assert.equal(reply.stopReason, "stop");
		assert.deepEqual(reply.content, [{ type: "text", text: "Reply to 1 message(s)." }]);
		assert.equal(record.turns?.length, 1); assert.equal(record.turns?.[0]?.model, "claude-local:claude-haiku-5-5");
		assert.deepEqual(record.turns?.[0]?.steps, [{ inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 5, cacheWrite1hTokens: 0, reasoningTokens: 0 }]);
		// The turn's child: the probe ran first (no prompt), then the lesson turn.
		const lesson = fake.turns.find((turn) => turn.blocks.length > 0)!;
		assert.ok(lesson, "the lesson turn reached the fake");
		assert.equal(lesson.options.model, "claude-haiku-5-5"); assert.equal(lesson.options.effort, "low");
		assert.ok(lesson.blocks[1]?.includes("Teach me tides."));
		assert.ok(String(lesson.options.systemPrompt).includes("mcp__learnharness__"), "the composed teacher prompt plus the prefix note");
		// A second turn re-sends the whole record as blocks (flatten per turn), header + 3 messages.
		await drainTurn(chat.id, post(chat.id, "Go on."));
		const second = fake.turns.filter((turn) => turn.blocks.length > 0)[1]!;
		assert.equal(second.blocks.length, 4);
		assert.equal((chatStore.getChat(chat.id)!.messages[3] as AssistantMessage).content[0] && ((chatStore.getChat(chat.id)!.messages[3] as AssistantMessage).content[0] as { text: string }).text, "Reply to 3 message(s).");
		// Route off: the key gate refuses with the Providers wording, nothing runs.
		writeSettings({ version: 1, claudeLocal: { enabled: false } });
		invalidateClaudeLocal();
		const refused = await handleChatRequest(post(chat.id, "Still there?"));
		assert.equal(refused.status, 503);
		const body = await refused.json();
		assert.equal(body.code, "provider_key_missing"); assert.equal(body.provider, "claude-local"); assert.match(body.error, /Local Claude is not ready — check it in Settings → Providers/);
		assert.equal(chatStore.getChat(chat.id)!.messages.length, 4, "nothing appended");
	});
});
