/** Subscription transcription protocol adapted from @howaboua/pi-codex-conversion
 * src/voice/dictation/transcriber.ts, commit a06eae4d141fae421a8d0108a4a560013d6508a8.
 * Attribution: docs/codex-dictation-MIT.txt. Credentials remain server-side. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export const MAX_DICTATION_BYTES = 24_000 * 2 * 120;
const LOGIN_ERROR = "Sign in to Codex on this PC to use dictation.";

/** Ask Codex's own auth manager for its current login; never copy its auth file. */
export async function codexDictationAuth(signal: AbortSignal): Promise<Record<string, string>> {
	signal.throwIfAborted();
	const child = spawn(process.env.LH_CODEX_BINARY || "codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "ignore"] });
	const lines = createInterface({ input: child.stdout });
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	let nextId = 0;
	const fail = (error: Error) => { for (const call of pending.values()) call.reject(error); pending.clear(); };
	const abort = () => { fail(new Error("Dictation cancelled.")); child.kill(); };
	const timeout = setTimeout(() => { fail(new Error("Codex sign-in took too long. Try again.")); child.kill(); }, 20_000);
	child.stdin.on("error", () => fail(new Error(LOGIN_ERROR)));
	child.on("error", () => fail(new Error("Codex could not be started. Check that Codex CLI is installed.")));
	child.on("exit", () => fail(new Error(LOGIN_ERROR)));
	signal.addEventListener("abort", abort, { once: true });
	lines.on("line", (line) => {
		if (line.length > 512 * 1024) { fail(new Error("Codex returned an invalid sign-in response.")); return; }
		try {
			const reply = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
			const call = reply.id === undefined ? undefined : pending.get(reply.id);
			if (!call) return;
			pending.delete(reply.id!);
			if (reply.error) call.reject(new Error(LOGIN_ERROR)); else call.resolve(reply.result);
		} catch { /* Ignore non-protocol startup diagnostics. */ }
	});
	const rpc = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
		const id = ++nextId;
		pending.set(id, { resolve, reject });
		child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => { if (error) { pending.delete(id); reject(new Error(LOGIN_ERROR)); } });
	});
	try {
		await rpc("initialize", { clientInfo: { name: "learnharness_dictation", title: "LearnHarness dictation", version: "0.4.1" } });
		child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
		let result = await rpc("getAuthStatus", { includeToken: true, refreshToken: false }) as { authMethod?: string; authToken?: string };
		if (result.authToken) {
			const expiry = JSON.parse(Buffer.from(result.authToken.split(".")[1] || "", "base64url").toString()).exp;
			if (typeof expiry === "number" && expiry * 1000 < Date.now() + 60_000) result = await rpc("getAuthStatus", { includeToken: true, refreshToken: true }) as typeof result;
		}
		if (result.authMethod !== "chatgpt" || !result.authToken) throw new Error(LOGIN_ERROR);
		const claims = JSON.parse(Buffer.from(result.authToken.split(".")[1] || "", "base64url").toString());
		const account = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
		if (typeof account !== "string" || !account) throw new Error(LOGIN_ERROR);
		return { authorization: `Bearer ${result.authToken}`, "chatgpt-account-id": account, originator: "learnharness", "x-session-id": randomUUID(), "user-agent": "LearnHarness-Codex-Dictation" };
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(LOGIN_ERROR);
		throw error;
	} finally {
		clearTimeout(timeout); signal.removeEventListener("abort", abort); lines.close(); child.stdin.end(); child.kill();
	}
}

/** Recorded PCM is sent only after the user finishes. No VAD or assistant turn. */
export async function transcribeCodexDictation(pcm: Buffer, signal: AbortSignal, language?: string): Promise<string> {
	if (!pcm.length || pcm.length % 2 || pcm.length > MAX_DICTATION_BYTES) throw new Error("Invalid dictation audio. Record up to two minutes and try again.");
	if (pcm.length < 4_800) return "";
	const headers = await codexDictationAuth(signal);
	signal.throwIfAborted();
	return new Promise<string>((resolve, reject) => {
		const socket = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", { headers, handshakeTimeout: 15_000, maxPayload: 128 * 1024, followRedirects: false });
		let settled = false;
		let committed = false;
		const finish = (error: Error | null, text = "") => {
			if (settled) return;
			settled = true; clearTimeout(timeout); signal.removeEventListener("abort", abort);
			if (socket.readyState === WebSocket.OPEN) socket.close(); else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
			if (error) reject(error); else resolve(text);
		};
		const abort = () => finish(new Error("Dictation cancelled."));
		const timeout = setTimeout(() => finish(new Error("Codex dictation took too long. Try again.")), 45_000);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) { abort(); return; }
		socket.on("open", () => socket.send(JSON.stringify({ type: "session.update", session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24_000 }, noise_reduction: { type: "near_field" }, transcription: { model: "gpt-4o-mini-transcribe", ...(language ? { language } : {}) }, turn_detection: null } } } })));
		socket.on("message", (raw) => {
			if (settled) return;
			try {
				const event = JSON.parse(raw.toString()) as { type?: string; transcript?: string; error?: { code?: string } };
				if (event.type === "error") { finish(new Error("Codex dictation could not transcribe this recording. Check your Codex sign-in and plan access, then retry.")); return; }
				if ((event.type === "session.updated" || event.type === "transcription_session.updated") && !committed) {
					committed = true;
					for (let offset = 0; offset < pcm.length; offset += 48_000) socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.subarray(offset, offset + 48_000).toString("base64") }));
					socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
				}
				if (committed && (event.type === "conversation.item.input_audio_transcription.completed" || event.type === "input_audio_transcription.completed")) {
					if (typeof event.transcript !== "string" || Buffer.byteLength(event.transcript) > 64 * 1024) throw new Error();
					finish(null, event.transcript.trim());
				}
				if (event.type === "conversation.item.input_audio_transcription.failed") finish(new Error("Codex could not transcribe this audio. Try recording again."));
			} catch { finish(new Error("Codex returned an invalid transcription response.")); }
		});
		socket.on("error", (error) => finish(new Error(/401/.test(error.message) ? LOGIN_ERROR : /403/.test(error.message) ? "Your Codex account does not currently allow dictation." : "Codex dictation could not connect. Check your connection and try again.")));
		socket.on("close", () => finish(new Error("Codex dictation disconnected before transcription finished. Try again.")));
	});
}
