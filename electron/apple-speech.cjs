"use strict";
/*
 * Apple on-device dictation (SpeechAnalyzer, macOS 26+): the main-process
 * side of the native helper (native/apple-speech/main.swift).
 *
 * The renderer keeps its capture graph (worklet → linear16 16 kHz mono);
 * only the transport differs from Deepgram: frames arrive over IPC and go
 * to the helper's stdin, final results come back as JSON lines on stdout,
 * and the stop path closes stdin (the helper finalizes, then exits). A
 * child process isolates crashes in Apple's framework from the main
 * process, and it is independent of the Electron ABI.
 *
 * One transcription session at a time (one window, one dictation). One
 * model install at a time; its progress is broadcast so the dictation bar
 * and Settings show the same download.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");

/** SpeechAnalyzer shipped in macOS 26 (the minimum, not an exact match). */
const MIN_MACOS_MAJOR = 26;

/** Split a byte stream into JSON lines; malformed lines are dropped. */
function jsonLines(onValue) {
	let pending = "";
	return (chunk) => {
		pending += chunk.toString("utf8");
		let index;
		while ((index = pending.indexOf("\n")) >= 0) {
			const line = pending.slice(0, index).trim();
			pending = pending.slice(index + 1);
			if (!line) continue;
			try {
				onValue(JSON.parse(line));
			} catch { /* not a protocol line */ }
		}
	};
}

/** Host gate: macOS 26+ on Apple silicon, with the helper present. */
function hostSupported({ platform, arch, systemVersion, helperPath, exists }) {
	if (platform !== "darwin" || arch !== "arm64") return false;
	const major = Number.parseInt(String(systemVersion).split(".")[0], 10);
	return Number.isFinite(major) && major >= MIN_MACOS_MAJOR && exists(helperPath);
}

function createAppleSpeech({
	helperPath,
	platform = process.platform,
	arch = process.arch,
	systemVersion = typeof process.getSystemVersion === "function" ? process.getSystemVersion() : "0",
	exists = fs.existsSync,
	spawnImpl = spawn,
	broadcast = () => {},
}) {
	const supported = () => hostSupported({ platform, arch, systemVersion, helperPath, exists });
	let install = null; // { promise, fraction }
	let session = null; // { id, child, send }
	let nextSession = 1;

	/** Run a one-shot subcommand; resolves with every JSON line it wrote. */
	function run(command, onValue = () => {}) {
		return new Promise((resolve, reject) => {
			const child = spawnImpl(helperPath, [command], { stdio: ["ignore", "pipe", "pipe"] });
			const values = [];
			let stderr = "";
			child.stdout.on("data", jsonLines((value) => {
				values.push(value);
				onValue(value);
			}));
			child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
			child.on("error", reject);
			child.on("close", (code) => {
				const error = values.find((value) => value?.type === "error");
				if (code === 0 && !error) resolve(values);
				else reject(new Error(error?.message || stderr.trim() || `apple-speech ${command} exited ${code}`));
			});
		});
	}

	async function status() {
		if (!supported()) return { available: false };
		const [value] = await run("status");
		if (!value?.available) return { available: false };
		const result = {
			available: true,
			locale: String(value.locale),
			language: String(value.language),
			model: value.model,
			reserved: value.reserved === true,
		};
		if (install) return { ...result, model: "downloading", progress: install.fraction };
		return result;
	}

	function installModel() {
		if (!supported()) return Promise.reject(new Error("Apple dictation needs macOS 26 or later."));
		if (install) return install.promise;
		const state = { fraction: 0, promise: null };
		state.promise = run("install", (value) => {
			if (value?.type !== "progress" || typeof value.fraction !== "number") return;
			state.fraction = Math.max(0, Math.min(1, value.fraction));
			broadcast({ type: "progress", fraction: state.fraction });
		})
			.then(() => {
				install = null;
				broadcast({ type: "done" });
			})
			.catch((err) => {
				install = null;
				broadcast({ type: "error", message: err.message });
				throw err;
			});
		install = state;
		broadcast({ type: "progress", fraction: 0 });
		return state.promise;
	}

	/** Kill the live session's helper (no flush). */
	function cancel(id) {
		if (!session || (id !== undefined && session.id !== id)) return;
		const { child } = session;
		session = null;
		child.kill("SIGKILL");
	}

	/** Start transcribing; `send` receives this session's events. */
	function start(send) {
		if (!supported()) throw new Error("Apple dictation needs macOS 26 or later.");
		cancel();
		const id = nextSession++;
		const child = spawnImpl(helperPath, ["transcribe"], { stdio: ["pipe", "pipe", "pipe"] });
		const current = { id, child };
		session = current;
		let stderr = "";
		let ended = false;
		const deliver = (event) => send({ session: id, ...event });
		child.stdin.on("error", () => { /* EPIPE after the helper exits */ });
		child.stdout.on("data", jsonLines((value) => {
			if (value?.type === "end") ended = true;
			if (value?.type === "final" && typeof value.text === "string") deliver({ type: "final", text: value.text });
			else if (value?.type === "ready" || value?.type === "end") deliver({ type: value.type });
			else if (value?.type === "error") deliver({ type: "error", message: value.message === "model-missing" ? "model-missing" : String(value.message) });
		}));
		child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
		child.on("error", (err) => deliver({ type: "error", message: err.message }));
		child.on("close", (code, signal) => {
			if (session === current) session = null;
			// A killed helper was cancelled on purpose: say nothing.
			if (signal === "SIGKILL") return;
			if (!ended) deliver(code === 0 ? { type: "end" } : { type: "error", message: stderr.trim() || `Apple dictation stopped (${code})` });
		});
		return id;
	}

	function audio(id, buffer) {
		if (!session || session.id !== id || !session.child.stdin.writable) return;
		const bytes = ArrayBuffer.isView(buffer) ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength) : Buffer.from(buffer);
		session.child.stdin.write(bytes);
	}

	/** Close stdin: the helper finalizes the last results, then exits. */
	function stop(id) {
		if (!session || session.id !== id) return;
		session.child.stdin.end();
	}

	return { supported, status, install: installModel, start, audio, stop, cancel };
}

/** Validate one renderer control command and run it. */
async function appleSpeechControl(command, speech, send) {
	switch (command?.op) {
		case "status": return speech.status();
		case "install": await speech.install(); return { ok: true };
		case "start": return { session: speech.start(send) };
		case "stop": if (Number.isInteger(command.session)) speech.stop(command.session); return { ok: true };
		case "cancel": if (Number.isInteger(command.session)) speech.cancel(command.session); return { ok: true };
		default: throw new Error("Unsupported Apple dictation control.");
	}
}

module.exports = { createAppleSpeech, appleSpeechControl, hostSupported, jsonLines, MIN_MACOS_MAJOR };
