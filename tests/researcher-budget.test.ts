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

function researchTurns(interimText = false): AssistantMessage[] {
	return Array.from({ length: 11 }, (_, index) => {
		const call = fauxToolCall("web_search", { query: `query-${index + 1}` }, { id: `search-${index + 1}` });
		const content = interimText && index === 10 ? [fauxText("I still need to examine this source."), call] : [call];
		return fauxAssistantMessage(content, { stopReason: "toolUse" });
	});
}

describe("researcher budget finalization", () => {
	it("returns an early completed brief without another model call", async () => {
		const { engine, requests } = scriptedEngine([
			researchTurns()[0]!,
			fauxAssistantMessage(BRIEF),
			() => { throw new Error("Unexpected extra model call"); },
		]);
		const search = recordingSearch();
		const usage: Usage[] = [];
		const result = await runResearcherAgent(QUESTION, { engine, search: () => search.provider, onUsage: (value) => usage.push(value) });
		assert.equal(result, BRIEF);
		assert.equal(requests.length, 2);
		assert.equal(usage.length, 2);
		assert.deepEqual(search.queries, ["query-1"]);
	});

	for (const interimText of [false, true]) {
		it(`reserves the twelfth call for a tool-free brief after ${interimText ? "text and a tool call" : "tool-only turns"}`, async () => {
			const { engine, requests } = scriptedEngine([...researchTurns(interimText), fauxAssistantMessage(BRIEF)]);
			const search = recordingSearch();
			const usage: Usage[] = [];
			const activity: string[] = [];
			const result = await runResearcherAgent(QUESTION, {
				engine,
				search: () => search.provider,
				onUsage: (value) => usage.push(value),
				onToolStart: (name) => activity.push(name),
			});
			assert.equal(result, BRIEF);
			assert.equal(requests.length, 12, "the final brief stays inside the original call budget");
			assert.equal(usage.length, 12, "the final call is included in spending");
			assert.equal(search.queries.length, 11);
			assert.equal(activity.length, 11);
			assert.ok(requests[0]!.tools.includes("web_search"));
			const final = requests.at(-1)!;
			assert.deepEqual(final.tools, [], "the closing call cannot continue searching");
			assert.equal(final.questionCopies, 1, "the original question is preserved once");
			assert.match(final.transcript, /evidence:query-11/, "the closing call sees the last executed search result");
			assert.equal(final.model, requests[0]!.model);
			assert.equal(final.reasoning, "high");
		});
	}

	for (const initial of [
		{ label: "empty", message: fauxAssistantMessage("") },
		{ label: "truncated", message: fauxAssistantMessage("Partial findings", { stopReason: "length" }) },
	]) {
		it(`finishes a research response that is ${initial.label} with one bounded closing call`, async () => {
			const { engine, requests } = scriptedEngine([initial.message, fauxAssistantMessage(BRIEF)]);
			assert.equal(await runResearcherAgent(QUESTION, { engine }), BRIEF);
			assert.equal(requests.length, 2);
			assert.deepEqual(requests[1]!.tools, []);
		});
	}

	for (const final of [
		{ label: "empty", message: fauxAssistantMessage("") },
		{ label: "truncated", message: fauxAssistantMessage("Unfinished brief", { stopReason: "length" }) },
		{ label: "tool-calling", message: fauxAssistantMessage([fauxText("Interim text"), fauxToolCall("web_search", { query: "one more" })], { stopReason: "toolUse" }) },
	]) {
		it(`rejects a closing response that is ${final.label} without another attempt`, async () => {
			const { engine, requests } = scriptedEngine([...researchTurns(), final.message, fauxAssistantMessage("Unexpected retry")]);
			const search = recordingSearch();
			await assert.rejects(runResearcherAgent(QUESTION, { engine, search: () => search.provider }));
			assert.equal(requests.length, 12);
			assert.equal(search.queries.length, 11, "an undeclared closing tool is never executed");
		});
	}

	it("propagates a provider failure during research without dispatching a closing call", async () => {
		const { engine, requests } = scriptedEngine([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider unavailable" }),
			fauxAssistantMessage("Unexpected retry"),
		]);
		await assert.rejects(runResearcherAgent(QUESTION, { engine }), /Provider unavailable/);
		assert.equal(requests.length, 1);
	});

	it("propagates a provider failure in the closing call without retrying it", async () => {
		const { engine, requests } = scriptedEngine([
			...researchTurns(),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Closing request failed" }),
			fauxAssistantMessage("Unexpected retry"),
		]);
		const search = recordingSearch();
		await assert.rejects(runResearcherAgent(QUESTION, { engine, search: () => search.provider }), /Closing request failed/);
		assert.equal(requests.length, 12);
	});

	it("honors cancellation at the research budget without dispatching the closing request", async () => {
		const controller = new AbortController();
		const { engine, requests } = scriptedEngine([...researchTurns(), fauxAssistantMessage("Unexpected closing request")]);
		const search = recordingSearch();
		let calls = 0;
		await assert.rejects(runResearcherAgent(QUESTION, {
			engine,
			search: () => search.provider,
			abortSignal: controller.signal,
			onUsage: () => {
				calls++;
				if (calls === 11) controller.abort();
			},
		}), { name: "AbortError" });
		assert.equal(requests.length, 11);
	});
});
