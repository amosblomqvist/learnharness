import assert from "node:assert/strict";
import test from "node:test";
import { convertMessagesToContents } from "../electron/antigravity-provider.cjs";

/** Copilot (OpenAI Responses) ids: `call_<24 chars>|<base64 with + and />`, often hundreds of chars. */
const copilotId = `call_abcdefghijklmnopqrstuvwx|${"Zm9v+YmFy/".repeat(40)}`;
const CLAUDE_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function history(id: string) {
	return {
		messages: [
			{ role: "user", content: "run it", timestamp: 0 },
			{ role: "assistant", provider: "github-copilot", model: "gpt-5.3-codex", stopReason: "toolUse", timestamp: 1, content: [{ type: "toolCall", id, name: "bash", arguments: { cmd: "ls" } }] },
			{ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 },
		],
	};
}
function ids(contents: any[]) {
	const parts = contents.flatMap((c) => c.parts);
	return { call: parts.find((p) => p.functionCall)?.functionCall.id, result: parts.find((p) => p.functionResponse)?.functionResponse.id };
}

test("Claude via Antigravity gets tool ids it accepts, and a call keeps matching its result", () => {
	const { call, result } = ids(convertMessagesToContents(history(copilotId), { provider: "antigravity", id: "claude-opus-4-6" }));
	assert.match(call, CLAUDE_ID);
	assert.equal(result, call);
});

test("Claude id rewriting is deterministic and does not collide for ids sharing a long prefix", () => {
	const model = { provider: "antigravity", id: "claude-opus-4-6" };
	const a = ids(convertMessagesToContents(history(copilotId), model)).call;
	assert.equal(ids(convertMessagesToContents(history(copilotId), model)).call, a);
	assert.notEqual(ids(convertMessagesToContents(history(`${copilotId}x`), model)).call, a);
});

test("ids that already satisfy Claude's pattern are untouched", () => {
	const { call, result } = ids(convertMessagesToContents(history("toolu_01ABC-def"), { provider: "antigravity", id: "claude-sonnet-4-6" }));
	assert.equal(call, "toolu_01ABC-def");
	assert.equal(result, "toolu_01ABC-def");
});

test("Gemini keeps the original ids (it accepts them)", () => {
	const { call, result } = ids(convertMessagesToContents(history(copilotId), { provider: "antigravity", id: "gemini-3.8-flash" }));
	assert.equal(call, copilotId);
	assert.equal(result, copilotId);
});

test("Antigravity User-Agent version defaults to 2.29.0 and accepts only an x.y.z override", async () => {
	const { antigravityVersion } = await import("../electron/antigravity-provider.cjs");
	const saved = process.env.LH_ANTIGRAVITY_VERSION;
	try {
		delete process.env.LH_ANTIGRAVITY_VERSION;
		assert.equal(antigravityVersion(), "2.29.0");
		process.env.LH_ANTIGRAVITY_VERSION = "3.1.4";
		assert.equal(antigravityVersion(), "3.1.4");
		process.env.LH_ANTIGRAVITY_VERSION = "1.0\r\nX-Evil: 1";
		assert.equal(antigravityVersion(), "2.29.0");
	} finally {
		if (saved === undefined) delete process.env.LH_ANTIGRAVITY_VERSION; else process.env.LH_ANTIGRAVITY_VERSION = saved;
	}
});
