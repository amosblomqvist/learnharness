import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCAL_STT_MAX_BYTES } from "../src/core/dictation.ts";
import {
	localSttDownloadResponse,
	localSttRemoveResponse,
	localSttStatusResponse,
	localSttTranscribeResponse,
	type LocalSttDeps,
} from "../src/server/local-stt/http.ts";
import { PARAKEET_V3, type LocalSttModel } from "../src/server/local-stt/model.ts";
import type { LocalTranscriber } from "../src/server/local-stt/runtime.ts";
import type { LocalSttModelState } from "../src/core/dictation.ts";

function deps(state: LocalSttModelState["state"] = "ready", options: { key?: boolean; transcribe?: (dir: string, pcm: Uint8Array) => Promise<string> } = {}) {
	const calls: string[] = [];
	const clips: Uint8Array[] = [];
	let current = state;
	const model = {
		spec: PARAKEET_V3,
		status: () => current === "downloading"
			? { state: "downloading", receivedBytes: 5, totalBytes: 10 }
			: current === "ready" ? { state: "ready", totalBytes: 10 } : { state: "missing", totalBytes: 10 },
		directory: () => current === "ready" ? "/models/parakeet" : null,
		download: async () => { calls.push("download"); current = "downloading"; },
		cancel: () => { calls.push("cancel"); },
		remove: async () => { calls.push("remove"); current = "missing"; },
	} as unknown as LocalSttModel;
	const transcriber = {
		transcribe: async (dir: string, pcm: Uint8Array) => {
			clips.push(pcm);
			return options.transcribe ? options.transcribe(dir, pcm) : `heard ${pcm.byteLength} bytes in ${dir}`;
		},
		stop: async () => { calls.push("stop"); },
	} as unknown as LocalTranscriber;
	const d: LocalSttDeps = { model, transcriber, hasDeepgramKey: () => options.key ?? false };
	return { d, calls, clips };
}

const pcmRequest = (bytes: Uint8Array<ArrayBuffer> | null, type = "application/octet-stream") =>
	new Request("http://127.0.0.1/api/stt/local/transcribe", { method: "POST", headers: { "content-type": type }, body: bytes });

test("status reports the engine-deciding key and the model state, uncached", async () => {
	const { d } = deps("ready", { key: true });
	const res = localSttStatusResponse(d);
	assert.equal(res.headers.get("cache-control"), "no-store");
	assert.deepEqual(await res.json(), {
		deepgramKey: true,
		model: { state: "ready", totalBytes: 10, id: PARAKEET_V3.id, label: "Parakeet v3" },
	});
});

test("download starts in the background and answers with the downloading state", async () => {
	const { d, calls } = deps("missing");
	const body = await localSttDownloadResponse(d).json();
	assert.deepEqual(calls, ["download"]);
	assert.equal(body.model.state, "downloading");
});

test("delete cancels a download, or stops the child before removing the model", async () => {
	const downloading = deps("downloading");
	await localSttRemoveResponse(downloading.d);
	assert.deepEqual(downloading.calls, ["cancel"]);
	const ready = deps("ready");
	const body = await (await localSttRemoveResponse(ready.d)).json();
	assert.deepEqual(ready.calls, ["stop", "remove"]);
	assert.equal(body.model.state, "missing");
});

test("transcribe passes raw PCM to the model directory and returns the text", async () => {
	const { d, clips } = deps();
	const res = await localSttTranscribeResponse(pcmRequest(new Uint8Array([1, 0, 2, 0])), d);
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { text: "heard 4 bytes in /models/parakeet" });
	assert.deepEqual([...clips[0]!], [1, 0, 2, 0]);
});

test("transcribe refuses the wrong type, a missing model, odd bytes, and oversize clips", async () => {
	const ready = deps();
	assert.equal((await localSttTranscribeResponse(pcmRequest(new Uint8Array(2), "text/plain"), ready.d)).status, 415);
	assert.equal((await localSttTranscribeResponse(pcmRequest(new Uint8Array(3)), ready.d)).status, 400);
	const tooBig = await localSttTranscribeResponse(pcmRequest(new Uint8Array(LOCAL_STT_MAX_BYTES + 2)), ready.d);
	assert.equal(tooBig.status, 413);
	assert.match((await tooBig.json()).error, /10 minutes/);
	assert.equal((await localSttTranscribeResponse(pcmRequest(new Uint8Array(LOCAL_STT_MAX_BYTES)), ready.d)).status, 200);
	assert.equal(ready.clips.length, 1);
	const missing = deps("missing");
	assert.equal((await localSttTranscribeResponse(pcmRequest(new Uint8Array(2)), missing.d)).status, 409);
	assert.equal(missing.clips.length, 0);
});

test("an empty clip is an empty transcript; an engine failure is a 500 with its message", async () => {
	const empty = deps();
	assert.deepEqual(await (await localSttTranscribeResponse(pcmRequest(null), empty.d)).json(), { text: "" });
	assert.equal(empty.clips.length, 0);
	const failing = deps("ready", { transcribe: async () => { throw new Error("On-device dictation stopped unexpectedly (signal SIGSEGV)"); } });
	const res = await localSttTranscribeResponse(pcmRequest(new Uint8Array(2)), failing.d);
	assert.equal(res.status, 500);
	assert.deepEqual(await res.json(), { error: "On-device dictation stopped unexpectedly (signal SIGSEGV)" });
});
