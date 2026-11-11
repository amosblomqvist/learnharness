/**
 * Researcher deliverable rescue (2026-11-11): a run that spends every turn on
 * tools must still deliver text. Observed in production: the researcher burned
 * 12 turns on web_search/web_fetch ("list every cybersecurity certification …")
 * and returned an empty string, so the job failed with "the researcher produced
 * no text" after paying ~65k input tokens.
 *
 * Scripted engine — no network, no search seam.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { runResearcherAgent } from "../src/agent/subagents/researcher.ts";

function scripted(steps: ReturnType<typeof fauxAssistantMessage>[]) {
	const faux = createFauxCore({ tokenSize: { min: 8, max: 8 } });
	faux.setResponses(steps);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return engine;
}

test("an empty final message triggers one tool-less finalize turn", async () => {
	const engine = scripted([
		// Turn 1: model thinks but writes nothing (the maxTurns-exhausted shape).
		fauxAssistantMessage([], { stopReason: "stop" }),
		fauxAssistantMessage([fauxText("## Summary\nFinal brief delivered without tools.")]),
	]);

	const text = await runResearcherAgent("list every certification", { engine });
	assert.match(text, /Final brief delivered without tools/);
});

test("a normal text answer is returned as-is (no extra call)", async () => {
	const engine = scripted([fauxAssistantMessage([fauxText("## Summary\nDirect answer.")])]);
	const text = await runResearcherAgent("simple question", { engine });
	assert.equal(text, "## Summary\nDirect answer.");
});
