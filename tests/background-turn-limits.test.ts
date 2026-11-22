import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";
import { runResearcherAgent } from "../src/agent/subagents/researcher.ts";
import { runSubmitAgent } from "../src/agent/subagents/submit-agent.ts";

function scripted(steps: FauxResponseStep[]) {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { faux, engine: { model: faux.getModel(), streamFn: faux.streamSimple } };
}
const toolTurn = (index: number) => fauxAssistantMessage([
	fauxText(`Progress ${index}; not the deliverable.`),
	fauxToolCall("again", {}, { id: `again_${index}` }),
], { stopReason: "toolUse" });
const again = { name: "again", label: "again", description: "Offline continuation", parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "Evidence retained" }], details: null }) };

test("research runs past twelve tool turns and delivers only the natural final answer", async () => {
	const final = "## Summary\nVerified fixture. [Source](https://example.invalid/evidence)\n\n## Gaps\nNone in this fixture.";
	const { faux, engine } = scripted([
		...Array.from({ length: 15 }, (_, index) => fauxAssistantMessage([
			fauxText(`Searching ${index}; this is progress only.`),
			fauxToolCall("web_search", { query: `query_${index}` }, { id: `search_${index}` }),
		], { stopReason: "toolUse" })),
		(context) => {
			assert.ok(context.messages.some(m => m.role === "user" && m.content === "Original research question"));
			assert.equal(context.messages.filter(m => m.role === "toolResult").length, 15);
			assert.match(JSON.stringify(context.messages.at(-1)), /query_14/);
			return fauxAssistantMessage(final);
		},
	]);
	const queries: string[] = []; let usage = 0;
	const brief = await runResearcherAgent("Original research question", { engine,
		search: () => ({ id: "tavily", async search(query) { queries.push(query); return [{ title: "Offline", url: "https://example.invalid/evidence", snippet: `Evidence for ${query}` }]; } }),
		onUsage: () => usage++,
	});
	assert.equal(brief, final);
	assert.equal(faux.state.callCount, 16);
	assert.equal(queries.length, 15);
	assert.equal(usage, 16);
});

for (const maxTurns of [undefined, 2]) test(`shared runner ${maxTurns === undefined ? "has no default cap" : "enforces an explicit cap"}`, async () => {
	const { faux, engine } = scripted([...Array.from({ length: 25 }, (_, index) => toolTurn(index)), fauxAssistantMessage("Completed")]);
	const events: string[] = [];
	const result = await runSubagent([again], { engine, systemPrompt: "Offline", prompt: "Offline", maxTurns,
		onEvent: event => { events.push(event.type); },
	});
	assert.equal(faux.state.callCount, maxTurns ?? 26);
	assert.equal(events.filter(type => type === "agent_end").length, 1);
	assert.equal(events.filter(type => type === "turn_end").length, maxTurns ?? 26);
	assert.equal(result.text, maxTurns === undefined ? "Completed" : "Progress 1; not the deliverable.");
});

for (const role of ["extractor", "auditor"] as const) test(`${role} can correct/explore beyond its former cap and stops on accepted submission`, async () => {
	const attempts = role === "extractor" ? 6 : 18;
	const { faux, engine } = scripted([
		...Array.from({ length: attempts }, (_, index) => role === "extractor"
			? fauxAssistantMessage([fauxToolCall("submit", { value: "reject" }, { id: `bad_${index}` })], { stopReason: "toolUse" })
			: toolTurn(index)),
		fauxAssistantMessage([fauxToolCall("submit", { value: "accepted" }, { id: "good" })], { stopReason: "toolUse" }),
	]);
	let steps = 0;
	const result = await runSubmitAgent({ role, toolName: "submit", toolDescription: "Submit fixture", parameters: Type.Object({ value: Type.String() }),
		fill: value => value as { value: string }, validate: value => value.value === "accepted" ? null : "Correct the result",
		engine, signal: undefined, systemPrompt: "Offline", prompt: "Offline", onStep: () => steps++, neverSubmitted: "Missing submission",
		extraTools: role === "auditor" ? { again } : undefined,
	});
	assert.deepEqual(result, { value: "accepted" });
	assert.equal(faux.state.callCount, attempts + 1, "acceptance needs no follow-up request");
	assert.equal(steps, attempts + 1);
});

test("unbounded shared runs still stop on cancellation and propagate provider failure", async () => {
	const controller = new AbortController();
	const { faux, engine } = scripted([...Array.from({ length: 15 }, (_, index) => toolTurn(index)), fauxAssistantMessage("Must not reach")]);
	let usage = 0;
	await assert.rejects(runSubagent([again], { engine, systemPrompt: "Offline", prompt: "Offline", abortSignal: controller.signal,
		onUsage: () => { if (++usage === 13) controller.abort(); },
	}), { name: "AbortError" });
	assert.equal(faux.state.callCount, 13);
	const failed = scripted([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Offline provider failure" })]);
	await assert.rejects(runResearcherAgent("Offline", { engine: failed.engine }), /Offline provider failure/);
	assert.equal(failed.faux.state.callCount, 1);
});

test("removing the cap does not reinterpret a naturally empty response as successful research text", async () => {
	const { faux, engine } = scripted([fauxAssistantMessage("")]);
	assert.equal(await runResearcherAgent("Offline", { engine }), "");
	assert.equal(faux.state.callCount, 1, "no new retry or finalization policy");
});
