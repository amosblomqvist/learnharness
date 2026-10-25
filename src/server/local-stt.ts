/**
 * Local dictation — the keyless engine (macOS, Apple Silicon).
 *
 * A long-lived child process, native/parakeet-stt (Swift + FluidAudio),
 * runs Parakeet TDT 0.6B on the Neural Engine. The renderer captures the
 * same linear16 16 kHz mono frames it streams to Deepgram, but holds them
 * for the run and POSTs the whole utterance to /api/stt/local when the run
 * ends — dictation is deferred anyway (the transcript lands once, at the
 * end), so one batch pass costs no felt latency (~0.7 s for 200 s of
 * audio on an M-series chip) and transcribes better than chunked streaming.
 *
 * Models live in FluidAudio's shared cache (~/Library/Application Support/
 * FluidAudio/Models): a Mac that already runs a FluidAudio app (FluidVoice,
 * VoiceInk, Spokenly, …) reuses its Parakeet download; otherwise the first
 * run downloads ~600 MB once. See the helper's header for the protocol.
 *
 * Lifecycle: spawned lazily by warm() (the client's availability probe at
 * dictation start, so the model loads while the learner is still talking),
 * one instance per server process (globalThis anchor, HMR-safe), requests
 * FIFO over stdio, killed after IDLE_MS without a request (the loaded model
 * holds several hundred MB) and respawned on the next run. A crash rejects
 * whatever was in flight; the next request respawns.
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../config.ts";

/** The helper's dev build output (`npm run stt:build`). The desktop app
 *  points LH_LOCAL_STT_BIN at its bundled copy instead (electron/main.cjs). */
export const DEV_LOCAL_STT_BIN = path.join(ROOT, "native", "parakeet-stt", ".build", "release", "lh-parakeet-stt");

/** Idle shutdown: the loaded model is large; a respawn costs a few seconds
 *  of load, which the next run's warm-at-start hides behind speech. */
export const IDLE_MS = 15 * 60_000;

/** Upload cap: 30 minutes of linear16 16 kHz mono. */
export const MAX_PCM_BYTES = 30 * 60 * 16_000 * 2;

export type LocalSttState = "stopped" | "loading" | "ready";

export interface LocalSttStatus {
	available: boolean;
	state: LocalSttState;
	/** Which Parakeet the helper loaded ("v2" English, "v3" multilingual). */
	model?: string;
	/** The last boot failure, if the most recent spawn died before ready. */
	error?: string;
}

type HelperLine = { type: "ready"; model: string } | { type: "result"; text: string } | { type: "error"; message: string };

/** Parse one stdout line; anything that isn't a protocol object is ignored
 *  (the helper routes library logs to stderr, this is belt-and-braces). */
export function parseHelperLine(line: string): HelperLine | null {
	try {
		const msg = JSON.parse(line) as Partial<HelperLine> & Record<string, unknown>;
		if (msg.type === "ready" && typeof msg.model === "string") return { type: "ready", model: msg.model };
		if (msg.type === "result" && typeof msg.text === "string") return { type: "result", text: msg.text };
		if (msg.type === "error" && typeof msg.message === "string") return { type: "error", message: msg.message };
	} catch {
		/* not JSON — ignore */
	}
	return null;
}

/** One request frame: u32 little-endian byte length, then the PCM. */
export function frameRequest(pcm: Uint8Array): Buffer {
	const header = Buffer.alloc(4);
	header.writeUInt32LE(pcm.byteLength, 0);
	return Buffer.concat([header, pcm]);
}

export interface LocalSttDeps {
	bin: string;
	platform: NodeJS.Platform;
	arch: string;
	exists: (file: string) => boolean;
	spawn: (bin: string) => ChildProcessWithoutNullStreams;
	idleMs: number;
}

export function createLocalStt(deps: LocalSttDeps) {
	let child: ChildProcessWithoutNullStreams | null = null;
	let ready: Promise<void> | null = null;
	let state: LocalSttState = "stopped";
	let model: string | undefined;
	let bootError: string | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	const queue: Array<{ resolve: (text: string) => void; reject: (e: Error) => void }> = [];

	const available = () => deps.platform === "darwin" && deps.arch === "arm64" && deps.exists(deps.bin);

	function armIdle() {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			if (queue.length === 0) child?.kill();
		}, deps.idleMs);
		idleTimer.unref?.();
	}

	function boot(): Promise<void> {
		if (ready) return ready;
		const proc = deps.spawn(deps.bin);
		child = proc;
		state = "loading";
		bootError = undefined;
		let stderrTail = "";
		let pending = "";
		ready = new Promise<void>((resolve, reject) => {
			proc.stdout.setEncoding("utf8");
			proc.stdout.on("data", (chunk: string) => {
				pending += chunk;
				let nl: number;
				while ((nl = pending.indexOf("\n")) >= 0) {
					const msg = parseHelperLine(pending.slice(0, nl));
					pending = pending.slice(nl + 1);
					if (!msg) continue;
					if (msg.type === "ready") {
						state = "ready";
						model = msg.model;
						resolve();
					} else if (state !== "ready" && msg.type === "error") {
						bootError = msg.message; // fatal boot error — exit follows
					} else if (msg.type === "result") {
						queue.shift()?.resolve(msg.text);
						armIdle();
					} else if (msg.type === "error") {
						queue.shift()?.reject(new Error(msg.message));
						armIdle();
					}
				}
			});
			// A write racing the helper's death raises EPIPE here; the exit
			// handler below is what rejects the in-flight request.
			proc.stdin.on("error", () => {});
			proc.stderr.setEncoding("utf8");
			proc.stderr.on("data", (chunk: string) => {
				stderrTail = (stderrTail + chunk).slice(-2000);
			});
			const die = (reason: string) => {
				if (child !== proc) return;
				child = null;
				ready = null;
				state = "stopped";
				if (idleTimer) clearTimeout(idleTimer);
				const err = new Error(bootError ?? reason);
				for (const q of queue.splice(0)) q.reject(err);
				reject(err);
			};
			proc.on("error", (e) => die(`local dictation helper failed to start: ${e.message}`));
			proc.on("exit", (code, signal) => {
				const tail = stderrTail.trim().split("\n").pop();
				die(`local dictation helper exited (${signal ?? code})${tail ? `: ${tail}` : ""}`);
			});
		});
		ready.catch(() => {}); // surfaced through transcribe()/status
		armIdle();
		return ready;
	}

	return {
		status(): LocalSttStatus {
			return { available: available(), state, model, error: bootError };
		},
		/** Start the helper (if needed) without waiting for it. */
		warm(): void {
			if (available()) void boot();
		},
		async transcribe(pcm: Uint8Array): Promise<string> {
			if (!available()) throw new Error("Local dictation is unavailable on this machine");
			await boot();
			const proc = child;
			if (!proc) throw new Error(bootError ?? "local dictation helper is not running");
			armIdle();
			return new Promise<string>((resolve, reject) => {
				queue.push({ resolve, reject });
				proc.stdin.write(frameRequest(pcm));
			});
		},
		stop(): void {
			child?.kill();
		},
	};
}

export type LocalStt = ReturnType<typeof createLocalStt>;

const STT_KEY = Symbol.for("lh.localStt");

/** The process-wide engine (globalThis anchor — HMR re-imports must not
 *  orphan a running helper). */
export function localStt(): LocalStt {
	const g = globalThis as Record<symbol, LocalStt | undefined>;
	if (!g[STT_KEY]) {
		g[STT_KEY] = createLocalStt({
			bin: process.env.LH_LOCAL_STT_BIN || DEV_LOCAL_STT_BIN,
			platform: process.platform,
			arch: process.arch,
			exists: (file) => fs.existsSync(file),
			spawn: (bin) => nodeSpawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] }),
			idleMs: IDLE_MS,
		});
	}
	return g[STT_KEY];
}
