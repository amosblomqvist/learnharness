import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	getDeclaredTools,
	type AssistantMessage,
	type FauxResponseStep,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { SearchProvider } from "../src/core/search.ts";
import { runResearcherAgent } from "../src/agent/subagents/researcher.ts";

const QUESTION = "Verify the stationarity assumption using the gathered primary sources.";
const BRIEF = "## Summary\nStationarity is required. [Source](https://example.com/paper)\n\n## Gaps\nNo additional claims were checked.";

interface RecordedRequest {
	tools: string[];
	transcript: string;
	questionCopies: number;
	model: string;
	reasoning: string | undefined;
}

function scriptedEngine(responses: FauxResponseStep[]) {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(responses);
	const requests: RecordedRequest[] = [];
	const engine: PiEngine = {
		model: faux.getModel(),
		level: "high",
		streamFn: (model, context, options) => {
			requests.push({
				tools: getDeclaredTools(context.messages).map((tool) => tool.name),
				transcript: JSON.stringify(context.messages),
				questionCopies: context.messages.filter((message) =>
					message.role === "user" && JSON.stringify(message.content).includes(QUESTION)).length,
				model: `${model.provider}:${model.id}`,
				reasoning: (options as SimpleStreamOptions | undefined)?.reasoning,
			});
			return faux.streamSimple(model, context, options);
		},
	};
	return { engine, requests };
}

function recordingSearch() {
	const queries: string[] = [];
	const provider: SearchProvider = {
		id: "tavily",
		async search(query) {
			queries.push(query);
			return [{ title: "Primary source", url: "https://example.com/paper", snippet: `evidence:${query}` }];
		},
	};
	return { provider, queries };
}

function searchTurn(): AssistantMessage {
	return fauxAssistantMessage([
		fauxText("I will examine this source."),
		fauxToolCall("web_search", { query: "stationarity" }, { id: "search-1" }),
	], { stopReason: "toolUse" });
}

describe("researcher finalization", () => {
	for (const initial of [
		{ label: "empty", message: fauxAssistantMessage("") },
		{ label: "truncated", message: fauxAssistantMessage("Partial findings", { stopReason: "length" }) },
	]) {
		it(`synthesizes the original evidence once when the research response is ${initial.label}`, async () => {
			const { engine, requests } = scriptedEngine([searchTurn(), initial.message, fauxAssistantMessage(BRIEF)]);
			const search = recordingSearch();
			const usage: Usage[] = [];
			const tools: string[] = [];
			const result = await runResearcherAgent(QUESTION, {
				engine, search: () => search.provider,
				onUsage: (value) => usage.push(value),
				onToolStart: (name) => tools.push(name),
			});
			assert.equal(result, BRIEF);
			assert.equal(requests.length, 3);
			assert.equal(usage.length, 3);
			assert.deepEqual(search.queries, ["stationarity"]);
			assert.deepEqual(tools, ["web_search"]);
			assert.ok(requests[1]!.tools.includes("web_search"));
			const final = requests[2]!;
			assert.deepEqual(final.tools, []);
			assert.equal(final.questionCopies, 1);
			assert.match(final.transcript, /evidence:stationarity/);
			assert.match(final.transcript, /no further tools/);
			assert.equal(final.model, requests[0]!.model);
			assert.equal(final.reasoning, "high");
		});
	}

	it("keeps failed search results so the final brief can report gaps", async () => {
		const gaps = "## Gaps\nSearch is unavailable. No sources were verified.";
		const { engine, requests } = scriptedEngine([searchTurn(), fauxAssistantMessage(""), fauxAssistantMessage(gaps)]);
		assert.equal(await runResearcherAgent(QUESTION, { engine, search: () => null }), gaps);
		assert.equal(requests.length, 3);
		assert.match(requests[2]!.transcript, /no search engine is configured/);
		assert.deepEqual(requests[2]!.tools, []);
	});

	it("rejects truncated text without tool results in a single request", async () => {
		const { engine, requests } = scriptedEngine([fauxAssistantMessage("Partial", { stopReason: "length" })]);
		await assert.rejects(runResearcherAgent(QUESTION, { engine }), /complete final brief/);
		assert.equal(requests.length, 1);
	});

	for (const final of [
		{ label: "blank", message: fauxAssistantMessage("  ") },
		{ label: "truncated", message: fauxAssistantMessage("Partial", { stopReason: "length" }) },
		{ label: "tool-calling", message: searchTurn() },
	]) {
		it(`rejects a ${final.label} closing response without another search or provider request`, async () => {
			const { engine, requests } = scriptedEngine([searchTurn(), fauxAssistantMessage(""), final.message]);
			const search = recordingSearch();
			await assert.rejects(runResearcherAgent(QUESTION, { engine, search: () => search.provider }), /complete final brief/);
			assert.equal(requests.length, 3);
			assert.deepEqual(search.queries, ["stationarity"]);
		});
	}

	for (const phase of ["research", "closing"]) {
		it(`propagates provider errors during ${phase} without retrying`, async () => {
			const responses = [searchTurn()];
			if (phase === "closing") responses.push(fauxAssistantMessage(""));
			responses.push(fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider unavailable" }));
			const { engine, requests } = scriptedEngine(responses);
			await assert.rejects(runResearcherAgent(QUESTION, { engine }), /Provider unavailable/);
			assert.equal(requests.length, phase === "closing" ? 3 : 2);
		});
	}

	it("honors cancellation before the closing request", async () => {
		const controller = new AbortController();
		const { engine, requests } = scriptedEngine([searchTurn(), fauxAssistantMessage("")]);
		let calls = 0;
		await assert.rejects(runResearcherAgent(QUESTION, {
			engine,
			abortSignal: controller.signal,
			onUsage: () => { if (++calls === 2) controller.abort(); },
		}), { name: "AbortError" });
		assert.equal(requests.length, 2);
	});
});
