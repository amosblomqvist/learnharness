/** Keyless research availability + the injected search port.
 * No network, no shared data files — the jobStore fake below is in-memory.
 * A missing search key is a recoverable tool result, not a dispatch gate.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWebTools } from "../src/agent/tools/web.ts";
import { jobTools } from "../src/agent/tools/jobs.ts";
import { runResearcherAgent } from "../src/agent/subagents/researcher.ts";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { JobStore } from "../src/core/ports.ts";
import type { JobRecord } from "../src/core/contracts.ts";
import type { SearchHit, SearchProvider } from "../src/core/search.ts";

function stubProvider(hits: SearchHit[] = [{ title: "t", url: "https://e.com/", snippet: "s" }]): SearchProvider {
	return {
		id: "tavily",
		async search() {
			return hits;
		},
	};
}

describe("web_search on the injected port (web.ts)", () => {
	it("null provider → the honest unavailability string, never a crash", async () => {
		const { web_search } = createWebTools(() => null);
		assert.ok(web_search, "web_search is still exposed without a provider");
		const out = await web_search!.execute!("c1", { query: "anything" });
		const missing = "web_search is not available: no search engine is configured. " +
			"Set a Tavily or Brave search API key in settings. Report in your brief that web search is unavailable.";
		assert.equal(out.details, missing);
		assert.deepEqual(out.content, [{ type: "text", text: missing }]);
		assert.notEqual(out.isError, true, "missing keys remain ordinary recoverable text, not a native error");
	});

	it("a live provider returns its hits (count defaults to 5)", async () => {
		const seen: Array<{ query: string; count: number }> = [];
		const provider: SearchProvider = {
			id: "tavily",
			async search(query, count) {
				seen.push({ query, count });
				return [{ title: "sigma.js", url: "https://www.sigmajs.org/", snippet: "v3 released" }];
			},
		};
		const { web_search } = createWebTools(() => provider);
		const out = await web_search!.execute!("c1", { query: "sigma.js latest version" });
		assert.deepEqual(seen, [{ query: "sigma.js latest version", count: 5 }]);
		assert.deepEqual(out.details, [{ title: "sigma.js", url: "https://www.sigmajs.org/", snippet: "v3 released" }]);
	});

	it("forwards the tool abort signal to the search provider", async () => {
		const controller = new AbortController();
		let received: AbortSignal | undefined;
		const provider: SearchProvider = {
			id: "tavily",
			async search(_query, _count, signal) {
				received = signal;
				return new Promise((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true }));
			},
		};
		const { web_search } = createWebTools(() => provider);
		const result = web_search!.execute!("signal-call", { query: "q" }, controller.signal);
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		await result;
		assert.ok(received, "provider received a signal");
		assert.equal(received.aborted, true, "tool abort propagated into provider request");
	});

	it("provider errors surface as error strings, never thrown", async () => {
		const provider: SearchProvider = {
			id: "brave",
			async search() {
				throw new Error("Brave search API 429: rate limited");
			},
		};
		const { web_search } = createWebTools(() => provider);
		const out = await web_search!.execute!("c1", { query: "q" });
		assert.match(String(out.details), /web_search failed: Brave search API 429: rate limited/);
	});

	it("the resolution is FRESH per call — a key appearing mid-session takes effect", async () => {
		let provider: SearchProvider | null = null;
		const { web_search } = createWebTools(() => provider);
		const first = await web_search!.execute!("c1", { query: "q" });
		assert.match(String(first.details), /not available/);
		provider = stubProvider();
		const second = await web_search!.execute!("c2", { query: "q" });
		assert.ok(Array.isArray(second.details), "the live provider answered on the very next call");
	});

	it("web_fetch needs no search engine — it stays independent", async () => {
		const { web_fetch } = createWebTools(() => null);
		assert.ok(web_fetch, "web_fetch present with no provider");
		// (Full fetch behavior is out of scope here — no network in tests.)
		const out = await web_fetch!.execute!("c1", { url: "not a url" });
		assert.match(String(out.details), /web_fetch failed: invalid URL/);
	});

	it("web_fetch ACCEPTS a valid http(s) URL — the protocol gate must not reject everything (the colon bug, 2026-10-07)", async () => {
		// URL.protocol is \"https:\" WITH the colon; the colon-less comparison
		// ported from the py harness (urlparse().scheme has none) made the
		// gate throw for every valid URL — the tool never fetched a page in
		// its life (owner-reported via OpenRouter logs). This pin stubs fetch
		// so the happy path runs hermetically: a VALID url must REACH the
		// fetch stage.
		const { web_fetch } = createWebTools(() => null);
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("A plain text page with enough content to matter for the test.", {
				headers: { "content-type": "text/plain" },
			})) as typeof fetch;
		try {
			const ok = await web_fetch!.execute!("c-ok", { url: "https://example.com/page" });
			assert.ok(
				!String(ok.details).includes("invalid URL"),
				"a valid https URL passes the protocol gate and reaches fetch",
			);
			assert.match(String(ok.details), /plain text page/);

			const ftp = await web_fetch!.execute!("c-ftp", { url: "ftp://example.com/file" });
			assert.match(String(ftp.details), /invalid URL/, "non-http(s) schemes still rejected");
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("keyless researcher loop", () => {
	it("sends the exact approved missing-credentials guidance in the researcher system prompt", async () => {
		const approved = "If web_search reports that search is unavailable because credentials are missing, do not retry it with different queries. Use web_fetch when you have source URLs, and continue with any other available sources. If the missing search capability materially limits your work, state the limitation and the missing-key setup needed in your brief. Never invent search results or sources.";
		const faux = createFauxCore({});
		faux.setResponses([(context) => {
			const system = context.messages.find((m) => m.role === "system");
			assert.ok(system && system.role === "system");
			assert.equal(typeof system.content, "string");
			const prompt = system.content as string;
			assert.ok(prompt.split("\n\n").includes(approved), "approved paragraph is passed verbatim");
			assert.match(prompt, /Break the question into 2-4 searchable facets/);
			assert.match(prompt, /## Gaps/);
			assert.ok(system.toolsAdded?.some((t) => t.name === "web_search"));
			assert.ok(system.toolsAdded?.some((t) => t.name === "web_fetch"));
			return fauxAssistantMessage([fauxText("Prompt verified; no model behavior inferred.")]);
		}]);
		assert.equal(await runResearcherAgent("Check the prompt only", {
			engine: { model: faux.getModel(), streamFn: faux.streamSimple },
		}), "Prompt verified; no model behavior inferred.");
	});

	// These scripts prove tool/loop mechanics, not real-model compliance.
	for (const searchFirst of [true, false]) {
		it(searchFirst ? "recovers from missing search keys by fetching a supplied URL" : "fetch-only research needs no search credentials", async () => {
			const url = "https://example.com/supplied-source";
			const brief = `## Summary\nVerified supplied source. [Source](${url})`;
			const steps: FauxResponseStep[] = [];
			const fetchCall = () => fauxAssistantMessage(
				[fauxToolCall("web_fetch", { url }, { id: "fetch1" })], { stopReason: "toolUse" },
			);
			if (searchFirst) {
				steps.push(
					() => {
						return fauxAssistantMessage(
							[fauxToolCall("web_search", { query: "supplied source" }, { id: "search1" })], { stopReason: "toolUse" },
						);
					},
					(context) => {
						const result = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "search1");
						assert.ok(result && result.role === "toolResult");
						assert.equal(result.isError, false, "missing keys do not abort the native loop");
						assert.match(JSON.stringify(result.content), /no search engine is configured/);
						return fetchCall();
					},
				);
			} else steps.push(fetchCall());
			steps.push((context) => {
				const result = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "fetch1");
				assert.ok(result && result.role === "toolResult");
				assert.equal(result.isError, false);
				assert.match(JSON.stringify(result.content), /Synthetic verified source content/);
				return fauxAssistantMessage([fauxText(brief)]);
			});
			const faux = createFauxCore({});
			faux.setResponses(steps);
			const realFetch = globalThis.fetch;
			const fetched: string[] = [];
			globalThis.fetch = (async (input) => {
				fetched.push(String(input));
				assert.equal(String(input), url, "only the supplied URL is fetched");
				return new Response("Synthetic verified source content", { headers: { "content-type": "text/plain" } });
			}) as typeof fetch;
			try {
				assert.equal(await runResearcherAgent(`Verify ${url}`, {
					engine: { model: faux.getModel(), streamFn: faux.streamSimple },
					// No search seam: this is the keyless backstop, not a search stub.
				}), brief);
				assert.deepEqual(fetched, [url]);
			} finally {
				globalThis.fetch = realFetch;
			}
		});
	}
});

/** Minimal in-memory JobStore — registry tests never touch the fs. */
function fakeJobStore(): JobStore {
	const jobs = new Map<string, JobRecord>();
	return {
		createJob(init) {
			const job: JobRecord = {
				id: `job_${jobs.size + 1}`,
				kind: init.kind,
				chatId: init.chatId,
				toolCallId: init.toolCallId,
				status: "running",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				activity: "",
			} as JobRecord;
			jobs.set(job.id, job);
			return job;
		},
		getJob: (id) => jobs.get(id) ?? null,
		updateJob: (id, patch) => {
			const job = jobs.get(id);
			if (!job) return null;
			return Object.assign(job, patch);
		},
		listJobs: () => [...jobs.values()],
		findJobByToolCallId: () => null,
		deleteJobsForChat: () => 0, // the drop tests never delete
	};
}

function fakeCtx(available?: () => boolean) {
	return {
		chatId: "chat-drop-test",
		jobStore: fakeJobStore(),
		spawn: () => {},
		...(available ? { searchAvailable: available } : {}),
	};
}

describe("keyless research dispatch (jobTools)", () => {
	it("searchAvailable: false → research remains in the registry", () => {
		const tools = jobTools(fakeCtx(() => false));
		assert.ok(tools.research, "research can fetch supplied URLs without a search provider");
		assert.ok(tools.demo && tools.visual && tools.pdf, "the search-less server keeps its other sub-agents");
	});

	it("keyless dispatch preserves the async job acknowledgement and spawn contract", async () => {
		const ctx = fakeCtx(() => false);
		const spawned: Array<{ job: JobRecord; input: unknown }> = [];
		const tools = jobTools({ ...ctx, spawn: (job, input) => { spawned.push({ job, input }); } });
		const input = { question: "Verify the supplied URL", context: "https://example.com/source" };
		const out = await tools.research!.execute!("keyless-call", input);
		assert.match(String(out.details), /^Dispatched \(job job_1\)\./);
		assert.match(String(out.details), /fire-and-forget/);
		assert.equal(spawned.length, 1);
		assert.equal(spawned[0]!.job.kind, "research");
		assert.equal(spawned[0]!.job.toolCallId, "keyless-call");
		assert.equal(spawned[0]!.job.status, "running");
		assert.deepEqual(spawned[0]!.input, input);
	});

	it("searchAvailable: true → research present", () => {
		const tools = jobTools(fakeCtx(() => true));
		assert.ok(tools.research, "a keyed server exposes research");
	});

	it("absent seam = available (tests + any wiring without search)", () => {
		const tools = jobTools(fakeCtx());
		assert.ok(tools.research, "the seam is optional — default is honest availability");
	});
});

// Exercise live registry factories too: search status must not override
// the existing per-role/user-toggle policy.

import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";
import type { ChatStore } from "../src/core/ports.ts";

/** A chat-store stub — the registry factories only CLOSE OVER it at build
 *  time (quiz/plan superRefines read it at execute time, never here). */
const fakeChatStore = {
	getChat: () => null,
	saveMessages: () => {},
} as unknown as ChatStore;

const ctxBase = { chatId: "chat-gate-test", chatStore: fakeChatStore };

describe("keyless role registries", () => {
	it("createTeacherTools: unavailable keeps research on the live wiring path", () => {
		const tools = createTeacherTools({
			...ctxBase,
			jobStore: fakeJobStore(),
			spawn: () => {},
			searchAvailable: () => false,
		});
		assert.ok(tools.research, "no search key is required to dispatch research");
		assert.ok(tools.demo && tools.visual && tools.pdf, "the other job tools survive");
	});

	it("createTeacherTools: available keeps research", () => {
		const tools = createTeacherTools({
			...ctxBase,
			jobStore: fakeJobStore(),
			spawn: () => {},
			searchAvailable: () => true,
		});
		assert.ok(tools.research, "a keyed server exposes research through the teacher");
	});

	it("createProberTools: research + pdf remain phase-omnipresent with or without search keys", () => {
		const on = createProberTools({
			...ctxBase,
			deliver: () => {},
			jobStore: fakeJobStore(),
			spawn: () => {},
			searchAvailable: () => true,
		});
		assert.ok(on.research && on.pdf, "the owner ruling: research + pdf in the probe phase");

		const off = createProberTools({
			...ctxBase,
			deliver: () => {},
			jobStore: fakeJobStore(),
			spawn: () => {},
			searchAvailable: () => false,
		});
		assert.ok(off.research, "keyless research dispatch is available in the prober too");
		assert.ok(off.pdf && off.probe_done, "pdf is keyless — it survives; probe_done always-on");
	});

	it("createProberTools: the user toggle still drops research without search keys", () => {
		const tools = createProberTools(
			{ ...ctxBase, deliver: () => {}, jobStore: fakeJobStore(), spawn: () => {}, searchAvailable: () => false },
			{ research: false },
		);
		assert.equal("research" in tools, false, "toggle-filtered like the teacher side");
		assert.ok(tools.pdf, "pdf unaffected by a research toggle");
	});

	it("createTeacherTools: the user toggle still drops research without search keys", () => {
		const tools = createTeacherTools(
			{ ...ctxBase, jobStore: fakeJobStore(), spawn: () => {}, searchAvailable: () => false },
			{ research: false },
		);
		assert.equal("research" in tools, false);
		assert.ok(tools.pdf && tools.demo && tools.visual);
	});
});
