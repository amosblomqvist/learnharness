import assert from "node:assert/strict";
import { test } from "node:test";
import { phaseAt3, phaseAt3Lh, phaseTimeline, teachStepIndex } from "../src/core/phases.ts";
import { projectView } from "../src/core/view.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

function call(id: string, name: string, args = {}): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		stopReason: "toolUse",
		timestamp: 1,
	} as LhMessage;
}
function result(id: string, name: string, isError: boolean, details = {}): LhMessage {
	return {
		id: `${id}-result`, role: "toolResult", toolCallId: id, toolName: name,
		content: [{ type: "text", text: isError ? "Invalid nodeId: no plan exists" : "ok" }],
		isError, details, timestamp: 2,
	};
}
const probe = [call("done", "probe_done"), result("done", "probe_done", false, { ok: true })];

for (const name of ["quiz", "explain"]) {
	for (const refusal of ["error", "explicit"]) {
		test(`${name}: ${refusal} refusal never starts teaching, including at the call's historical index`, () => {
			const messages = [...probe, call("bad", name, { nodeId: "missing" }),
				result("bad", name, refusal === "error", { ok: false })];
			assert.equal(phaseAt3Lh(messages), "plan");
			assert.equal(phaseAt3Lh(messages, 2), "plan");
			const parts = [{ type: `tool-${name}`, input: { nodeId: "missing" },
				state: refusal === "error" ? "output-error" : "output-available", output: { ok: false } }];
			const view = [{ parts: [{ type: "tool-probe_done", state: "output-available", output: { ok: true } }] }, { parts }];
			assert.equal(phaseAt3(view), "plan");
			assert.deepEqual(phaseTimeline(view), ["plan", "plan"]);
			assert.equal(teachStepIndex([{ type: "step-start" }, { type: "text" }, { type: "step-start" }, ...parts]), -1);
			if (refusal === "error") assert.equal(phaseAt3(projectView(messages)), "plan");
			const retry = [...messages, call("retry", name, { nodeId: "valid" })];
			assert.equal(phaseAt3Lh(retry), "teach", "a subsequent valid pose starts teaching");
		});
	}
	for (const stopReason of ["error", "aborted"]) {
		test(`${name}: ${stopReason} generation is not delivered teaching`, () => {
			const failed = { ...call("failed", name, { nodeId: "valid" }), stopReason } as LhMessage;
			const messages = [...probe, failed];
			assert.equal(phaseAt3Lh(messages), "plan");
			const view = projectView(messages);
			assert.equal(phaseAt3(view), "plan");
			assert.equal(view.flatMap((m) => m.parts).some((p) => p.type === `tool-${name}`), false);
			const staleAnswer = [...messages, result("failed", name, false)];
			assert.equal(phaseAt3(projectView(staleAnswer)), phaseAt3Lh(staleAnswer));
		});
	}
}
