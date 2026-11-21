// Opt-in live check: consumes a small amount of Google subscription quota.
// Run: npx tsx scripts/smoke-antigravity.ts
import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { ANTIGRAVITY_MODELS } from "../src/agent/antigravity/provider.ts";
import { streamAntigravity } from "../src/agent/antigravity/stream.ts";

let called = false;
const agent = new Agent({ initialState: {
	model: ANTIGRAVITY_MODELS[2]!,
	systemPrompt: "Integration check. You must use the verify harness tool with answer 2 before replying. After receiving its result reply exactly VERIFIED.",
	tools: [{ name: "verify", label: "Verify", description: "Verify an answer", parameters: Type.Object({ answer: Type.Number() }),
		execute: async (_id, args) => {
			assert.equal((args as { answer: number }).answer, 2);
			called = true;
			return { content: [{ type: "text", text: "Answer verified" }], details: {} };
		},
	}],
}, streamFn: streamAntigravity });
await agent.prompt("What is 1+1? Use the verify harness tool.");
const last = agent.state.messages.at(-1);
assert.ok(last?.role === "assistant");
assert.notEqual(last.stopReason, "error", last.errorMessage);
if (!called) console.error(JSON.stringify(agent.state.messages, null, 2));
assert.equal(called, true, "The model must call the harness tool");
assert.ok(JSON.stringify(agent.state.messages.at(-1)).includes("VERIFIED"));
console.log("Antigravity live smoke passed: Google sign-in → harness tool → tool-result replay → final response.");
