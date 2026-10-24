/**
 * LOCAL MODEL SERVERS (local-models wave, 2026-10-24): the pure rules
 * (address normalization, key-var naming, ids, the settings sanitizer),
 * discovery against fixture servers that answer like Ollama, llama.cpp,
 * vLLM, LM Studio, an auth-gated generic server and an Anthropic-style
 * one, the request a local engine actually sends, and the composition's
 * connect → catalog → remove lifecycle.
 *
 * Its OWN PROCESS under node:test with LH_DATA_DIR / LH_AUTH_FILE pointed
 * at a tmp dir BEFORE the imports (both seams are module-load bound) — the
 * connect tests write settings.json and auth.json, never the repo's.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-local-servers-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

const core = await import("../src/core/local-servers.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { buildLocalModel, discoverLocalModels, KEYLESS_API_KEY, LOCAL_DEFAULT_CONTEXT_WINDOW } = await import(
	"../src/agent/local-models.ts"
);
const { piEngineForSpec, piModels, registerLocalServer, resolveModel, unregisterLocalServer } = await import(
	"../src/agent/models.ts"
);
const localServers = await import("../src/server/local-servers.ts");
const { catalogProviders, modelCatalog, validateModelsSettings, clampModelsLevels } = await import(
	"../src/server/model-catalog.ts"
);
const { readSettings } = await import("../src/store/settings.ts");
const { authStore } = await import("../src/store/auth.ts");

// ─── Fixture servers ─────────────────────────────────────────────────────────

interface Seen {
	method: string;
	path: string;
	headers: http.IncomingHttpHeaders;
	body: unknown;
}

type Route = (req: Seen) => { status?: number; json?: unknown; sse?: string[] } | undefined;

interface Fixture {
	url: string;
	seen: Seen[];
	close: () => Promise<void>;
}

async function fixture(route: Route): Promise<Fixture> {
	const seen: Seen[] = [];
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			const entry: Seen = {
				method: req.method ?? "GET",
				path: req.url ?? "/",
				headers: req.headers,
				body: raw ? JSON.parse(raw) : undefined,
			};
			seen.push(entry);
			const answer = route(entry);
			if (!answer) {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "not found" }));
				return;
			}
			if (answer.sse) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				for (const event of answer.sse) res.write(`data: ${event}\n\n`);
				res.end();
				return;
			}
			res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
			res.end(JSON.stringify(answer.json ?? {}));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `127.0.0.1:${port}`,
		seen,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

/** An Ollama: the OpenAI listing + the native /api/version, /api/ps,
 *  /api/show — and a chat endpoint that streams one short answer. */
const ollamaRoute: Route = (req) => {
	if (req.method === "GET" && req.path === "/v1/models") {
		return {
			json: {
				object: "list",
				data: ["mistral-nemo:12b", "llava:7b", "nomic-embed-text:latest", "gemma:2b"].map((id) => ({
					id,
					object: "model",
					owned_by: "library",
				})),
			},
		};
	}
	if (req.path === "/api/version") return { json: { version: "0.12.3" } };
	if (req.path === "/api/ps") return { json: { models: [{ name: "mistral-nemo:12b", context_length: 16384 }] } };
	if (req.method === "POST" && req.path === "/api/show") {
		const model = (req.body as { model: string }).model;
		const shows: Record<string, unknown> = {
			"mistral-nemo:12b": {
				capabilities: ["completion", "tools", "thinking"],
				model_info: { "general.architecture": "mistral", "mistral.context_length": 40960 },
				parameters: "temperature 0.6",
			},
			"llava:7b": {
				capabilities: ["completion", "tools", "vision"],
				model_info: { "general.architecture": "llama", "llama.context_length": 32768 },
				parameters: 'num_ctx                        8192\nstop                           "</s>"',
			},
			"nomic-embed-text:latest": { capabilities: ["embedding"], model_info: {} },
			"gemma:2b": { capabilities: ["completion"], model_info: { "gemma.context_length": 8192 } },
		};
		return { json: shows[model] ?? {} };
	}
	if (req.method === "POST" && req.path === "/v1/chat/completions") {
		const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
			JSON.stringify({
				id: "chatcmpl-1",
				object: "chat.completion.chunk",
				created: 1,
				model: (req.body as { model: string }).model,
				choices: [{ index: 0, delta, finish_reason: finish }],
				...(usage ? { usage } : {}),
			});
		return {
			sse: [
				chunk({ role: "assistant", content: "Hello from local" }, null),
				chunk({}, "stop", { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }),
				"[DONE]",
			],
		};
	}
	return undefined;
};

let ollama: Fixture;
let ollamaTwin: Fixture;

before(async () => {
	ollama = await fixture(ollamaRoute);
	ollamaTwin = await fixture(ollamaRoute);
});

after(async () => {
	await ollama.close();
	await ollamaTwin.close();
	fs.rmSync(TMP, { recursive: true, force: true });
});

// ─── Pure rules ──────────────────────────────────────────────────────────────

describe("normalizeLocalServerUrl — the address field to an API base", () => {
	const norm = (address: string, api: Parameters<typeof core.normalizeLocalServerUrl>[1] = "openai-completions") =>
		core.normalizeLocalServerUrl(address, api);

	it("host:port gains http:// and the /v1 an OpenAI-style client needs", () => {
		assert.deepEqual(norm("localhost:11434"), { ok: true, baseUrl: "http://localhost:11434/v1" });
		assert.deepEqual(norm("  192.168.1.20:8000/  "), { ok: true, baseUrl: "http://192.168.1.20:8000/v1" });
		assert.deepEqual(norm("http://localhost:8080/v1/"), { ok: true, baseUrl: "http://localhost:8080/v1" });
	});

	it("a custom path is kept verbatim (proxies), https is kept", () => {
		assert.deepEqual(norm("https://gpu.lan/api/openai/v1"), { ok: true, baseUrl: "https://gpu.lan/api/openai/v1" });
	});

	it("Anthropic-style bases drop /v1 — the client appends /v1/messages itself", () => {
		assert.deepEqual(norm("localhost:8080/v1", "anthropic-messages"), { ok: true, baseUrl: "http://localhost:8080" });
		assert.deepEqual(norm("localhost:8080", "anthropic-messages"), { ok: true, baseUrl: "http://localhost:8080" });
	});

	it("empty, unparseable, and non-http addresses refuse with a user-facing line", () => {
		assert.equal(norm("   ").ok, false);
		assert.equal(norm("http://exa mple:80").ok, false);
		const ftp = norm("ftp://host:21");
		assert.equal(ftp.ok, false);
		assert.match((ftp as { error: string }).error, /http/);
	});

	it("displayAddress turns a base back into what a person types", () => {
		assert.equal(core.displayAddress("http://localhost:11434/v1"), "localhost:11434");
		assert.equal(core.displayAddress("https://gpu.lan/api/openai/v1"), "https://gpu.lan/api/openai/v1");
		assert.equal(core.displayAddress("http://localhost:8080"), "localhost:8080");
	});
});

describe("local server ids and key slots", () => {
	it("ids slug the engine and step past every taken id (built-ins included)", () => {
		assert.equal(core.localServerIdFor("ollama", new Set()), "ollama");
		assert.equal(core.localServerIdFor("ollama", new Set(["ollama", "ollama-2"])), "ollama-3");
		assert.equal(core.localServerIdFor("LM Studio", new Set()), "lm-studio");
		assert.equal(core.localServerIdFor("openai", new Set(["openai"])), "openai-2");
		assert.equal(core.localServerIdFor("", new Set()), "local");
	});

	it("each server's key rides its own env-var name, recognizably", () => {
		assert.equal(core.localServerKeyVar("ollama-2"), "LOCAL_SERVER_OLLAMA_2_API_KEY");
		assert.ok(core.isLocalServerKeyVar("LOCAL_SERVER_OLLAMA_2_API_KEY"));
		assert.ok(!core.isLocalServerKeyVar("OPENAI_API_KEY"));
	});
});

describe("the localServers settings section", () => {
	it("keeps well-formed entries, drops junk and duplicate ids, floors a tiny context override", () => {
		const record = sanitizeUserSettings({
			version: 1,
			localServers: [
				{ id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", api: "openai-completions", vision: true },
				{ id: "ollama", name: "dupe", baseUrl: "http://x/v1", api: "openai-completions" },
				{ id: "Bad Id", name: "x", baseUrl: "http://x/v1", api: "openai-completions" },
				{ id: "vllm", name: "vLLM", baseUrl: "ftp://x", api: "openai-completions" },
				{ id: "llamacpp", name: "llama.cpp", baseUrl: "http://h:8080/v1", api: "grpc" },
				{ id: "lms", name: "LM Studio", baseUrl: "http://h:1234/v1", api: "openai-responses", contextWindow: 100 },
				"junk",
			],
		});
		assert.deepEqual(record?.localServers, [
			{ id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", api: "openai-completions", vision: true },
			{ id: "lms", name: "LM Studio", baseUrl: "http://h:1234/v1", api: "openai-responses", contextWindow: core.LOCAL_CONTEXT_WINDOW_FLOOR },
		]);
	});

	it("a list with nothing valid left is dropped, not carried raw", () => {
		const record = sanitizeUserSettings({ version: 1, localServers: [{ id: 3 }] });
		assert.equal(record && "localServers" in record, false);
	});
});

// ─── Discovery ───────────────────────────────────────────────────────────────

describe("discoverLocalModels — the server reports its own models and limits", () => {
	it("Ollama: running context > Modelfile num_ctx; vision/thinking from capabilities; embedding and tool-less models hidden", async () => {
		const found = await discoverLocalModels({ baseUrl: `http://${ollama.url}/v1`, api: "openai-completions" });
		assert.equal(found.engine, "ollama");
		assert.deepEqual(found.models, [
			{ id: "mistral-nemo:12b", contextWindow: 16384, vision: false, reasoning: true },
			{ id: "llava:7b", contextWindow: 8192, vision: true, reasoning: false },
		]);
		assert.deepEqual(found.hidden, [
			{ id: "nomic-embed-text:latest", reason: "embedding model" },
			{ id: "gemma:2b", reason: "no tool calling" },
		]);
	});

	it("llama.cpp: the runtime slot context from /props beats the trained length; vision from modalities", async () => {
		const server = await fixture((req) => {
			if (req.path === "/v1/models") {
				return { json: { data: [{ id: "gemma-3-4b-it.gguf", owned_by: "llamacpp", meta: { n_ctx_train: 128000 } }] } };
			}
			if (req.path === "/props") return { json: { default_generation_settings: { n_ctx: 16384 }, modalities: { vision: true } } };
			return undefined;
		});
		try {
			const found = await discoverLocalModels({ baseUrl: `http://${server.url}/v1`, api: "openai-completions" });
			assert.equal(found.engine, "llamacpp");
			assert.deepEqual(found.models, [{ id: "gemma-3-4b-it.gguf", name: undefined, contextWindow: 16384, vision: true }]);
		} finally {
			await server.close();
		}
	});

	it("vLLM: max_model_len straight from the listing, no extra probes", async () => {
		const server = await fixture((req) =>
			req.path === "/v1/models"
				? { json: { data: [{ id: "meta-llama/Llama-3.1-8B-Instruct", owned_by: "vllm", max_model_len: 65536 }] } }
				: undefined,
		);
		try {
			const found = await discoverLocalModels({ baseUrl: `http://${server.url}/v1`, api: "openai-completions" });
			assert.equal(found.engine, "vllm");
			assert.equal(found.models[0]?.contextWindow, 65536);
			assert.deepEqual(server.seen.map((s) => s.path), ["/v1/models"]);
		} finally {
			await server.close();
		}
	});

	it("LM Studio: loaded context first, vlm = vision, embeddings hidden", async () => {
		const server = await fixture((req) => {
			if (req.path === "/v1/models") {
				return { json: { data: [{ id: "llava-v1.6-mistral-7b", owned_by: "organization_owner" }, { id: "text-embedding-nomic" }] } };
			}
			if (req.path === "/api/v0/models") {
				return {
					json: {
						data: [
							{ id: "llava-v1.6-mistral-7b", type: "vlm", max_context_length: 32768, loaded_context_length: 8192 },
							{ id: "text-embedding-nomic", type: "embeddings", max_context_length: 2048 },
						],
					},
				};
			}
			return undefined;
		});
		try {
			const found = await discoverLocalModels({ baseUrl: `http://${server.url}/v1`, api: "openai-completions" });
			assert.equal(found.engine, "lmstudio");
			assert.deepEqual(found.models, [{ id: "llava-v1.6-mistral-7b", name: undefined, contextWindow: 8192, vision: true }]);
			assert.deepEqual(found.hidden, [{ id: "text-embedding-nomic", reason: "embedding model" }]);
		} finally {
			await server.close();
		}
	});

	it("a generic server behind a key: the bearer goes out, a listed context_length is read", async () => {
		const server = await fixture((req) => {
			if (req.headers.authorization !== "Bearer s3cret") return { status: 401, json: { error: "unauthorized" } };
			return req.path === "/v1/models" ? { json: { data: [{ id: "m1", context_length: 20000 }] } } : undefined;
		});
		try {
			const baseUrl = `http://${server.url}/v1`;
			await assert.rejects(
				discoverLocalModels({ baseUrl, api: "openai-completions" }),
				/refused the request \(HTTP 401\) — check the API key/,
			);
			const found = await discoverLocalModels({ baseUrl, api: "openai-completions" }, { apiKey: "s3cret" });
			assert.equal(found.engine, null);
			assert.deepEqual(found.models, [{ id: "m1", name: undefined, contextWindow: 20000 }]);
		} finally {
			await server.close();
		}
	});

	it("Anthropic-style: the list lives at /v1/models under the root, one maximal page, with x-api-key + version headers", async () => {
		const server = await fixture((req) =>
			req.path === "/v1/models?limit=1000"
				? { json: { data: [{ id: "local-claude", display_name: "Local Claude", type: "model" }], has_more: false } }
				: undefined,
		);
		try {
			const found = await discoverLocalModels({ baseUrl: `http://${server.url}`, api: "anthropic-messages" }, { apiKey: "k" });
			assert.deepEqual(found.models, [{ id: "local-claude", name: "Local Claude", contextWindow: undefined }]);
			const listing = server.seen[0]!;
			assert.equal(listing.headers["x-api-key"], "k");
			assert.equal(listing.headers["anthropic-version"], "2023-06-01");
		} finally {
			await server.close();
		}
	});

	it("unreachable, wrong path, and non-list answers fail with a reason a person can act on", async () => {
		const closed = await fixture(() => undefined);
		const closedUrl = closed.url;
		await closed.close();
		await assert.rejects(
			discoverLocalModels({ baseUrl: `http://${closedUrl}/v1`, api: "openai-completions" }),
			/Could not reach .* — is the server running\?/,
		);
		const odd = await fixture((req) => (req.path === "/v1/models" ? { json: { hello: "world" } } : undefined));
		try {
			await assert.rejects(
				discoverLocalModels({ baseUrl: `http://${odd.url}/v1`, api: "openai-completions" }),
				/did not return a model list/,
			);
			await assert.rejects(
				discoverLocalModels({ baseUrl: `http://${odd.url}/api`, api: "openai-completions" }),
				/No model list at .* \(HTTP 404\) — check the address and API type, or enter the model IDs yourself/,
			);
		} finally {
			await odd.close();
		}
	});
});

describe("any compatible endpoint — no known engine required", () => {
	it("lenient list shapes: {models: [{name}]}, a bare array of ids or objects", async () => {
		const shapes: unknown[] = [
			{ models: [{ name: "alpha" }, { model: "beta" }] },
			["alpha", "beta"],
			[{ id: "alpha" }, { id: "beta", context_window: 12000 }],
		];
		for (const shape of shapes) {
			const server = await fixture((req) => (req.path === "/v1/models" ? { json: shape } : undefined));
			try {
				const found = await discoverLocalModels({ baseUrl: `http://${server.url}/v1`, api: "openai-completions" });
				assert.equal(found.engine, null);
				assert.deepEqual(found.models.map((m) => m.id), ["alpha", "beta"], JSON.stringify(shape));
			} finally {
				await server.close();
			}
		}
	});

	it("an unrecognized engine is named by its own owned_by (never by a generic placeholder)", async () => {
		const named = await fixture((req) =>
			req.path === "/v1/models"
				? { json: { object: "list", data: [{ id: "acme-chat", owned_by: "acme-engine", context_length: 65536 }] } }
				: undefined,
		);
		const generic = await fixture((req) =>
			req.path === "/v1/models" ? { json: { data: [{ id: "a", owned_by: "system" }, { id: "b", owned_by: "system" }] } } : undefined,
		);
		try {
			const found = await discoverLocalModels({ baseUrl: `http://${named.url}/v1`, api: "openai-completions" });
			assert.equal(found.engine, null);
			assert.equal(found.owner, "acme-engine");
			assert.deepEqual(found.models, [{ id: "acme-chat", name: undefined, contextWindow: 65536 }]);
			const result = await localServers.connectLocalServer({ address: named.url, api: "openai-completions" });
			assert.ok(result.ok, JSON.stringify(result));
			const view = (result as { server: { id: string; name: string } }).server;
			assert.deepEqual([view.id, view.name], ["acme-engine", "acme-engine"]);
			localServers.removeLocalServer("acme-engine");
			const plain = await discoverLocalModels({ baseUrl: `http://${generic.url}/v1`, api: "openai-completions" });
			assert.equal(plain.owner, undefined);
		} finally {
			await named.close();
			await generic.close();
		}
	});

	it("an empty list object (data: null — Ollama with nothing pulled) is an empty list, not a missing one", async () => {
		const server = await fixture((req) => (req.path === "/v1/models" ? { json: { object: "list", data: null } } : undefined));
		try {
			const found = await discoverLocalModels({ baseUrl: `http://${server.url}/v1`, api: "openai-completions" });
			assert.deepEqual(found.models, []);
			const result = await localServers.connectLocalServer({ address: server.url, api: "openai-completions" });
			assert.deepEqual(result, {
				ok: false,
				status: 502,
				error: "The server answered but lists no models — load or pull one, then connect again.",
			});
		} finally {
			await server.close();
		}
	});

	it("an endpoint without a model list works once the models are named — and only then", async () => {
		const server = await fixture(() => undefined); // 404 everywhere
		try {
			const baseUrl = `http://${server.url}/v1`;
			await assert.rejects(discoverLocalModels({ baseUrl, api: "openai-completions" }), /enter the model IDs yourself/);
			const found = await discoverLocalModels({ baseUrl, api: "openai-completions", models: ["my-model", "other"] });
			assert.deepEqual(found, { engine: null, models: [{ id: "my-model" }, { id: "other" }], hidden: [] });
		} finally {
			await server.close();
		}
	});

	it("named ids never excuse an unreachable server or a refused key", async () => {
		const gated = await fixture(() => ({ status: 401, json: {} }));
		try {
			await assert.rejects(
				discoverLocalModels({ baseUrl: `http://${gated.url}/v1`, api: "openai-completions", models: ["m"] }),
				/check the API key/,
			);
		} finally {
			await gated.close();
		}
		await assert.rejects(
			discoverLocalModels({ baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", models: ["m"] }),
			/Could not reach/,
		);
	});

	it("named ids join the server's list; a model the server would hide is offered when named", async () => {
		const found = await discoverLocalModels({
			baseUrl: `http://${ollama.url}/v1`,
			api: "openai-completions",
			models: ["gemma:2b", "mistral-nemo:12b", "unlisted:1b"],
		});
		assert.deepEqual(found.models.map((m) => m.id), ["mistral-nemo:12b", "llava:7b", "gemma:2b", "unlisted:1b"]);
		assert.deepEqual(found.hidden, [{ id: "nomic-embed-text:latest", reason: "embedding model" }]);
	});

	it("connect: a list-less endpoint is stored with its named models, named after its address", async () => {
		const server = await fixture((req) => {
			if (req.method === "POST" && req.path === "/v1/chat/completions") return { json: {} };
			return undefined;
		});
		try {
			const refused = await localServers.connectLocalServer({ address: server.url, api: "openai-completions" });
			assert.equal((refused as { status: number }).status, 502);
			const result = await localServers.connectLocalServer({
				address: server.url,
				api: "openai-completions",
				models: ["my-model"],
			});
			assert.ok(result.ok, JSON.stringify(result));
			const view = (result as { server: import("../src/core/local-servers.ts").LocalServerView }).server;
			assert.equal(view.id, "local");
			assert.equal(view.name, server.url);
			assert.deepEqual(view.models, ["my-model"]);
			assert.equal(view.status?.engine, null);
			assert.deepEqual(view.status?.models.map((m) => [m.id, m.contextWindow]), [["my-model", LOCAL_DEFAULT_CONTEXT_WINDOW]]);
			assert.ok(modelCatalog().models.some((m) => m.provider === "local" && m.id === "my-model"));
			const cleared = await localServers.connectLocalServer({ id: "local", address: server.url, api: "openai-completions", models: null });
			assert.equal((cleared as { status: number }).status, 502, "clearing the names of a list-less server cannot connect");
			assert.equal(localServers.removeLocalServer("local").ok, true);
		} finally {
			await server.close();
		}
	});
});

// ─── The engine ──────────────────────────────────────────────────────────────

describe("a local model as pi runs it", () => {
	const server = (overrides: Partial<import("../src/core/local-servers.ts").LocalServer> = {}) => ({
		id: "fixture-ollama",
		name: "Ollama",
		baseUrl: `http://${ollama.url}/v1`,
		api: "openai-completions" as const,
		...overrides,
	});

	it("buildLocalModel: the server's report under the per-server overrides; free; local-safe compat", () => {
		const reported = buildLocalModel(server(), { id: "mistral-nemo:12b", contextWindow: 16384, reasoning: true });
		assert.equal(reported.contextWindow, 16384);
		assert.equal(reported.maxTokens, 16384);
		assert.deepEqual(reported.input, ["text"]);
		assert.equal(reported.reasoning, true);
		assert.deepEqual(reported.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual(reported.compat, { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" });
		const overridden = buildLocalModel(server({ contextWindow: 4096, vision: true }), { id: "mistral-nemo:12b", contextWindow: 16384 });
		assert.equal(overridden.contextWindow, 4096);
		assert.deepEqual(overridden.input, ["text", "image"]);
		assert.equal(buildLocalModel(server(), { id: "unknown" }).contextWindow, LOCAL_DEFAULT_CONTEXT_WINDOW);
	});

	it("a registered server's pin resolves before discovery (cold process), and stops resolving once removed", () => {
		registerLocalServer(server(), []);
		try {
			const model = resolveModel("fixture-ollama", "mistral-nemo:12b");
			assert.ok(model, "the fallback keeps a pinned local model runnable");
			assert.equal(model!.contextWindow, LOCAL_DEFAULT_CONTEXT_WINDOW);
			assert.equal(piEngineForSpec({ provider: "fixture-ollama", id: "mistral-nemo:12b" }).level, "off");
		} finally {
			unregisterLocalServer("fixture-ollama");
		}
		assert.equal(resolveModel("fixture-ollama", "mistral-nemo:12b"), undefined);
		assert.equal(piModels().getProvider("fixture-ollama"), undefined);
	});

	it("the request on the wire: system role, max_tokens within the window, no store, keyless placeholder, then the stored key", async () => {
		registerLocalServer(server(), [{ id: "mistral-nemo:12b", contextWindow: 16384, reasoning: true }]);
		try {
			const engine = piEngineForSpec({ provider: "fixture-ollama", id: "mistral-nemo:12b", thinkingLevel: "off" });
			const context = {
				systemPrompt: "You are a tutor.",
				messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }],
			};
			const answer = await piModels().completeSimple(engine.model, context);
			assert.equal(answer.stopReason, "stop", answer.errorMessage);
			assert.deepEqual(answer.content, [{ type: "text", text: "Hello from local" }]);
			const sent = ollama.seen.filter((s) => s.path === "/v1/chat/completions").at(-1)!;
			const body = sent.body as Record<string, unknown> & { messages: { role: string }[] };
			assert.equal(body.model, "mistral-nemo:12b");
			assert.equal(body.messages[0]!.role, "system");
			assert.ok(!("store" in body), "no OpenAI-only store field");
			assert.ok(!("max_completion_tokens" in body));
			assert.ok(typeof body.max_tokens === "number" && body.max_tokens > 0 && body.max_tokens <= 16384);
			assert.equal(sent.headers.authorization, `Bearer ${KEYLESS_API_KEY}`);

			process.env[core.localServerKeyVar("fixture-ollama")] = "tok-123";
			await piModels().completeSimple(engine.model, context);
			const keyed = ollama.seen.filter((s) => s.path === "/v1/chat/completions").at(-1)!;
			assert.equal(keyed.headers.authorization, "Bearer tok-123");
		} finally {
			delete process.env[core.localServerKeyVar("fixture-ollama")];
			unregisterLocalServer("fixture-ollama");
		}
	});
});

// ─── The composition ─────────────────────────────────────────────────────────

describe("connect → catalog → edit → remove", () => {
	it("a server that cannot be used is never stored", async () => {
		const result = await localServers.connectLocalServer({ address: "127.0.0.1:1", api: "openai-completions" });
		assert.equal(result.ok, false);
		assert.equal((result as { status: number }).status, 502);
		assert.equal(readSettings()?.localServers, undefined);
		const bad = await localServers.connectLocalServer({ address: "x", api: "carrier-pigeon" });
		assert.deepEqual(bad, { ok: false, status: 400, error: "api must be one of: openai-completions, openai-responses, anthropic-messages" });
		const tiny = await localServers.connectLocalServer({ address: ollama.url, api: "openai-completions", contextWindow: 10 });
		assert.equal((tiny as { status: number }).status, 400);
	});

	it("connecting stores the server, its key, and federates its models into the catalog", async () => {
		const result = await localServers.connectLocalServer({ address: ollama.url, api: "openai-completions", apiKey: "tok-abc" });
		assert.ok(result.ok, JSON.stringify(result));
		const view = (result as { server: import("../src/core/local-servers.ts").LocalServerView }).server;
		assert.equal(view.id, "ollama");
		assert.equal(view.name, "Ollama");
		assert.equal(view.address, ollama.url);
		assert.equal(view.apiKeySet, true);
		assert.equal(view.status?.ok, true);
		assert.deepEqual(view.status?.models.map((m) => [m.id, m.contextWindow, m.vision, m.reasoning]), [
			["mistral-nemo:12b", 16384, false, true],
			["llava:7b", 8192, true, false],
		]);
		assert.equal(view.status?.hidden.length, 2);

		assert.deepEqual(readSettings()?.localServers, [
			{ id: "ollama", name: "Ollama", baseUrl: `http://${ollama.url}/v1`, api: "openai-completions" },
		]);
		assert.equal(authStore.authVars().LOCAL_SERVER_OLLAMA_API_KEY, "tok-abc");

		const provider = catalogProviders().find((p) => p.id === "ollama");
		assert.deepEqual(provider, { id: "ollama", envVar: "LOCAL_SERVER_OLLAMA_API_KEY", keyPresent: true, local: true });
		const local = modelCatalog().models.filter((m) => m.provider === "ollama");
		assert.deepEqual(local.map((m) => [m.id, m.contextWindow, m.local]), [
			["llava:7b", 8192, true],
			["mistral-nemo:12b", 16384, true],
		]);
		assert.deepEqual(local.find((m) => m.id === "llava:7b")!.input, ["text", "image"]);
		assert.ok(local.find((m) => m.id === "mistral-nemo:12b")!.supportedLevels.includes("medium"), "a thinking model offers levels");

		const slots = { strong: { model: { provider: "ollama", id: "mistral-nemo:12b" }, thinkingLevel: "xhigh" as const } };
		assert.deepEqual(validateModelsSettings(slots), { ok: true });
		assert.equal(clampModelsLevels(slots).strong?.thinkingLevel, "high", "levels clamp against the server-reported model");
	});

	it("a second server of the same engine gets its own id", async () => {
		const result = await localServers.connectLocalServer({ address: ollamaTwin.url, api: "openai-completions" });
		assert.ok(result.ok, JSON.stringify(result));
		assert.equal((result as { server: { id: string } }).server.id, "ollama-2");
		assert.deepEqual(localServers.listLocalServers().map((s) => s.id), ["ollama", "ollama-2"]);
	});

	it("editing keeps the id; overrides apply to every model; null clears the key", async () => {
		const result = await localServers.connectLocalServer({
			id: "ollama",
			address: `http://${ollama.url}/v1`,
			api: "openai-completions",
			apiKey: null,
			contextWindow: 12000,
			vision: true,
		});
		assert.ok(result.ok, JSON.stringify(result));
		const view = (result as { server: import("../src/core/local-servers.ts").LocalServerView }).server;
		assert.equal(view.id, "ollama");
		assert.equal(view.apiKeySet, false);
		assert.deepEqual(view.status?.models.map((m) => [m.contextWindow, m.vision]), [
			[12000, true],
			[12000, true],
		]);
		assert.equal(authStore.authVars().LOCAL_SERVER_OLLAMA_API_KEY, undefined);
		assert.equal(resolveModel("ollama", "mistral-nemo:12b")?.contextWindow, 12000);
		const unknown = await localServers.connectLocalServer({ id: "nope", address: ollama.url, api: "openai-completions" });
		assert.equal((unknown as { status: number }).status, 404);
	});

	it("a refresh against a server that went away keeps its last models and records why", async () => {
		const flaky = await fixture(ollamaRoute);
		const result = await localServers.connectLocalServer({ address: flaky.url, api: "openai-completions" });
		assert.ok(result.ok, JSON.stringify(result));
		const id = (result as { server: { id: string } }).server.id;
		await flaky.close();
		await localServers.refreshLocalServers({ force: true, ids: [id] });
		const view = localServers.listLocalServers().find((s) => s.id === id)!;
		assert.equal(view.status?.ok, false);
		assert.match(view.status?.error ?? "", /Could not reach/);
		assert.equal(view.status?.models.length, 2, "the last good list survives");
		assert.ok(piModels().getModel(id, "mistral-nemo:12b"));
		assert.deepEqual(localServers.removeLocalServer(id), { ok: true });
	});

	it("removing forgets the entry, its key, and its provider", async () => {
		await localServers.connectLocalServer({ id: "ollama-2", address: ollamaTwin.url, api: "openai-completions", apiKey: "tok-2" });
		assert.equal(authStore.authVars().LOCAL_SERVER_OLLAMA_2_API_KEY, "tok-2");
		assert.deepEqual(localServers.removeLocalServer("ollama-2"), { ok: true });
		assert.equal(authStore.authVars().LOCAL_SERVER_OLLAMA_2_API_KEY, undefined);
		assert.equal(piModels().getProvider("ollama-2"), undefined);
		assert.ok(!catalogProviders().some((p) => p.id === "ollama-2"));
		assert.deepEqual(localServers.listLocalServers().map((s) => s.id), ["ollama"]);
		assert.equal(localServers.removeLocalServer("ollama-2").ok, false);
		localServers.removeLocalServer("ollama");
		assert.equal(readSettings()?.localServers, undefined);
	});
});
