import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, test } from "node:test";
import { dictationWav, localDictationBaseUrl, localDictationEndpoint, parseLocalDictation, validDictationWav, LOCAL_DICTATION_AUTH, LOCAL_DICTATION_MAX_BYTES } from "../src/core/local-dictation.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";

const directory = mkdtempSync(path.join(tmpdir(), "lh-local-dictation-"));
process.env.LH_DATA_DIR = directory;
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
after(() => rmSync(directory, { recursive: true, force: true }));
const { transcribeLocal, localDictationPost, dictationCredentialsGet, dictationCredentialsPut, localDictationDelete, localDictationTestPost } = await import("../src/server/local-dictation.ts");
const { readDictationAuth, writeDictationAuth } = await import("../src/store/auth.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { resolveKeyStatuses } = await import("../src/server/keys.ts");
const local = { server: "llama.cpp" as const, url: "http://localhost:8080/v1/audio/transcriptions", model: "lfm3" };
const wav = dictationWav([new Int16Array([0, -32768, 32767]).buffer]);

test("WAV encoding preserves PCM samples and validates the exact upload contract", () => {
	assert(validDictationWav(wav));
	assert.equal(new DataView(wav.buffer).getInt16(46, true), -32768);
	const broken = wav.slice(); broken[24] = 1;
	assert(!validDictationWav(broken));
	assert(!validDictationWav(new Uint8Array(44)));
	assert.throws(() => dictationWav([]), /empty/);
	assert.throws(() => dictationWav([new ArrayBuffer(LOCAL_DICTATION_MAX_BYTES)]), /limit/);
});

test("local settings validate independently of cloud language and survive sanitization", () => {
	const dictation = { provider: "local", language: "multi", local };
	assert.deepEqual(parseDictationSettingsBody(dictation), { ok: true, settings: dictation });
	assert.deepEqual(sanitizeUserSettings({ version: 1, dictation })?.dictation, dictation);
	assert.deepEqual(parseDictationSettingsBody({ provider: "local" }), { ok: true, settings: { provider: "local" } });
	for (const url of ["file:///tmp/test", "http://user:password@localhost/inference", "http://localhost/inference?key=secret"]) assert.equal(parseLocalDictation({ ...local, url }), undefined);
	assert.equal(parseLocalDictation({ ...local, language: "multi" }), undefined);
});

for (const server of ["llama.cpp", "whisper.cpp"] as const) test(`${server} receives WAV multipart with correct language and model`, async () => {
	const url = server === "llama.cpp" ? local.url : "http://localhost:8081/inference";
	for (const language of [undefined, "auto", "fr"]) {
		const text = await transcribeLocal(wav, { server, url, model: "speech", language }, "secret", new AbortController().signal, async (input, init) => {
			assert.equal(input, url); assert.equal(init?.redirect, "manual");
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
			assert(init?.body instanceof FormData);
			assert.equal(init.body.get("model"), "speech");
			assert.equal(init.body.get("response_format"), "json");
			assert.equal(init.body.get("language"), language === "fr" ? "fr" : server === "whisper.cpp" ? "auto" : null);
			const file = init.body.get("file"); assert(file instanceof Blob);
			assert.deepEqual(new Uint8Array(await file.arrayBuffer()), wav);
			return Response.json({ type: "transcript.text.done", text: " Bonjour " });
		});
		assert.equal(text, "Bonjour");
	}
});

for (const server of ["llama.cpp", "whisper.cpp"] as const) test(`${server} resolves base URLs and legacy endpoints without losing proxy prefixes`, async () => {
	const suffix = server === "llama.cpp" ? "/v1/audio/transcriptions" : "/inference";
	for (const prefix of ["", "/speech/proxy"]) {
		const base = `http://localhost:8080${prefix}`;
		for (const url of [base, `${base}/`, `${base}${suffix}`, `${base}${suffix}/`]) {
			const config = { server, url };
			assert.equal(localDictationBaseUrl(config), base);
			assert.equal(localDictationEndpoint(config), base + suffix);
			await transcribeLocal(wav, config, undefined, new AbortController().signal, async (input) => {
				assert.equal(input, base + suffix);
				return Response.json({ text: "recognized words" });
			});
		}
	}
});

test("endpoint failures, redirects, invalid and oversized responses remain explicit", async () => {
	for (const response of [new Response("secret error", { status: 401 }), new Response(null, { status: 302 }), Response.json({ unrelated: "bad" }), new Response("x", { headers: { "content-length": String(2 * 1024 * 1024) } })]) {
		await assert.rejects(transcribeLocal(wav, local, undefined, new AbortController().signal, async () => response));
	}
});

test("private bearer credentials are endpoint-bound, redacted, and excluded from key inventory", async () => {
	writeSettings({ version: 1, dictation: { provider: "local", local } });
	const put = (origin: string) => dictationCredentialsPut(new Request("http://localhost/api/stt/credentials", {
		method: "PUT", headers: { origin, host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ url: local.url, key: "secret-key" }),
	}));
	assert.equal((await put("http://foreign.invalid")).status, 403);
	assert.equal((await put("http://localhost")).status, 200);
	assert.deepEqual(readDictationAuth(), { url: local.url, key: "secret-key" });
	assert.deepEqual(await dictationCredentialsGet().json(), { keyPresent: true });
	assert(!resolveKeyStatuses({ [LOCAL_DICTATION_AUTH]: "secret-key" }, {}, new Set()).some((row) => row.id === LOCAL_DICTATION_AUTH));
	writeSettings({ version: 1, dictation: { provider: "local", local: { ...local, url: "http://localhost:9999/inference" } } });
	assert.deepEqual(await dictationCredentialsGet().json(), { keyPresent: false });
});

test("base URL credentials remain bound to the resolved server endpoint and preserve legacy keys", async () => {
	const base = "http://localhost:8080/speech";
	const config = { ...local, url: base };
	writeDictationAuth(`${base}/v1/audio/transcriptions`, "legacy-key");
	writeSettings({ version: 1, dictation: { provider: "local", local: config } });
	assert.deepEqual(await dictationCredentialsGet().json(), { keyPresent: true });
	const response = await dictationCredentialsPut(new Request("http://localhost/api/stt/credentials", {
		method: "PUT", headers: { origin: "http://localhost", host: "localhost", "content-type": "application/json" },
		body: JSON.stringify({ server: "llama.cpp", url: `${base}/`, key: "replacement-key" }),
	}));
	assert.equal(response.status, 200);
	assert.deepEqual(readDictationAuth(), { url: `${base}/v1/audio/transcriptions`, key: "replacement-key" });
	writeSettings({ version: 1, dictation: { provider: "local", local: { ...config, server: "whisper.cpp" } } });
	assert.deepEqual(await dictationCredentialsGet().json(), { keyPresent: false });
});

function connectionRequest(body: unknown = local, origin = "http://localhost", signal?: AbortSignal) {
	return new Request("http://localhost/api/stt/test", {
		method: "POST", headers: { origin, host: "localhost", "content-type": "application/json" },
		body: JSON.stringify(body), signal,
	});
}

test("connection tests probe draft health URLs and use only endpoint-bound keys without saving", async () => {
	const { readSettings } = await import("../src/store/settings.ts");
	const saved = { version: 1, dictation: { provider: "local" as const, local } };
	writeSettings(saved);
	writeDictationAuth(local.url, "saved-secret");
	for (const config of [local, { ...local, url: "http://localhost:9999/proxy/" }, { ...local, server: "whisper.cpp" as const, url: "http://localhost:8080" }]) {
		for (const key of [undefined, "draft-secret"]) {
			const response = await localDictationTestPost(connectionRequest({ ...config, key }), async (input, init) => {
				assert.equal(input, `${localDictationBaseUrl(config)}/health`);
				assert.equal(init?.method, "GET");
				assert.equal(init.body, undefined);
				assert.equal(init.redirect, "manual");
				assert.equal(new Headers(init.headers).get("authorization"), key ? "Bearer draft-secret" : config === local ? "Bearer saved-secret" : null);
				return Response.json({ status: "ok" });
			});
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { status: "ready" });
		}
	}
	assert.deepEqual(readSettings(), saved);
	assert.deepEqual(readDictationAuth(), { url: local.url, key: "saved-secret" });
});

test("connection tests distinguish loading, authentication, invalid responses and unreachable servers", async () => {
	for (const health of [{ status: "loading model" }, { error: { message: "Loading model" } }]) {
		const response = await localDictationTestPost(connectionRequest(), async () => Response.json(health, { status: 503 }));
		assert.deepEqual(await response.json(), { status: "loading" });
	}
	for (const status of [401, 403, 404, 302, 503]) {
		const response = await localDictationTestPost(connectionRequest(), async () => Response.json({ status: "unavailable", secret: "must not leak" }, { status }));
		assert.equal(response.status, 502);
		const body = await response.json();
		assert.match(body.error, status === 401 || status === 403 ? /authentication/ : status === 503 ? /did not report/ : new RegExp(String(status)));
		assert(!JSON.stringify(body).includes("must not leak"));
	}
	for (const upstream of [new Response("<html>Other server</html>"), Response.json({ unrelated: true })]) {
		assert.equal((await localDictationTestPost(connectionRequest(), async () => upstream)).status, 502);
	}
	const unreachable = await localDictationTestPost(connectionRequest(), async () => { throw new TypeError("fetch failed"); });
	assert.match((await unreachable.json()).error, /base URL and port/);
});

test("connection tests reject foreign origins and invalid drafts before contacting a server", async () => {
	let calls = 0;
	const probe: typeof fetch = async () => { calls++; return Response.json({ status: "ok" }); };
	assert.equal((await localDictationTestPost(connectionRequest(local, "http://foreign.invalid"), probe)).status, 403);
	for (const body of [{ ...local, url: "file:///tmp/model" }, { ...local, key: "bad\nkey" }, { ...local, server: "other" }]) {
		assert.equal((await localDictationTestPost(connectionRequest(body), probe)).status, 400);
	}
	assert.equal(calls, 0);
});

test("connection test times out after five seconds and cancels the upstream request", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let started!: () => void;
	const probing = new Promise<void>((resolve) => { started = resolve; });
	const pending = localDictationTestPost(connectionRequest(), async (_input, init) => {
		return new Promise<Response>((_resolve, reject) => {
			init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
			started();
		});
	});
	await probing;
	context.mock.timers.tick(5_000);
	const response = await pending;
	assert.equal(response.status, 504);
	assert.match((await response.json()).error, /5 seconds/);
});

test("upload rejects changed configuration, oversized bodies, invalid WAV, and foreign origins", async () => {
	writeSettings({ version: 1, dictation: { provider: "local", local } });
	const request = (config: unknown, data = wav, extra: Record<string, string> = {}) => new Request("http://localhost/api/stt/transcribe", {
		method: "POST", body: data, headers: { host: "localhost", origin: "http://localhost", "x-dictation-config": encodeURIComponent(JSON.stringify(config)), ...extra },
	});
	assert.equal((await localDictationPost(request({ ...local, model: "different" }))).status, 409);
	assert.equal((await localDictationPost(request(local, wav, { "content-length": String(LOCAL_DICTATION_MAX_BYTES + 1) }))).status, 413);
	assert.equal((await localDictationPost(request(local, new Uint8Array(44)))).status, 400);
	assert.equal((await localDictationPost(request(local, wav, { origin: "http://foreign.invalid" }))).status, 403);
});

test("route uploads multipart to both HTTP server formats and never forwards a key to a changed endpoint", async () => {
	const received: { path: string; key?: string; language: FormDataEntryValue | null; model: FormDataEntryValue | null }[] = [];
	const server = createServer(async (request, response) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers["content-type"]! } }).formData();
			const file = form.get("file"); assert(file instanceof Blob);
			assert.deepEqual(new Uint8Array(await file.arrayBuffer()), wav);
			received.push({ path: request.url!, key: request.headers.authorization, language: form.get("language"), model: form.get("model") });
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ text: "recognized words" }));
		} catch { response.writeHead(500); response.end(); }
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	try {
		writeDictationAuth(`${base}/v1/audio/transcriptions`, "only-for-llama");
		for (const backend of ["llama.cpp", "whisper.cpp"] as const) {
			const config = { server: backend, url: `${base}${backend === "llama.cpp" ? "/v1/audio/transcriptions" : "/inference"}`, ...(backend === "llama.cpp" ? { model: "lfm3" } : {}) };
			writeSettings({ version: 1, dictation: { provider: "local", local: config } });
			const result = await localDictationPost(new Request("http://localhost/api/stt/transcribe", {
				method: "POST", body: wav, headers: { host: "localhost", origin: "http://localhost", "x-dictation-config": encodeURIComponent(JSON.stringify(config)) },
			}));
			assert.equal(result.status, 200); assert.deepEqual(await result.json(), { text: "recognized words" });
		}
		assert.deepEqual(received, [
			{ path: "/v1/audio/transcriptions", key: "Bearer only-for-llama", language: null, model: "lfm3" },
			{ path: "/inference", key: undefined, language: "auto", model: null },
		]);
	} finally { server.close(); await once(server, "close"); }
});


function deleteRequest(config: unknown = local, origin = "http://localhost") {
	return new Request("http://localhost/api/stt/local", { method: "DELETE", headers: { host: "localhost", origin, "content-type": "application/json" }, body: JSON.stringify({ local: config }) });
}

test("Delete removes configuration and private key, preserves active provider and unrelated settings", async () => {
	const { readSettings } = await import("../src/store/settings.ts");
	for (const provider of ["local", "deepgram"] as const) {
		writeSettings({ version: 1, general: { autoUpdate: false }, dictation: { provider, language: "multi", local } });
		writeDictationAuth(local.url, "local-key");
		assert.equal((await localDictationDelete(deleteRequest(local, "http://foreign.invalid"))).status, 403);
		assert.equal((await localDictationDelete(deleteRequest({ ...local, model: "stale-model" }))).status, 409);
		assert(readSettings()?.dictation?.local);
		const response = await localDictationDelete(deleteRequest());
		assert.equal(response.status, 200);
		const expected = { version: 1, general: { autoUpdate: false }, dictation: { provider, language: "multi" } };
		assert.deepEqual(await response.json(), { settings: expected });
		assert.deepEqual(readSettings(), expected);
		assert.equal(readDictationAuth(), undefined);
	}
});

test("Delete leaves both records unchanged on settings failure and rolls back a credential failure", async () => {
	const original = { version: 1, dictation: { provider: "local" as const, language: "pl" as const, local } };
	for (const fail of ["settings", "key", "read-key"] as const) {
		let record: import("../src/core/settings.ts").UserSettings = original;
		let credential = { url: local.url, key: "private-key" };
		const response = await localDictationDelete(deleteRequest(), {
			readSettings: () => record,
			writeSettings: (next) => { if (fail === "settings") throw new Error("disk unavailable"); record = next; return next; },
			readAuth: () => { if (fail === "read-key") throw new Error("corrupt private storage"); return credential; },
			writeAuth: () => { if (fail === "key") throw new Error("credential write failed"); credential = { url: "", key: "" }; },
		});
		assert.equal(response.status, 500, fail);
		assert.deepEqual(record, original, fail);
		assert.equal(credential.key, "private-key", fail);
	}
});
