import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, normalizeContext, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { APP_IDENTITY, piEngineForSpec, type PiEngine } from "../src/agent/models.ts";
import { createPluginWorkerService } from "../src/agent/plugin-workers.ts";
import { createProberAgent, createTeacherAgent, createPracticeAgent, type AgentBuildOptions } from "../src/agent/teacher-agent.ts";
import { streamSideAnswer } from "../src/agent/side-chat.ts";
import { CLAUDE_CODE_PROVIDER } from "../src/agent/claude-code/constants.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";
import { healToolRecord } from "../src/agent/tools/heal.ts";
import type { ModelCatalogResponse } from "../src/core/contracts/models.ts";
import { createPluginInference } from "../src/server/plugin-inference.ts";
import { createPluginTaskRecordStore } from "../src/store/plugin-task-records.ts";
import metadata from "../package.json" with { type: "json" };

const factories = [
	(opts: AgentBuildOptions) => createProberAgent({ chatId: opts.chatId, searchAvailable: () => false } as never, opts),
	(opts: AgentBuildOptions) => createTeacherAgent(undefined, opts),
	(opts: AgentBuildOptions) => createPracticeAgent({} as never, opts),
];

function recordingEngine() {
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage([fauxToolCall("again", {}, { id: "call_0" })], { stopReason: "toolUse" }), { ...fauxAssistantMessage([fauxText("done")]), durationMs: 42 }]);
	const requests: SimpleStreamOptions[] = [];
	const engine: PiEngine = { model: faux.getModel(), streamFn: (model, context, options) => {
		requests.push(options ?? {});
		return faux.streamSimple(model, context, options);
	} };
	return { engine, requests };
}
const again = { name: "again", label: "again", description: "Continue", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }) };

function nativeCatalogFor(model: { provider: string; id: string }): ModelCatalogResponse {
	return {
		models: [{ ...model, name: "Fixture", reasoning: true, input: ["text"], supportedLevels: ["off", "high"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
		providers: [{ id: model.provider, envVar: "FIXTURE_KEY", keyPresent: true }],
		defaults: { model },
		rolePins: { researcher: null, demoBuilder: null, visualMaker: null, extractor: null, auditor: null, sideQuestion: null },
		slots: { strong: null, cheap: null, vision: null },
	};
}

// Whole-process replacement isolates native auth/profile discovery; fetch never
// delegates. No real credentials, .env, OAuth accounts, or model inference.
async function closed<T>(run: () => Promise<T>): Promise<T> {
	const env = process.env;
	const fetch = globalThis.fetch;
	process.env = { NODE_ENV: "test", HOME: "/nonexistent/session-identity", OPENROUTER_API_KEY: "dummy-router", OPENCODE_API_KEY: "dummy-go", OPENAI_API_KEY: "dummy-openai" };
	globalThis.fetch = async () => { throw new Error("CLOSED: unexpected fetch"); };
	try { return await run(); } finally { process.env = env; globalThis.fetch = fetch; }
}

describe("native app and conversation identity", { concurrency: false }, () => {
	it("shares one deeply frozen metadata-derived identity, without mutable conversation state", () => {
		assert.deepEqual(APP_IDENTITY, { userAgent: { custom: `learnharness/${metadata.version}` }, attribution: { name: metadata.name, url: metadata.homepage } });
		for (const value of [APP_IDENTITY, APP_IDENTITY.userAgent, APP_IDENTITY.attribution]) assert.ok(Object.isFrozen(value));
		assert.ok(!Object.hasOwn(APP_IDENTITY, "sessionId"));
	});

	it("reconstructed prober/teacher/practice Agents reuse the exact chat id across tool rounds", async () => {
		for (const chatId of ["chat_exact_native_123", "chat_independent_456"]) {
			for (const factory of factories) {
				const { engine, requests } = recordingEngine();
				const agent = factory({ engine, chatId, tools: { again } });
				assert.equal(agent.identity, APP_IDENTITY);
				assert.equal(agent.sessionId, chatId);
				await agent.prompt("offline");
				assert.equal(requests.length, 2);
				for (const options of requests) {
					assert.equal(options.sessionId, chatId);
					assert.deepEqual(options.identity, APP_IDENTITY);
					assert.ok(options.signal instanceof AbortSignal);
					assert.equal(options.apiKey, undefined);
				}
			}
		}
	});

	it("separate extractor/auditor/compaction invocations own distinct stable unsaved conversations", async () => {
		const ids = new Set<unknown>();
		// Compaction uses the shared runner with the researcher role.
		for (const role of ["extractor", "auditor", "researcher"] as const) {
			const { engine, requests } = recordingEngine();
			let usage = 0;
			const result = await runSubagent([again], { role, engine, chatId: "chat_shared_debug_only", systemPrompt: "offline", prompt: "offline", maxTurns: 3, onUsage: () => usage++ });
			assert.equal(requests.length, 2);
			assert.equal(usage, 2);
			const id = requests[0]!.sessionId;
			assert.match(id ?? "", /^[0-9a-f-]{36}$/);
			assert.notEqual(id, "chat_shared_debug_only");
			assert.ok(!ids.has(id));
			ids.add(id);
			for (const options of requests) { assert.equal(options.sessionId, id); assert.deepEqual(options.identity, APP_IDENTITY); }
			assert.ok(result.newMessages.some((m) => m.role === "toolResult" && typeof m.durationMs === "number"), "new native tool duration fields are preserved");
			assert.ok(result.newMessages.some((m) => m.role === "assistant" && typeof m.durationMs === "number"), "new native assistant duration fields are preserved");
		}
	});

	for (const [provider, id, endpoint] of [
		["opencode-go", "claude-haiku-5-5", "/inference/go/v1/messages"],
		["opencode-go", "gemini-4-argon-contributor", "/inference/go/v1/models/gemini-4-argon-contributor:streamGenerateContent"],
		["opencode-go", "glm-5.3", "/inference/go/v1/chat/completions"],
		["opencode-go", "gpt-6-luna", "/inference/go/v1/responses"],
		["openrouter", "openrouter/free", "/api/v1/chat/completions"],
	] as const) {
		it(`complete native ${provider}/${id} foreground serialization carries app identity and exact sessions`, async () => closed(async () => {
			const engine = piEngineForSpec({ provider, id, thinkingLevel: "off" });
			const requests: Request[] = [];
			globalThis.fetch = async (input, init) => { const request = new Request(input, init); requests.push(request); await request.text(); return new Response('{"error":{"message":"closed fixture"}}', { status: 400, headers: { "content-type": "application/json" } }); };
			for (const factory of factories) await factory({ engine, chatId: "chat_wire_exact", tools: {} }).prompt("offline");
			assert.equal(requests.length, 3);
			for (const request of requests) {
				assert.equal(new URL(request.url).pathname, endpoint);
				assert.equal(request.headers.get("user-agent"), `learnharness/${metadata.version}`);
				if (provider === "opencode-go") {
					assert.equal(new URL(request.url).origin, "https://opencode.ai");
					assert.equal(request.headers.get("x-opencode-client"), metadata.name);
					assert.equal(request.headers.get("x-opencode-session"), "chat_wire_exact");
					assert.ok(!JSON.stringify(Object.fromEntries(request.headers)).includes("dummy-router"));
				} else {
					assert.equal(new URL(request.url).origin, "https://openrouter.ai");
					assert.equal(request.headers.get("x-openrouter-title"), metadata.name);
					assert.equal(request.headers.get("http-referer"), metadata.homepage);
					assert.equal(request.headers.get("x-session-id"), "chat_wire_exact");
				}
			}
		}));
	}

	for (const [id, endpoint] of [
		["claude-haiku-5-5", "/inference/go/v1/messages"],
		["glm-5.3", "/inference/go/v1/chat/completions"],
	] as const) {
		it(`side questions carry the chat id so OpenCode Go can route ${id}`, async () => closed(async () => {
			const engine = piEngineForSpec({ provider: "opencode-go", id, thinkingLevel: "off" });
			const requests: Request[] = [];
			globalThis.fetch = async (input, init) => { const request = new Request(input, init); requests.push(request); await request.text(); return new Response('{"error":{"message":"closed fixture"}}', { status: 400, headers: { "content-type": "application/json" } }); };
			const result = await streamSideAnswer({ engine, instructions: "Offline", turns: [{ role: "user", text: "Why this step?" }], chatId: "chat_wire_side" });
			assert.equal(result.outcome, "error");
			assert.equal(requests.length, 1);
			assert.equal(new URL(requests[0]!.url).pathname, endpoint);
			assert.equal(requests[0]!.headers.get("x-opencode-session"), "chat_wire_side");
			assert.equal(requests[0]!.headers.get("x-opencode-client"), metadata.name);
		}));
	}

	it("side questions never resume a Claude Code live process", async () => {
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxText("offline answer")])]);
		const seen: (string | undefined)[] = [];
		const engine: PiEngine = {
			model: { ...faux.getModel(), provider: CLAUDE_CODE_PROVIDER },
			level: "off",
			streamFn: (model, context, options) => { seen.push(options?.sessionId); return faux.streamSimple(model, context, options); },
		};
		const result = await streamSideAnswer({ engine, instructions: "Offline", turns: [{ role: "user", text: "Why?" }], chatId: "chat_side_claude" });
		assert.equal(result.outcome, "done");
		assert.deepEqual(seen, [undefined]);
	});

	it("native OpenAI cache keys clamp to 64 characters while affinity retains exact session", async () => closed(async () => {
		const engine = piEngineForSpec({ provider: "openai", id: "gpt-4o-mini", thinkingLevel: "off" });
		const sessionId = "chat_" + "a".repeat(70);
		let body: Record<string, unknown> = {};
		let headers = new Headers();
		globalThis.fetch = async (input, init) => { const request = new Request(input, init); headers = request.headers; body = JSON.parse(await request.text()); return new Response("{}", { status: 400, headers: { "content-type": "application/json" } }); };
		await createTeacherAgent(undefined, { engine, chatId: sessionId, tools: {} }).prompt("offline");
		assert.equal(body.prompt_cache_key, Array.from(sessionId).slice(0, 64).join(""));
		assert.equal(headers.get("session_id"), sessionId);
	}));

	it("native OpenAI cache-key clamp counts Unicode code points, not UTF-16 units", async () => closed(async () => {
		const engine = piEngineForSpec({ provider: "openai", id: "gpt-4o-mini", thinkingLevel: "off" });
		const sessionId = "chat_" + "😀".repeat(70);
		let payload: unknown;
		// HTTP affinity headers cannot encode emoji. Observe native payload
		// serialization before transport, then stop deliberately (no accounts).
		await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "offline", timestamp: 1 }] }), {
			sessionId,
			onPayload: (value) => { payload = value; throw new Error("CLOSED: payload captured"); },
		}).result();
		assert.equal((payload as { prompt_cache_key: string }).prompt_cache_key, Array.from(sessionId).slice(0, 64).join(""));
	}));

	it("native Codex serialization shares the 64-code-point clamp without an account or OAuth flow", async () => closed(async () => {
		const engine = piEngineForSpec({ provider: "openai-codex", id: "gpt-6-luna", thinkingLevel: "off" });
		// Synthetic, unsigned fixture token solely satisfies native local claim
		// decoding. Stop at payload capture: no account, OAuth, or fetch.
		const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "offline-fixture" } };
		const apiKey = `dummy.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.dummy`;
		for (const sessionId of ["chat_" + "a".repeat(70), "chat_" + "😀".repeat(70)]) {
			let payload: unknown;
			// The app intentionally has no Codex auth row: exercise the native
			// serializer directly rather than adding an OAuth configuration path.
			assert.equal(engine.model.api, "openai-codex-responses");
			const result = await streamCodex(engine.model as Model<"openai-codex-responses">, normalizeContext({ messages: [{ role: "user", content: "offline", timestamp: 1 }] }), {
				apiKey, sessionId, identity: APP_IDENTITY,
				onPayload: (value) => { payload = value; throw new Error("CLOSED: payload captured"); },
			}).result();
			assert.ok(payload, result.errorMessage);
			assert.equal((payload as { prompt_cache_key: string }).prompt_cache_key, Array.from(sessionId).slice(0, 64).join(""));
		}
	}));

	it("SDK native header precedence and cache-off behavior remain untouched", async () => closed(async () => {
		const engine = piEngineForSpec({ provider: "opencode-go", id: "gpt-6-luna", thinkingLevel: "off" });
		let headers = new Headers();
		let body: Record<string, unknown> = {};
		globalThis.fetch = async (input, init) => { const request = new Request(input, init); headers = request.headers; body = JSON.parse(await request.text()); return new Response("{}", { status: 400, headers: { "content-type": "application/json" } }); };
		await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "offline", timestamp: 1 }] }), { sessionId: "chat_cache_off", cacheRetention: "none", headers: { "user-agent": "explicit-sdk-override", "x-opencode-client": null } }).result();
		assert.equal(headers.get("user-agent"), "explicit-sdk-override");
		assert.equal(headers.get("x-opencode-client"), null);
		// Native OpenCode routing identity remains even with cache retention off.
		assert.equal(headers.get("x-opencode-session"), "chat_cache_off");
		assert.equal(body.prompt_cache_key, undefined);
	}));

	it("completed malformed native JSON stays rejected despite app prepareArguments healing", async () => closed(async () => {
		const engine = piEngineForSpec({ provider: "openrouter", id: "openai/gpt-4o-mini", thinkingLevel: "off" });
		const malformed = '{"value":';
		globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ id: "offline", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_bad", type: "function", function: { name: "check", arguments: malformed } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		let executed = 0;
		let prepared = 0;
		const tools = healToolRecord({ check: { name: "check", label: "check", description: "check", parameters: Type.Object({ value: Type.Optional(Type.String()) }), execute: async () => { executed++; return { content: [], details: {} }; } } });
		const heal = tools.check!.prepareArguments!;
		tools.check!.prepareArguments = (args) => { prepared++; return heal(args); };
		const result = await runSubagent(Object.values(tools), { role: "extractor", engine, systemPrompt: "offline", prompt: "offline", maxTurns: 1 });
		const assistant = result.newMessages.find((m) => m.role === "assistant");
		assert.ok(assistant?.role === "assistant");
		const call = assistant.content.find((c) => c.type === "toolCall");
		assert.ok(call?.type === "toolCall" && call.argumentsError);
		assert.equal(executed, 0);
		assert.equal(prepared, 1, "SDK prepares arguments but preserves argumentsError for native validation");
		assert.ok(result.newMessages.some((m) => m.role === "toolResult" && m.isError));
	}));

	for (const [id, thinkingLevel, cacheRetention] of [
		["glm-5.3", "off", undefined],
		["deepseek-v4.1-flash", "high", "none"],
	] as const) it(`plugin workers keep isolated ${id} sessions across tool rounds (cache ${cacheRetention ?? "default"})`, async () => closed(async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "lh-plugin-worker-session-"));
		const signal = new AbortController();
		const pin = { provider: "opencode-go", id, thinkingLevel };
		const catalog = nativeCatalogFor(pin);
		const adapter = createPluginInference({ signal: signal.signal, dataDirectory: directory }, {
			catalog: () => catalog,
			providerKeyPresent: () => true,
			engineForSpec: (spec) => piEngineForSpec(spec),
		});
		const service = createPluginWorkerService({
			store: createPluginTaskRecordStore(path.join(directory, "tasks")),
			engineFor: adapter.engineFor,
			signal: signal.signal,
		});
		try {
			service.register({
				id: "generate-cues-v1",
				instructions: "offline",
				resultSchema: Type.Object({ ok: Type.Literal(true) }),
				tools: () => [{ name: "lookup", label: "lookup", description: "Look up a fact", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "noted" }], details: {} }) }],
			});
			const requests: Request[] = [];
			globalThis.fetch = async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				await request.text();
				const round = (requests.length - 1) % 2;
				const call = round === 0 ? { name: "lookup", arguments: {} } : { name: "submit_result", arguments: { result: { ok: true } } };
				const events = [
					{ id: `chatcmpl_offline_${round}`, object: "chat.completion.chunk", created: 1, model: pin.id, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${round}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: null }] },
					{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
				];
				return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
			};
			const sessions = new Set<string>();
			for (let chunk = 0; chunk < 2; chunk++) {
				const started = service.start("generate-cues-v1", { requestId: `flashcard-chunk-${chunk}`, input: { nodes: ["n1"] }, prompt: "Generate one cue", model: pin, purpose: "user", maxTurns: 4, options: { cacheRetention } });
				const outcome = await service.wait(started.id);
				assert.equal(outcome.status, "succeeded", JSON.stringify(outcome));
				assert.equal(requests.length, (chunk + 1) * 2);
				const session = requests[chunk * 2]!.headers.get("x-opencode-session");
				assert.match(session ?? "", /^[0-9a-f-]{36}$/);
				assert.equal(requests[chunk * 2 + 1]!.headers.get("x-opencode-session"), session);
				assert(!sessions.has(session!), "different tasks cannot share a provider session");
				sessions.add(session!);
			}
			for (const request of requests) {
				assert.equal(new URL(request.url).origin, "https://opencode.ai");
				assert.equal(new URL(request.url).pathname, "/inference/go/v1/chat/completions");
				assert.equal(request.headers.get("x-opencode-client"), metadata.name);
				assert.equal(request.headers.get("user-agent"), `learnharness/${metadata.version}`);
				assert.ok(!JSON.stringify(Object.fromEntries(request.headers)).includes("dummy-router"));
			}
		} finally {
			await service.dispose().catch(() => {});
			signal.abort();
			rmSync(directory, { recursive: true, force: true });
		}
	}));

	for (const [provider, id] of [["openrouter", "openrouter/free"], ["openai", "gpt-4o-mini"]] as const) {
		it(`managed ${provider} requests preserve native session affinity and caching`, async () => closed(async () => {
			const directory = mkdtempSync(path.join(tmpdir(), "lh-plugin-native-session-"));
			const controller = new AbortController();
			try {
				const pin = { provider, id, thinkingLevel: "off" as const };
				const adapter = createPluginInference({ signal: controller.signal, dataDirectory: directory }, {
					catalog: () => nativeCatalogFor(pin), providerKeyPresent: () => true, engineForSpec: spec => piEngineForSpec(spec),
				});
				const engine = await adapter.engineFor(pin, "user");
				let sessionId: string | undefined;
				const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
				globalThis.fetch = async (input, init) => {
					const request = new Request(input, init);
					requests.push({ headers: request.headers, body: JSON.parse(await request.text()) });
					return new Response('{"error":{"message":"closed fixture"}}', { status: 400, headers: { "content-type": "application/json" } });
				};
				await assert.rejects(runSubagent([], {
					engine: { ...engine, streamFn: (model, context, options) => { sessionId = options?.sessionId; return engine.streamFn(model, context, options); } },
					systemPrompt: "Offline", prompt: "Offline", maxTurns: 1,
				}), /closed fixture/);
				assert.match(sessionId ?? "", /^[0-9a-f-]{36}$/);
				assert.equal(requests.length, 1);
				const { headers, body } = requests[0]!;
				assert.equal(headers.get("x-opencode-session"), null);
				assert.equal(headers.get("user-agent"), `learnharness/${metadata.version}`);
				if (provider === "openrouter") {
					assert.equal(headers.get("x-session-id"), sessionId);
					assert.equal(headers.get("x-openrouter-title"), metadata.name);
				} else {
					assert.equal(headers.get("session_id"), sessionId);
					assert.equal(body.prompt_cache_key, sessionId);
				}
			} finally {
				controller.abort();
				rmSync(directory, { recursive: true, force: true });
			}
		}));
	}
});
