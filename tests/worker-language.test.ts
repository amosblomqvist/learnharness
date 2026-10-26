/**
 * Background workers run on their app-language system prompt: the
 * worker-prompt registry resolves a translation or falls back to English,
 * and a worker run with a language hands that prompt to the engine.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { workerPrompt } from "../src/agent/subagents/worker-prompts.ts";
import { runResearcherAgent } from "../src/agent/subagents/researcher.ts";

/** A faux engine that records the system prompt of its single call. */
function capturingEngine() {
	const seen: { system?: string } = {};
	const faux = createFauxCore({});
	faux.setResponses([(context) => {
		const system = context.messages.find((m) => m.role === "system");
		seen.system = system?.role === "system" ? String(system.content) : undefined;
		return fauxAssistantMessage([fauxText("brief")]);
	}]);
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, seen };
}

describe("worker prompts", () => {
	it("English returns the English source; a language without the key falls back to it", () => {
		assert.equal(workerPrompt("researcher", "EN SOURCE", "en"), "EN SOURCE");
		assert.notEqual(workerPrompt("researcher", "EN SOURCE", "es"), "EN SOURCE");
	});

	it("the researcher runs on its Spanish prompt when the language is es", async () => {
		const es = capturingEngine();
		await runResearcherAgent("¿Qué es una derivada?", { engine: es.engine, language: "es" });
		assert.match(es.seen.system ?? "", /español/i);

		const en = capturingEngine();
		await runResearcherAgent("What is a derivative?", { engine: en.engine });
		assert.match(en.seen.system ?? "", /^You are a research specialist/);
	});
});
