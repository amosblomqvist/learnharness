import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pricing-transport-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "empty-auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });
const { chatStore } = await import("../src/store/chats.ts");
const { GET } = await import("../app/api/chats/[id]/route.ts");
const { sessionCost } = await import("../src/server/pricing.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("chat GET supplies derived Pi costs without persisting dollars or changing native history", async () => {
	const record = chatStore.createChat("price projection fixture");
	chatStore.saveMessages(record.id, [{ id: "fixture-input", role: "user", content: "synthetic", timestamp: 1 }]);
	const step = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 70_000, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 500 };
	for (const [id, model] of [["api", "openrouter:openai/gpt-6.1-sol"], ["plan", "chatgpt:fixture"], ["unknown", "missing:fixture"]]) {
		chatStore.appendTurnUsage(record.id, { id: id!, model: model!, messageId: "fixture-input", at: "fixture", steps: [step] });
	}
	const file = path.join(scratch, "chats", `${record.id}.json`);
	const before = fs.readFileSync(file, "utf8");
	const response = await GET(new Request(`http://localhost/api/chats/${record.id}`), { params: Promise.resolve({ id: record.id }) });
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(body.messages, chatStore.getChat(record.id)!.messages);
	assert.deepEqual(body.pricing, sessionCost(chatStore.getChat(record.id)!));
	assert.equal(body.pricing.cost, 0.037);
	assert.equal(body.pricing.subscription, 1);
	assert.equal(body.pricing.unpriced, 1);
	assert.deepEqual(body.pricing.turnCosts, { api: 0.037, plan: null, unknown: null });
	assert.equal(fs.readFileSync(file, "utf8"), before, "read-time estimates must never rewrite the usage log");
});
