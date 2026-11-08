/**
 * Local dictation, server side (issue #15, PR #50): the mutation gate, the
 * model/runtime file routes, the store's temp-file writes, a download
 * (network faked), and the selection after a removal.
 *
 * Runs under an isolated LH_DATA_DIR and an empty LH_AUTH_FILE (no
 * Deepgram key), set before any app module loads.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-dictation-server-"));
const DATA = path.join(TMP, "data");
const AUTH = path.join(TMP, "auth.json");
fs.writeFileSync(AUTH, "{}");
process.env.LH_DATA_DIR = DATA;
process.env.LH_AUTH_FILE = AUTH;
delete process.env.DEEPGRAM_API_KEY;
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const DICTATION = path.join(DATA, "dictation");
const ORIGIN = "http://localhost:3000";
const SAME_ORIGIN = { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" };

type Params<T> = { params: Promise<T> };
let server: typeof import("../src/server/dictation.ts");
let store: typeof import("../src/store/dictation.ts");
let core: typeof import("../src/core/dictation.ts");
let modelsRoute: { POST: (r: Request, c: Params<{ id: string }>) => Promise<Response>; DELETE: (r: Request, c: Params<{ id: string }>) => Promise<Response> };
let methodsRoute: { GET: () => Promise<Response>; PUT: (r: Request) => Promise<Response> };
let filesRoute: { GET: (r: Request, c: Params<{ path: string[] }>) => Promise<Response> };
let runtimeRoute: { GET: (r: Request, c: Params<{ version: string; file: string }>) => Promise<Response> };

before(async () => {
	server = await import("../src/server/dictation.ts");
	store = await import("../src/store/dictation.ts");
	core = await import("../src/core/dictation.ts");
	modelsRoute = await import("../app/api/stt/models/[id]/route.ts");
	methodsRoute = await import("../app/api/stt/methods/route.ts");
	filesRoute = await import("../app/api/stt/files/[...path]/route.ts");
	runtimeRoute = await import("../app/api/stt/runtime/[version]/[file]/route.ts");
});

beforeEach(() => fs.rmSync(DICTATION, { recursive: true, force: true }));

const params = <T>(value: T): Params<T> => ({ params: Promise.resolve(value) });
const request = (url: string, init: RequestInit = {}) => new Request(`${ORIGIN}${url}`, init);

/** A downloaded model on disk: config + exactly the two ONNX files it loads. */
function fakeModel(id: string, bytes = "0123456789"): void {
	const entry = core.LOCAL_DICTATION_MODELS.find((m) => m.id === id)!;
	const dir = path.join(DICTATION, "models", id);
	fs.mkdirSync(path.join(dir, "onnx"), { recursive: true });
	fs.writeFileSync(path.join(dir, "config.json"), "{}");
	for (const f of core.modelOnnxFiles(entry.dtype)) fs.writeFileSync(path.join(dir, f), bytes);
}

function body(text: string): ReadableStream<Uint8Array> {
	return new Response(text).body!;
}

describe("dictation mutations need a same-origin JSON request", () => {
	const post = (headers: Record<string, string>) =>
		modelsRoute.POST(request("/api/stt/models/not-a-model", { method: "POST", headers }), params({ id: "not-a-model" }));

	it("refuses a cross-site no-cors POST before any download starts", async () => {
		assert.equal((await post({})).status, 403, "no Origin");
		assert.equal((await post({ origin: "https://evil.example" })).status, 403, "foreign Origin");
		assert.equal((await post({ origin: "null" })).status, 403, "opaque Origin");
		assert.equal((await post({ ...SAME_ORIGIN, "sec-fetch-site": "cross-site" })).status, 403, "cross-site fetch");
	});

	it("requires a JSON content type", async () => {
		assert.equal((await post({ origin: ORIGIN, "content-type": "text/plain" })).status, 415);
	});

	it("passes a same-origin JSON request through to the handler", async () => {
		assert.equal((await post(SAME_ORIGIN)).status, 404, "unknown model, so the gate let it through");
	});

	it("gates DELETE and PUT the same way", async () => {
		const del = await modelsRoute.DELETE(request("/api/stt/models/moonshine-tiny", { method: "DELETE" }), params({ id: "moonshine-tiny" }));
		assert.equal(del.status, 403);
		const put = await methodsRoute.PUT(request("/api/stt/methods", { method: "PUT", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ device: "cpu" }) }));
		assert.equal(put.status, 403);
		assert.equal(fs.existsSync(path.join(DICTATION, "state.json")), false, "a refused PUT writes nothing");
	});

	it("a same-origin PUT saves the device; an unconfigured pick is refused", async () => {
		const ok = await methodsRoute.PUT(request("/api/stt/methods", { method: "PUT", headers: SAME_ORIGIN, body: JSON.stringify({ device: "cpu" }) }));
		assert.equal(ok.status, 200);
		assert.equal((await ok.json()).device, "cpu");
		assert.equal(JSON.parse(fs.readFileSync(path.join(DICTATION, "state.json"), "utf-8")).device, "cpu");
		const bad = await methodsRoute.PUT(request("/api/stt/methods", { method: "PUT", headers: SAME_ORIGIN, body: JSON.stringify({ selected: "deepgram" }) }));
		assert.equal(bad.status, 400, "no Deepgram key, so Deepgram isn't configured");
	});
});

describe("model file route", () => {
	const get = (segments: string[], headers: Record<string, string> = {}) =>
		filesRoute.GET(request(`/api/stt/files/${segments.join("/")}`, { headers }), params({ path: segments }));

	it("serves a downloaded file, whole or by a single byte range", async () => {
		fakeModel("moonshine-tiny");
		const whole = await get(["moonshine-tiny", "config.json"]);
		assert.equal(whole.status, 200);
		assert.equal(whole.headers.get("content-type"), "application/json");
		assert.equal(await whole.text(), "{}");

		const onnx = ["moonshine-tiny", ...core.modelOnnxFiles(core.LOCAL_DICTATION_MODELS[0]!.dtype)[0].split("/")];
		const probe = await get(onnx, { range: "bytes=0-0" });
		assert.equal(probe.status, 206);
		assert.equal(probe.headers.get("content-range"), "bytes 0-0/10");
		assert.equal(await probe.text(), "0");
		const tail = await get(onnx, { range: "bytes=7-" });
		assert.equal(await tail.text(), "789");
		const backwards = await get(onnx, { range: "bytes=5-2" });
		assert.equal(backwards.status, 416);
		assert.equal(backwards.headers.get("content-range"), "bytes */10");
	});

	it("404s anything outside a downloaded curated model", async () => {
		fakeModel("moonshine-tiny");
		fs.writeFileSync(path.join(DICTATION, "state.json"), "{}");
		assert.equal((await get(["moonshine-tiny", "..", "..", "state.json"])).status, 404, "traversal");
		assert.equal((await get(["moonshine-tiny", "/etc/passwd"])).status, 404, "absolute segment");
		assert.equal((await get(["moonshine-tiny", "onnx"])).status, 404, "a folder");
		assert.equal((await get(["not-a-model", "config.json"])).status, 404, "unknown id");
		assert.equal((await get(["whisper-tiny-en", "config.json"])).status, 404, "not downloaded");
		assert.equal((await get(["moonshine-tiny"])).status, 404, "no file");
	});
});

describe("runtime route", () => {
	const get = (version: string, file: string) =>
		runtimeRoute.GET(request(`/api/stt/runtime/${version}/${file}`), params({ version, file }));

	it("serves the pinned version's cached files with their types", async () => {
		const dir = path.join(DICTATION, "runtime", core.ORT_WEB_VERSION);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "ort-wasm-simd-threaded.asyncify.wasm"), "wasm");
		const res = await get(core.ORT_WEB_VERSION, "ort-wasm-simd-threaded.asyncify.wasm");
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "application/wasm");
		assert.equal(await res.text(), "wasm");
	});

	it("refuses other versions and files without touching the network", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = async () => assert.fail("no fetch for a refused runtime request");
		try {
			assert.equal((await get("1.0.0", "ort-wasm-simd-threaded.asyncify.wasm")).status, 404);
			assert.equal((await get("..", "ort-wasm-simd-threaded.asyncify.wasm")).status, 404);
			assert.equal((await get(core.ORT_WEB_VERSION, "evil.js")).status, 404);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("store temp files", () => {
	const temps = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith(".partial"));

	it("concurrent writers to one file each finish a complete copy", async () => {
		const dest = path.join(DICTATION, "runtime", "x", "file.bin");
		const a = "a".repeat(200_000);
		const b = "b".repeat(200_000);
		await Promise.all([store.streamToFile(body(a), dest), store.streamToFile(body(b), dest)]);
		const result = fs.readFileSync(dest, "utf-8");
		assert.ok(result === a || result === b, "one writer's whole file, never interleaved");
		assert.deepEqual(temps(path.dirname(dest)), []);
	});

	it("a failed stream leaves neither the file nor its temp", async () => {
		const dest = path.join(DICTATION, "runtime", "y", "file.bin");
		const broken = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("partial"));
				controller.error(new Error("connection reset"));
			},
		});
		await assert.rejects(store.streamToFile(broken, dest), /connection reset/);
		assert.equal(fs.existsSync(dest), false);
		assert.deepEqual(temps(path.dirname(dest)), []);
	});
});

describe("download and removal", () => {
	it("downloads exactly the wanted files plus the runtime, then picks the first model", async () => {
		const entry = core.LOCAL_DICTATION_MODELS.find((m) => m.id === "moonshine-base")!;
		const [encoder, decoder] = core.modelOnnxFiles(entry.dtype);
		const tree = [
			{ type: "file", path: "config.json", size: 2 },
			{ type: "file", path: encoder, size: 3 },
			{ type: "file", path: decoder, size: 3 },
			{ type: "file", path: "onnx/encoder_model_fp16.onnx", size: 3 },
			{ type: "file", path: "README.md", size: 3 },
		];
		const fetched: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/api/models/")) return Response.json(tree);
			if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "4" } });
			fetched.push(url);
			return new Response(url.endsWith("config.json") ? "{}" : "bin");
		}) as typeof fetch;
		try {
			assert.equal(server.startDictationModelDownload(entry.id), true);
			const deadline = Date.now() + 5000;
			while (server.dictationStatus().models.find((m) => m.id === entry.id)!.state === "downloading") {
				assert.ok(Date.now() < deadline, "download finished");
				await new Promise((r) => setTimeout(r, 10));
			}
		} finally {
			globalThis.fetch = realFetch;
		}
		const status = server.dictationStatus();
		assert.equal(status.models.find((m) => m.id === entry.id)!.state, "ready");
		assert.equal(status.selected, core.localMethodId(entry.id), "first setup picks the new model");
		assert.equal(fetched.filter((u) => u.includes("huggingface.co")).length, 3, "only config + the two ONNX files");
		assert.ok(!fetched.some((u) => u.includes("fp16") || u.includes("README")));
		for (const f of server.DICTATION_RUNTIME_FILES) {
			assert.ok(fs.existsSync(path.join(DICTATION, "runtime", core.ORT_WEB_VERSION, f)), `runtime ${f} rides along`);
		}
		assert.equal(fs.existsSync(path.join(DICTATION, "models", `${entry.id}.partial`)), false, "staging folder swapped in");
	});

	it("removing the picked model falls back to the next configured one", async () => {
		fakeModel("moonshine-tiny");
		fakeModel("whisper-tiny-en");
		assert.equal(server.selectDictationMethod(core.localMethodId("whisper-tiny-en")), true);
		assert.equal(server.removeDictationModel("whisper-tiny-en"), true);
		const status = server.dictationStatus();
		assert.equal(status.models.find((m) => m.id === "whisper-tiny-en")!.state, "absent");
		assert.equal(status.selected, core.localMethodId("moonshine-tiny"));
		assert.equal(server.removeDictationModel("not-a-model"), false);
	});
});
