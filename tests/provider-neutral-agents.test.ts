/**
 * Raw-stream credential regression: the Sept 26 Agent getApiKey-hook tests
 * do not exercise these two hand-rolled loops. All credentials here are
 * synthetic; fetch is CLOSED (never delegates), including Google's global
 * fetch-only adapter. The transport cases test SDK serialization, not accounts.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
	createFauxCore, createModels, fauxAssistantMessage, fauxText, fauxToolCall,
	type JsonObject, type TranscriptContext, type Usage,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { APP_IDENTITY, piEngineForSpec, type PiEngine } from "../src/agent/models.ts";
import { antigravityProvider } from "../electron/antigravity-provider.cjs";
import { runVisualMaker } from "../src/agent/subagents/visual-maker.ts";
import { runPdfReaderAgent } from "../src/agent/subagents/pdf-reader.ts";
import type { HeadlessApi } from "../src/agent/subagents/headless.ts";
import { AUTH_PROVIDER_KEYS } from "../src/core/auth-keys.ts";
import { providerEventsDir } from "../src/agent/provider-events.ts";

const OR_KEY = "dummy-openrouter-MUST-NOT-REACH-other-endpoints";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><rect width="20" height="20" fill="white"/></svg>';
const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==", "base64");
const FINAL = "Verified offline output (p. 1). Pages consulted: 1";
const LOOPS = ["visual", "pdf"] as const;
type Loop = typeof LOOPS[number];
type Call = { name: string; args: JsonObject };

interface Transport {
	provider: string; id: string; envVar: string; api: string;
	origin: string; path: string; authHeader: string;
}
const TRANSPORTS: Transport[] = [
	{ provider: "opencode-go", id: "claude-haiku-5-5", envVar: "OPENCODE_API_KEY", api: "anthropic-messages", origin: "https://opencode.ai", path: "/inference/go/v1/messages", authHeader: "x-api-key" },
	{ provider: "opencode-go", id: "gemini-4-argon-contributor", envVar: "OPENCODE_API_KEY", api: "google-generative-ai", origin: "https://opencode.ai", path: "/inference/go/v1/models/gemini-4-argon-contributor:streamGenerateContent", authHeader: "x-goog-api-key" },
	{ provider: "opencode-go", id: "glm-5.3", envVar: "OPENCODE_API_KEY", api: "openai-completions", origin: "https://opencode.ai", path: "/inference/go/v1/chat/completions", authHeader: "authorization" },
	{ provider: "opencode-go", id: "gpt-6-luna", envVar: "OPENCODE_API_KEY", api: "openai-responses", origin: "https://opencode.ai", path: "/inference/go/v1/responses", authHeader: "authorization" },
	{ provider: "openrouter", id: "openai/gpt-4o-mini", envVar: "OPENROUTER_API_KEY", api: "openai-completions", origin: "https://openrouter.ai", path: "/api/v1/chat/completions", authHeader: "authorization" },
	{ provider: "openai", id: "gpt-4o-mini", envVar: "OPENAI_API_KEY", api: "openai-responses", origin: "https://api.openai.com", path: "/v1/responses", authHeader: "authorization" },
	{ provider: "anthropic", id: "claude-haiku-4-5", envVar: "ANTHROPIC_API_KEY", api: "anthropic-messages", origin: "https://api.anthropic.com", path: "/v1/messages", authHeader: "x-api-key" },
	{ provider: "google", id: "gemini-2.5-flash", envVar: "GEMINI_API_KEY", api: "google-generative-ai", origin: "https://generativelanguage.googleapis.com", path: "/v1beta/models/gemini-2.5-flash:streamGenerateContent", authHeader: "x-goog-api-key" },
];

// Replacing rather than extending env also isolates secondary tokens (including
// ANTHROPIC_AUTH_TOKEN/OAUTH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN), SDK base-URL
// overrides, cloud credentials, profiles, and LH_IGNORE_ENV_KEYS. No .env loads.
async function isolated<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
	const previous = process.env;
	const fetch = globalThis.fetch;
	const previousEventsDir = providerEventsDir.current;
	const eventsDir = mkdtempSync(path.join(tmpdir(), "lh-provider-neutral-"));
	providerEventsDir.current = eventsDir;
	globalThis.fetch = async () => { throw new Error("CLOSED: unexpected fetch"); };
	process.env = { NODE_ENV: "test", HOME: "/nonexistent/provider-neutral-test-home", ...env };
	try {
		return await run();
	} finally {
		process.env = previous;
		globalThis.fetch = fetch;
		providerEventsDir.current = previousEventsDir;
		rmSync(eventsDir, { recursive: true, force: true });
	}
}

function callsFor(loop: Loop, round: number): Call[] {
	if (round === 2) return [];
	if (loop === "visual") return round === 0
		? [{ name: "write_svg", args: { svg: SVG } }]
		: [{ name: "render_svg", args: {} }];
	return round === 0
		? [{ name: "pdf_info", args: {} }]
		: [{ name: "pdf_extract", args: { pages: "1" } }, { name: "pdf_render", args: { pages: "1", dpi: 100 } }];
}

function fakeHeadless(renders: string[]): HeadlessApi {
	return {
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => { throw new Error("unexpected demo"); },
		renderSvg: async (svg) => {
			assert.equal(svg, SVG);
			renders.push("svg");
			return PNG;
		},
		renderPdfPages: async (file, pages, opts) => {
			assert.equal(file, FIXTURE);
			assert.deepEqual(pages, [1]);
			assert.equal(opts?.dpi, 100);
			renders.push("pdf:1");
			return [{ page: 1, png: PNG }];
		},
	};
}

async function runLoop(loop: Loop, engine: PiEngine, signal = new AbortController().signal) {
	const renders: string[] = [];
	const activities: string[] = [];
	const usages: Usage[] = [];
	const opts = {
		engine, headless: fakeHeadless(renders), abortSignal: signal,
		onActivity: (line: string) => activities.push(line),
		onUsage: (usage: Usage) => usages.push(usage),
		// Direct recording cases enable the observer into an isolated temp dir.
		chatId: "provider-neutral-offline",
	};
	const result = loop === "visual"
		? await runVisualMaker({ brief: "A white square, no external resources" }, opts)
		: await runPdfReaderAgent({ path: FIXTURE, question: "Read page 1" }, opts);
	return { result, renders, activities, usages };
}

function assertSuccess(loop: Loop, run: Awaited<ReturnType<typeof runLoop>>) {
	if ("svg" in run.result) {
		assert.equal(run.result.svg, SVG, JSON.stringify(run.result));
		assert.equal(run.result.notes, FINAL);
	} else {
		assert.equal(run.result.brief, FINAL);
		assert.equal(run.result.path, FIXTURE);
		assert.deepEqual(run.result.pagesRead, [1]);
		assert.deepEqual(run.result.pagesConsulted, [1]);
	}
	assert.deepEqual(run.renders, [loop === "visual" ? "svg" : "pdf:1"]);
	assert.equal(run.usages.length, 3, "one usage callback per successful stream round");
	assert.ok(run.activities.some((line) => line.startsWith(loop === "visual" ? "write_svg:" : "pdf_info:")));
	assert.ok(run.activities.some((line) => line.startsWith(loop === "visual" ? "render_svg:" : "pdf_render:")));
}

// All global/env cases in this file are deliberately serial.
describe("provider-neutral raw agent loops", { concurrency: false }, () => {
	for (const loop of LOOPS) {
		it(`${loop}: every actual stream request has NO credential override (recording faux engine)`, async () => {
			await isolated({ OPENROUTER_API_KEY: OR_KEY, LH_PROVIDER_EVENTS: "1" }, async () => {
				const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
				faux.setResponses([0, 1, 2, 0, 1, 2].map((round) => {
					const calls = callsFor(loop, round);
					return fauxAssistantMessage(calls.length
						? calls.map((c, i) => fauxToolCall(c.name, c.args, { id: `call_${round}_${i}` }))
						: [fauxText(FINAL)], { stopReason: calls.length ? "toolUse" : "stop" });
				}));
				const requests: { context: TranscriptContext; options: Record<string, unknown> }[] = [];
				const signal = new AbortController().signal;
				const engine: PiEngine = {
					model: faux.getModel(), level: "medium",
					streamFn: (model, context, options) => {
						requests.push({ context, options: { ...options } });
						return faux.streamSimple(model, context, options);
					},
				};
				const run = await runLoop(loop, engine, signal);
				assertSuccess(loop, run);
				assert.equal(requests.length, 3);
				const sessionId = requests[0]!.options.sessionId;
				assert.match(String(sessionId), /^[0-9a-f-]{36}$/);
				assert.notEqual(sessionId, "provider-neutral-offline");
				for (const { options } of requests) {
					assert.equal(options.sessionId, sessionId);
					for (const key of ["apiKey", "getApiKey", "auth", "headers"]) {
						assert.ok(!Object.hasOwn(options, key), `${loop} stream must not supply ${key}`);
					}
					assert.equal(options.reasoning, "medium");
					assert.equal(options.signal, signal);
					assert.equal(typeof options.onProviderStreamEvent, "function");
				}
				assert.match(JSON.stringify(requests[2]!.context), /image\/png/);
				assert.match(JSON.stringify(requests[2]!.context), /toolResult/);
				const second = await runLoop(loop, engine, signal);
				assertSuccess(loop, second);
				assert.equal(requests.length, 6);
				const secondId = requests[3]!.options.sessionId;
				assert.notEqual(secondId, sessionId, "a separate unsaved operation must not reuse a conversation");
				for (const request of requests.slice(3)) assert.equal(request.options.sessionId, secondId);
			});
		});

		it(`${loop}: abort still reaches the stream and retains the loop's failure semantics`, async () => {
			await isolated({ OPENROUTER_API_KEY: OR_KEY }, async () => {
				const faux = createFauxCore({});
				faux.setResponses([fauxAssistantMessage([fauxText("must not be delivered")])]);
				const controller = new AbortController();
				controller.abort();
				const run = await runLoop(loop, { model: faux.getModel(), streamFn: faux.streamSimple }, controller.signal);
				const failure = "svg" in run.result ? run.result.notes : run.result.brief;
				assert.match(failure ?? "", /crashed — aborted/);
				assert.deepEqual(run.renders, []);
				assert.equal(run.usages.length, 0);
			});
		});
	}

	for (const transport of TRANSPORTS) {
		for (const loop of LOOPS) {
			it(`${loop}: native ${transport.provider}/${transport.api} endpoint, payload and live per-request auth`, async () => {
				await isolated({ OPENROUTER_API_KEY: OR_KEY, ...(transport.provider === "openrouter" ? {} : { [transport.envVar]: "dummy-selected-key-first" }) }, async () => {
					const engine = piEngineForSpec({ provider: transport.provider, id: transport.id, thinkingLevel: "off" });
					assert.equal(engine.model.api, transport.api);
					const requests: RecordedRequest[] = [];
					globalThis.fetch = closedFetch(transport, loop, requests);
					const run = await runLoop(loop, engine);
					assertSuccess(loop, run);
					assert.equal(requests.length, 3);
					for (const [round, request] of requests.entries()) {
						assert.equal(request.headers.get("user-agent"), APP_IDENTITY.userAgent.custom);
						if (transport.provider === "opencode-go") {
							assert.match(request.headers.get("x-opencode-session") ?? "", /^[0-9a-f-]{36}$/);
							assert.equal(request.headers.get("x-opencode-session"), requests[0]!.headers.get("x-opencode-session"));
							assert.equal(request.headers.get("x-opencode-client"), "learnharness");
						}
						const url = new URL(request.url);
						assert.equal(url.origin, transport.origin);
						assert.equal(url.pathname, transport.path);
						assert.equal(request.method, "POST");
						const expected = transport.provider === "openrouter" ? OR_KEY : round === 0 ? "dummy-selected-key-first" : "dummy-selected-key-rotated";
						assert.equal(request.headers.get(transport.authHeader), transport.authHeader === "authorization" ? `Bearer ${expected}` : expected);
						if (transport.provider !== "openrouter") assert.ok(!JSON.stringify({ ...request, headers: Object.fromEntries(request.headers) }).includes(OR_KEY));
						assertPayload(transport, loop, round, request.body);
					}
				});
			});
			if (transport.provider !== "openrouter") {
				it(`${loop}: ${transport.provider} missing selected key does not fall back to configured OpenRouter`, async () => {
					await isolated({ OPENROUTER_API_KEY: OR_KEY }, async () => {
						let fetches = 0;
						globalThis.fetch = async () => { fetches++; throw new Error("CLOSED: no fetch allowed"); };
						const engine = piEngineForSpec({ provider: transport.provider, id: transport.id, thinkingLevel: "off" });
						const run = await runLoop(loop, engine);
						const failure = "svg" in run.result ? run.result.notes : run.result.brief;
						assert.match(failure ?? "", new RegExp(`Provider is not configured: ${transport.provider}`));
						assert.equal(fetches, 0, "SDK Models guard rejects missing selected-provider auth before transport");
						assert.equal(run.usages.length, 0);
						assert.deepEqual(run.renders, []);
					});
				});
			}
		}
	}

	it("all AUTH_PROVIDER_KEYS resolve their own plain-key env values in a fresh in-memory Models collection", async () => {
		// No production singleton, credential files, process.env, OAuth refresh,
		// or model refresh: this is a broad resolver contract, not wire coverage.
		await isolated({}, async () => {
			const env = Object.fromEntries(AUTH_PROVIDER_KEYS.map(({ envVar }) => [envVar, `dummy-resolver-${envVar}`]));
			const models = createModels({ authContext: { env: async (name) => env[name], fileExists: async () => false } });
			for (const provider of builtinProviders()) models.setProvider(provider);
			models.setProvider(antigravityProvider());
			for (const { id, envVar } of AUTH_PROVIDER_KEYS) {
				const resolved = await models.getAuth(id);
				assert.ok(resolved, id);
				assert.equal(resolved.source, envVar, id);
				assert.equal(resolved.auth.apiKey, env[envVar], id);
			}
			// In particular, intentionally shared variables must serve BOTH rows.
			for (const envVar of new Set(AUTH_PROVIDER_KEYS.map((p) => p.envVar))) {
				const siblings = AUTH_PROVIDER_KEYS.filter((p) => p.envVar === envVar);
				if (siblings.length < 2) continue;
				for (const { id } of siblings) assert.equal((await models.getAuth(id))?.auth.apiKey, env[envVar], id);
			}
			delete env.OPENAI_API_KEY;
			assert.equal(await models.getAuth("openai"), undefined, "OpenRouter cannot configure a different provider");
			env.OPENAI_API_KEY = "dummy-resolver-openai-rotated";
			assert.equal((await models.getAuth("openai"))?.auth.apiKey, env.OPENAI_API_KEY);
		});
	});
});

interface RecordedRequest {
	url: string; method: string; headers: Headers; body: Record<string, unknown>;
}

function closedFetch(transport: Transport, loop: Loop, requests: RecordedRequest[]): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		const round = requests.length;
		// Unexpected destinations/rounds fail closed; never call original fetch.
		assert.equal(new URL(request.url).origin, transport.origin);
		assert.ok(round < 3, "unexpected extra provider request");
		requests.push({ url: request.url, method: request.method, headers: request.headers, body: JSON.parse(await request.text()) });
		if (transport.provider !== "openrouter") process.env[transport.envVar] = "dummy-selected-key-rotated";
		return sseResponse(transport, callsFor(loop, round), round);
	};
}

function assertPayload(transport: Transport, loop: Loop, round: number, body: Record<string, unknown>) {
	if (transport.api !== "google-generative-ai") assert.equal(body.model, transport.id);
	// Native Responses models may declare tools in additional_tools input
	// items rather than top-level tools; assert the SDK's complete payload.
	const tools = JSON.stringify(body);
	assert.match(tools, new RegExp(loop === "visual" ? "write_svg" : "pdf_extract"));
	assert.match(tools, new RegExp(loop === "visual" ? "render_svg" : "pdf_render"));
	if (transport.api === "google-generative-ai") assert.ok(Array.isArray(body.contents));
	else if (transport.api === "openai-responses") assert.ok(Array.isArray(body.input));
	else assert.ok(Array.isArray(body.messages));
	const json = JSON.stringify(body);
	assert.match(json, new RegExp(loop === "visual" ? "white square" : "Read page 1"));
	if (round === 2) {
		const supportsImages = piEngineForSpec({ provider: transport.provider, id: transport.id }).model.input.includes("image");
		assert.equal(json.includes(PNG.toString("base64")), supportsImages, "native modality filtering: only vision models receive rendered images");
		assert.match(json, new RegExp(transport.api === "google-generative-ai" ? "functionResponse" : transport.api === "openai-responses" ? "function_call_output" : transport.api === "anthropic-messages" ? "tool_result" : '"role":"tool"'));
		assert.match(json, new RegExp(loop === "visual" ? "Rendered" : "Page 1"));
	}
}

function sseResponse(transport: Transport, calls: Call[], round: number): Response {
	const events: Record<string, unknown>[] = [];
	if (transport.api === "openai-completions") {
		events.push({ id: `chatcmpl_offline_${round}`, object: "chat.completion.chunk", created: 1, model: transport.id,
			choices: [{ index: 0, delta: calls.length ? { role: "assistant", tool_calls: calls.map((c, i) => ({ index: i, id: `call_${round}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : { role: "assistant", content: FINAL }, finish_reason: null }] });
		events.push({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
	} else if (transport.api === "openai-responses") {
		const output = calls.length ? calls.map((c, i) => ({ type: "function_call", id: `fc_${round}_${i}`, call_id: `call_${round}_${i}`, name: c.name, arguments: JSON.stringify(c.args), status: "completed" }))
			: [{ type: "message", id: `msg_${round}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: FINAL, annotations: [] }] }];
		events.push({ type: "response.created", response: { id: `resp_offline_${round}`, status: "in_progress" } });
		for (const [index, item] of output.entries()) {
			events.push({ type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", ...(calls.length ? { arguments: "" } : { content: [] }) } });
			events.push(calls.length
				? { type: "response.function_call_arguments.delta", output_index: index, delta: JSON.stringify(calls[index]!.args) }
				: { type: "response.output_text.delta", output_index: index, content_index: 0, delta: FINAL });
			events.push({ type: "response.output_item.done", output_index: index, item });
		}
		events.push({ type: "response.completed", response: { id: `resp_offline_${round}`, status: "completed", output, usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
	} else if (transport.api === "anthropic-messages") {
		events.push({ type: "message_start", message: { id: `msg_offline_${round}`, type: "message", role: "assistant", model: transport.id, content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } });
		const blocks = calls.length ? calls.map((c, i) => ({ type: "tool_use", id: `call_${round}_${i}`, name: c.name, input: {} })) : [{ type: "text", text: "" }];
		for (const [index, block] of blocks.entries()) {
			events.push({ type: "content_block_start", index, content_block: block });
			events.push({ type: "content_block_delta", index, delta: calls.length ? { type: "input_json_delta", partial_json: JSON.stringify(calls[index]!.args) } : { type: "text_delta", text: FINAL } });
			events.push({ type: "content_block_stop", index });
		}
		events.push({ type: "message_delta", delta: { stop_reason: calls.length ? "tool_use" : "end_turn" }, usage: { output_tokens: 10 } });
		events.push({ type: "message_stop" });
	} else {
		events.push({ responseId: `google_offline_${round}`, candidates: [{ index: 0, content: { role: "model", parts: calls.length ? calls.map((c, i) => ({ functionCall: { id: `call_${round}_${i}`, name: c.name, args: c.args } })) : [{ text: FINAL }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 } });
	}
	const data = events.map((event) => `${typeof event.type === "string" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("") + (transport.api === "openai-completions" ? "data: [DONE]\n\n" : "");
	return new Response(data, { status: 200, headers: { "content-type": "text/event-stream" } });
}
