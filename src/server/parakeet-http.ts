/**
 * HTTP surface for local dictation, with the model and transcriber injected
 * so the behavior is testable without a model: status, start download,
 * remove (which also cancels a running download), and transcribe.
 */
import type { ParakeetModelStatus } from "./parakeet-model.ts";
import { ParakeetNotReadyError } from "./parakeet-transcriber.ts";

export interface ParakeetHandlerDeps {
	model: {
		status(): ParakeetModelStatus;
		download(): Promise<void>;
		remove(): Promise<void>;
	};
	transcriber: {
		transcribe(pcm: Uint8Array): Promise<string>;
		unload<T>(task: () => Promise<T>): Promise<T>;
	};
	maxAudioBytes: number;
}

const json = (body: unknown, status = 200) =>
	Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** State-changing routes refuse requests a browser marks as cross-site: a
 * web page must not be able to start a 487 MB download or read dictation. */
const crossSite = (req: Request) => req.headers.get("sec-fetch-site") === "cross-site";
const forbidden = () => json({ message: "Cross-site requests are not allowed" }, 403);

/** Read the request body as a stream and give up the moment it crosses the
 * limit, so an oversized (or lying) upload is never buffered whole. */
async function readBounded(req: Request, limit: number): Promise<Uint8Array | "too-large" | "unreadable"> {
	if (!req.body) return new Uint8Array(0);
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel().catch(() => {});
				return "too-large";
			}
			chunks.push(value);
		}
	} catch {
		return "unreadable";
	}
	const pcm = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) { pcm.set(chunk, at); at += chunk.byteLength; }
	return pcm;
}

export function createParakeetHandlers({ model, transcriber, maxAudioBytes }: ParakeetHandlerDeps) {
	return {
		async status() {
			return json(model.status());
		},

		async startDownload(req: Request) {
			if (crossSite(req)) return forbidden();
			const done = model.download();
			done.catch(() => {}); // the failure is read back through status().error
			const status = model.status();
			return json(status, status.state === "ready" ? 200 : 202);
		},

		async remove(req: Request) {
			if (crossSite(req)) return forbidden();
			// Unload first: Windows can refuse to delete files a loaded model holds.
			await transcriber.unload(() => model.remove());
			return json(model.status());
		},

		/** Body: raw mono 16 kHz signed 16-bit little-endian PCM. */
		async transcribe(req: Request) {
			if (crossSite(req)) return forbidden();
			const declared = Number(req.headers.get("content-length"));
			if (declared > maxAudioBytes) return json({ message: "Recording is too long to transcribe" }, 413);
			const body = await readBounded(req, maxAudioBytes);
			if (body === "too-large") return json({ message: "Recording is too long to transcribe" }, 413);
			if (body === "unreadable") return json({ message: "Could not read the recording" }, 400);
			const pcm = body;
			try {
				return json({ text: await transcriber.transcribe(pcm) });
			} catch (error) {
				if (error instanceof ParakeetNotReadyError) {
					return json({ code: "not-ready", message: error.message }, 409);
				}
				if (error instanceof RangeError) return json({ message: error.message }, 400);
				// The client shows a generic line for a 500; the reason lands in the log.
				console.error("[parakeet] transcription failed:", error);
				return json({ message: error instanceof Error ? error.message : "Transcription failed" }, 500);
			}
		},
	};
}
