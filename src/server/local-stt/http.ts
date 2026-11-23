/**
 * Route handlers for on-device dictation (app/api/stt/local/**). proxy.ts
 * gates every method under /api, so these add only shape checks. Handlers
 * take their dependencies so tests run them without a model or a child.
 */
import path from "node:path";
import { DICTATION_MODELS_DIR } from "../../../config.ts";
import { keyValue } from "../keys.ts";
import { LOCAL_STT_MAX_BYTES, LOCAL_STT_MAX_SECONDS, type LocalSttStatus } from "../../core/dictation.ts";
import { createLocalSttModel, PARAKEET_V3, type LocalSttModel } from "./model.ts";
import { createLocalTranscriber, type LocalTranscriber } from "./runtime.ts";

export interface LocalSttDeps {
	model: LocalSttModel;
	transcriber: LocalTranscriber;
	hasDeepgramKey: () => boolean;
}

// One model and one child per server process, safe across dev hot reloads.
const GLOBAL_KEY = Symbol.for("learnharness.localStt");
export function localSttDeps(): LocalSttDeps {
	const store = globalThis as unknown as Record<symbol, LocalSttDeps | undefined>;
	return (store[GLOBAL_KEY] ??= {
		model: createLocalSttModel({ spec: PARAKEET_V3, dir: path.join(/* turbopackIgnore: true */ DICTATION_MODELS_DIR, PARAKEET_V3.id) }),
		transcriber: createLocalTranscriber(),
		hasDeepgramKey: () => Boolean(keyValue("DEEPGRAM_API_KEY")),
	});
}

const noStore = { "Cache-Control": "no-store" };

export function localSttStatus(deps: LocalSttDeps = localSttDeps()): LocalSttStatus {
	return {
		deepgramKey: deps.hasDeepgramKey(),
		model: { ...deps.model.status(), id: deps.model.spec.id, label: deps.model.spec.label },
	};
}

export function localSttStatusResponse(deps: LocalSttDeps = localSttDeps()): Response {
	return Response.json(localSttStatus(deps), { headers: noStore });
}

/** Starts the download and answers at once; progress is read from status. */
export function localSttDownloadResponse(deps: LocalSttDeps = localSttDeps()): Response {
	deps.model.download().catch(() => {
		// Kept as the status's error (or a cancel); nothing awaits this here.
	});
	return localSttStatusResponse(deps);
}

/** Cancels a download in progress, or removes the installed model. */
export async function localSttRemoveResponse(deps: LocalSttDeps = localSttDeps()): Promise<Response> {
	if (deps.model.status().state === "downloading") deps.model.cancel();
	else {
		await deps.transcriber.stop();
		await deps.model.remove();
	}
	return localSttStatusResponse(deps);
}

async function readBounded(req: Request, limit: number): Promise<Uint8Array | null> {
	if (!req.body) return new Uint8Array(0);
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

/** Body: raw mono 16 kHz signed 16-bit little-endian PCM. Answers {text}. */
export async function localSttTranscribeResponse(req: Request, deps: LocalSttDeps = localSttDeps()): Promise<Response> {
	const type = req.headers.get("content-type") ?? "";
	if (!type.startsWith("application/octet-stream")) {
		return Response.json({ error: "body must be application/octet-stream PCM" }, { status: 415, headers: noStore });
	}
	const dir = deps.model.directory();
	if (!dir) return Response.json({ error: "The on-device speech model is not downloaded" }, { status: 409, headers: noStore });
	const pcm = await readBounded(req, LOCAL_STT_MAX_BYTES);
	if (!pcm) return Response.json({ error: `Recordings are limited to ${LOCAL_STT_MAX_SECONDS / 60} minutes` }, { status: 413, headers: noStore });
	if (pcm.byteLength % 2 !== 0) return Response.json({ error: "Audio must be 16-bit PCM samples" }, { status: 400, headers: noStore });
	if (pcm.byteLength === 0) return Response.json({ text: "" }, { headers: noStore });
	try {
		return Response.json({ text: await deps.transcriber.transcribe(dir, pcm) }, { headers: noStore });
	} catch (error) {
		const message = error instanceof Error ? error.message : "On-device transcription failed";
		return Response.json({ error: message.slice(0, 300) }, { status: 500, headers: noStore });
	}
}
