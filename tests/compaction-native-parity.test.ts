/** Golden outputs from the verified published pi-coding-agent 1.4.0
 * findCutPoint + estimateTokens helpers, executed in isolation on synthetic
 * message/metadata entries. No coding-agent dependency or private data.
 * Source compaction.js SHA256:
 * f51e78ef1da66b5803fc91e185f07b968f8f989ab9326b7744958416aad3f6f6
 * Update deliberately alongside the documented local port, not automatically.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compactionCutIndex, estimateMessageTokens, newCompactionMarker, KEEP_RECENT_TOKENS, type LhMessage } from "../src/core/index.ts";

let serial = 0;
const user = (chars: number): LhMessage => ({ id: `u${serial++}`, role: "user", content: "u".repeat(chars), timestamp: 1 });
const assistant = (chars: number): LhMessage => ({ id: `a${serial++}`, role: "assistant", content: [{ type: "text", text: "a".repeat(chars) }], timestamp: 1 }) as LhMessage;
const call = (chars: number): LhMessage => ({ ...assistant(chars), content: [{ type: "text", text: "a".repeat(chars) }, { type: "toolCall", name: "quiz", arguments: {}, id: "c" }] }) as LhMessage;
const result = (chars: number): LhMessage => ({ id: `r${serial++}`, role: "toolResult", content: [{ type: "text", text: "r".repeat(chars) }], toolCallId: "c", toolName: "quiz", isError: false, timestamp: 1 });
const image = (): LhMessage => ({ id: `i${serial++}`, role: "user", content: [{ type: "image", data: "fixture", mimeType: "image/png" }], timestamp: 1 });
const metadata = (): LhMessage => ({ id: `m${serial++}`, role: "custom", customType: "plan-block", content: "invisible".repeat(1000), display: false, details: {}, timestamp: 1 });

test("local cutoff matches published native golden boundaries and estimator values", () => {
	const cases: [string, LhMessage[], number, number, number[]][] = [
		["exact threshold", [user(40), user(40), user(40)], 20, 1, [10, 10, 10]],
		["under budget", [user(4), assistant(4)], 20, 0, [1, 1]],
		["split turn", [user(400), assistant(40), assistant(40)], 15, 1, [100, 10, 10]],
		["completed result boundary", [user(400), call(4), result(400), user(40)], 30, 3, [100, 3, 100, 10]],
		["oversized trailing result", [user(400), user(40), call(4), result(400)], 30, 2, [100, 10, 3, 100]],
		["multiple trailing results", [user(400), call(4), result(200), result(200)], 30, 1, [100, 3, 50, 50]],
		["image allowance", [user(400), image(), user(40)], 1000, 1, [100, 1200, 10]],
		["empty trailing text", [user(400), assistant(0), user(0)], 30, 0, [100, 0, 0]],
		["pending call", [user(400), user(400), call(4)], 10, 1, [100, 100, 3]],
	];
	for (const [name, messages, budget, expected, tokens] of cases) {
		assert.equal(compactionCutIndex(messages, budget), expected, name);
		assert.deepEqual(messages.map(estimateMessageTokens), tokens, name);
	}
	assert.equal(compactionCutIndex([user(400), metadata(), assistant(40), metadata(), user(40)], 15), 1, "adjacent invisible metadata stays with the cut");
	assert.equal(KEEP_RECENT_TOKENS, 20_000);
});

test("chained cutoff operates on active retained history, never the previous summary or discarded prefix", () => {
	const old = user(400_000);
	const kept = user(40);
	const marker = newCompactionMarker("summary".repeat(100_000), { firstKeptMessageId: kept.id, tokensBefore: 100_000, at: "fixture" });
	const messages = [old, kept, assistant(40), marker, user(40)];
	assert.equal(compactionCutIndex(messages, 100), 1, "retained tail fits; no progress");
	assert.equal(compactionCutIndex(messages, 15), 2, "old summary does not consume the kept-tail budget");
});

test("opaque signatures remain unmeasured and preserved; system/image allowances match native", () => {
	const signed = { ...assistant(4), content: [{ type: "thinking", thinking: "", thinkingSignature: "opaque".repeat(100_000) }] } as LhMessage;
	assert.equal(estimateMessageTokens(signed), 0);
	assert.equal((signed as { content: { thinkingSignature: string }[] }).content[0]!.thinkingSignature.length, 600_000);
	const system = { role: "system", content: [{ type: "image", data: "fixture", mimeType: "image/png" }], sections: { a: "abcd" }, toolsAdded: [{ name: "fixture" }] };
	assert.equal(estimateMessageTokens(system as never), Math.ceil((4800 + 4 + JSON.stringify(system.toolsAdded).length) / 4));
});
