/** Local OpenAI-compatible proxy. LearnHarness speaks chat completions; this
 * process runs cursor-agent in ask mode and translates the stream back.
 * Ask mode is read-only, so the child does not edit the learner's files. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildCursorPrompt,
	contentToText,
	nextTextDelta,
	parseToolEnvelope,
	toolNames,
	type CursorChatMessage,
	type CursorToolDef,
	type DeltaState,
} from "./protocol.ts";
import { cursorAgentBin } from "./login.ts";

const ARG_BUDGET = 1_200_000;
const DEFAULT_PORT = 32124;

export function cursorProxyPort(): number {
	const raw = Number(process.env.LEARNHARNESS_CURSOR_PORT ?? DEFAULT_PORT);
	return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_PORT;
}

export function cursorProxyBaseUrl(): string {
	return `http://127.0.0.1:${cursorProxyPort()}/v1`;
}

export function cursorWorkspace(): string {
	return process.env.LEARNHARNESS_CURSOR_WORKSPACE || join(tmpdir(), "learnharness-cursor");
}

interface ChatBody {
	model?: string;
	messages?: CursorChatMessage[];
	tools?: Array<{ function?: { name?: string; description?: string; parameters?: unknown } }>;
}

let server: Server | null = null;
let listenPromise: Promise<number> | null = null;

function chunk(id: string, delta: Record<string, unknown>, finish: string | null) {
	return {
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		choices: [{ index: 0, delta, finish_reason: finish }],
		...(finish ? { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } : {}),
	};
}

function writeSse(res: ServerResponse, payload: unknown) {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function toolDefs(body: ChatBody): CursorToolDef[] {
	const defs: CursorToolDef[] = [];
	for (const tool of body.tools ?? []) {
		const name = tool.function?.name;
		if (!name) continue;
		defs.push({ name, description: tool.function?.description, parameters: tool.function?.parameters });
	}
	return defs;
}

function runAgent(model: string, prompt: string, signal: AbortSignal): ChildProcess {
	const modelId = model && !model.startsWith("-") ? model : "auto";
	const args = [
		"--print",
		"--mode", "ask",
		"--output-format", "stream-json",
		"--stream-partial-output",
		"--model", modelId,
		"--trust",
		"--workspace", cursorWorkspace(),
	];
	let stdin: string | null = null;
	if (Buffer.byteLength(prompt) <= ARG_BUDGET) args.push(prompt);
	else {
		args.push("The full conversation is on stdin. Respond to it. Do not explore the disk or run commands.");
		stdin = prompt;
	}
	mkdirSync(cursorWorkspace(), { recursive: true });
	const env = { ...process.env };
	// The bearer token pi-ai sends is a loopback dummy, never a Cursor key.
	if (env.CURSOR_API_KEY === "learnharness-local") delete env.CURSOR_API_KEY;
	const child = spawn(cursorAgentBin(), args, {
		cwd: cursorWorkspace(),
		env,
		stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
	});
	if (stdin) child.stdin?.end(stdin);
	const stop = () => child.kill("SIGTERM");
	if (signal.aborted) stop();
	else signal.addEventListener("abort", stop, { once: true });
	child.on("close", () => signal.removeEventListener("abort", stop));
	return child;
}

function assistantText(event: { message?: { content?: Array<{ type?: string; text?: string }> } }): string {
	return (event.message?.content ?? []).filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
}

function complete(body: ChatBody, res: ServerResponse, signal: AbortSignal) {
	const id = `chatcmpl-lhcursor-${Date.now()}`;
	const defs = toolDefs(body);
	const allowed = toolNames(defs);
	const prompt = buildCursorPrompt(body.messages ?? [], defs);
	const child = runAgent(body.model ?? "auto", prompt, signal);
	const state: DeltaState = { acc: "" };
	let mode: "undecided" | "stream" | "tool" = "undecided";
	let emitted = "";
	let stderr = "";
	let settled = false;
	let buffer = "";

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	writeSse(res, chunk(id, { role: "assistant", content: "" }, null));

	const emitText = (text: string) => {
		if (!text) return;
		emitted += text;
		writeSse(res, chunk(id, { content: text }, null));
	};
	const finish = (text: string) => {
		const envelope = allowed.size > 0 ? parseToolEnvelope(text, allowed) : null;
		if (envelope) {
			envelope.forEach((item, index) => {
				writeSse(res, chunk(id, {
					tool_calls: [{
						index,
						id: `call_lhcursor_${index}_${Date.now()}`,
						type: "function",
						function: { name: item.name, arguments: JSON.stringify(item.arguments) },
					}],
				}, null));
			});
			writeSse(res, chunk(id, {}, "tool_calls"));
			return;
		}
		if (mode !== "stream") emitText(text);
		else if (text.startsWith(emitted)) emitText(text.slice(emitted.length));
		writeSse(res, chunk(id, {}, "stop"));
	};
	const consider = (delta: string) => {
		if (!delta) return;
		if (allowed.size === 0 || mode === "stream") {
			mode = "stream";
			emitText(delta);
			return;
		}
		if (mode === "tool") return;
		const head = state.acc.trimStart()[0];
		if (!head) return;
		if (head !== "{" && head !== "[" && head !== "`") {
			mode = "stream";
			emitText(state.acc);
			return;
		}
		mode = "tool";
	};
	const takeLine = (line: string) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let event: {
			type?: string;
			subtype?: string;
			text?: string;
			timestamp_ms?: number;
			model_call_id?: string;
			result?: string;
			is_error?: boolean;
			error?: { message?: string };
			message?: { content?: Array<{ type?: string; text?: string }> };
		};
		try {
			event = JSON.parse(trimmed);
		} catch {
			return;
		}
		if (event.type === "assistant") {
			const partial = typeof event.timestamp_ms === "number" && typeof event.model_call_id !== "string";
			consider(nextTextDelta(state, assistantText(event), partial));
		} else if (event.type === "thinking" && event.subtype === "delta" && event.text) {
			writeSse(res, chunk(id, { reasoning_content: event.text }, null));
		} else if (event.type === "result" && !settled) {
			settled = true;
			const finalText = typeof event.result === "string" && event.result ? event.result : state.acc;
			if (event.is_error || event.subtype === "error") {
				if (!emitted) emitText(event.error?.message || finalText || "cursor-agent failed");
				writeSse(res, chunk(id, {}, "stop"));
			} else finish(finalText);
			res.write("data: [DONE]\n\n");
			res.end();
			child.kill("SIGTERM");
		}
	};

	child.stdout?.on("data", (buf: Buffer) => {
		buffer += buf.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) takeLine(line);
	});
	child.stderr?.on("data", (buf: Buffer) => {
		stderr += buf.toString();
	});
	child.on("close", () => {
		if (settled) return;
		settled = true;
		if (buffer.trim()) takeLine(buffer);
		if (settled && res.writableEnded) return;
		if (!emitted && !state.acc) emitText(stderr.trim() || "cursor-agent exited");
		finish(state.acc || contentToText(stderr));
		if (!res.writableEnded) {
			res.write("data: [DONE]\n\n");
			res.end();
		}
	});
}

function handle(req: IncomingMessage, res: ServerResponse) {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
		return;
	}
	if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { message: "not found" } }));
		return;
	}
	const chunks: Buffer[] = [];
	req.on("data", (chunk: Buffer) => chunks.push(chunk));
	req.on("end", () => {
		let body: ChatBody;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as ChatBody;
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { message: "invalid JSON" } }));
			return;
		}
		const controller = new AbortController();
		res.on("close", () => {
			if (!res.writableEnded) controller.abort();
		});
		complete(body, res, controller.signal);
	});
}

/** Bind the proxy once per process. A later call returns the port already in use. */
export function startCursorProxy(port = cursorProxyPort()): Promise<number> {
	if (listenPromise) return listenPromise;
	listenPromise = new Promise((resolve, reject) => {
		const next = createServer(handle);
		next.once("error", (error) => {
			listenPromise = null;
			reject(error);
		});
		next.listen(port, "127.0.0.1", () => {
			server = next;
			const address = next.address();
			resolve(typeof address === "object" && address ? address.port : port);
		});
	});
	return listenPromise;
}

export async function stopCursorProxy(): Promise<void> {
	const current = server;
	server = null;
	listenPromise = null;
	if (!current) return;
	await new Promise<void>((resolve) => current.close(() => resolve()));
}
