import assert from "node:assert/strict";
import type { AsyncLocalStorage } from "node:async_hooks";
import type { BackgroundCapture } from "../src/agent/background-capture.ts";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import { Type } from "typebox";
import type { PiEngine } from "../src/agent/models.ts";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-background-capture-"));
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
fs.mkdirSync(path.join(scratch, "home"));
fs.writeFileSync(path.join(scratch, "auth.json"), "{}");
process.env = {
	...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}),
	...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}),
	NODE_ENV: "test", HOME: path.join(scratch, "home"),
	LH_DATA_DIR: path.join(scratch, "data"), LH_AUTH_FILE: path.join(scratch, "auth.json"),
};
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected external request"); };
after(() => {
	process.env = originalEnv;
	globalThis.fetch = originalFetch;
	fs.rmSync(scratch, { recursive: true, force: true });
});

const { createBackgroundCapture, backgroundCaptureEnabled, backgroundCaptureDir, capturePreparedBackgroundPayload } = await import("../src/agent/background-capture.ts");
const { runSubagent } = await import("../src/agent/subagents/pi-run.ts");
const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-completions");
const { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai");
const model = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../node_modules/@earendil-works/pi-ai/dist/providers/data/nvidia.json"), "utf8"))["openai-completions"]["chat:deepseek-ai/deepseek-v4.1-flash"] as Model<"openai-completions">;
const identity = { provider: model.provider, id: model.id, api: model.api };
const { runPdfReaderAgent } = await import("../src/agent/subagents/pdf-reader.ts");
const { runVisualMaker } = await import("../src/agent/subagents/visual-maker.ts");
const { createCanvas } = await import("@napi-rs/canvas");
const fixturePng = createCanvas(8, 8).toBuffer("image/png");
const headless = {
	available: () => true, unavailableReason: () => null,
	runDemo: async () => { throw new Error("Unexpected browser operation"); },
	renderSvg: async () => fixturePng,
	renderPdfPages: async (_file: string, pages: number[]) => pages.map((page) => ({ page, png: fixturePng })),
};
function setup(t: TestContext, selection = "auditor") {
	const dir = fs.mkdtempSync(path.join(scratch, "captures-"));
	const previous = backgroundCaptureDir.current;
	backgroundCaptureDir.current = dir;
	process.env.LH_BACKGROUND_CAPTURE = selection;
	t.after(() => { backgroundCaptureDir.current = previous; delete process.env.LH_BACKGROUND_CAPTURE; });
	return dir;
}
function readCapture(dir: string) {
	const files = fs.readdirSync(dir);
	assert.equal(files.length, 1, "Only one final file, never earlier requests or temporary files");
	return JSON.parse(fs.readFileSync(path.join(dir, files[0]!), "utf8"));
}
function sse(toolName: string, thinking: string, modelId = model.id) {
	const chunk = {
		id: "offline", object: "chat.completion.chunk", created: 1, model: modelId,
		choices: [{ index: 0, delta: { role: "assistant", reasoning_content: thinking,
			tool_calls: [{ index: 0, id: `call_${toolName}`, type: "function", function: { name: toolName, arguments: "{}" } }],
		}, finish_reason: "tool_calls" }],
		usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		status: 200, headers: { "content-type": "text/event-stream", "x-private-header": "NEVER_RECORD_THIS_HEADER" },
	});
}
const tools = ["list_sessions", "submit_review"].map((name) => ({
	name, label: name, description: "Offline fixture", parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text" as const, text: name === "list_sessions" ? "SYNTHETIC_SESSION_INDEX" : "Review accepted." }], details: {} }),
}));
function fakeEngine(failSecond = false, fixtureModel = model): PiEngine {
	let calls = 0;
	return { model: fixtureModel, level: "high", streamFn: (selected, context, options) => streamSimple(selected as typeof model, context, {
		...options, apiKey: "NEVER_RECORD_THIS_FAKE_KEY",
		fetch: async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			assert.equal(request.stream, true);
			// Exercise the final prepared observer inside asynchronous transport
			// work as well, so parallel workers test async-local association.
			await Promise.resolve();
			capturePreparedBackgroundPayload(request, fixtureModel);
			calls++;
			if (calls === 2 && failSecond) throw Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
			});
			assert.ok(calls <= 2, "No hidden retries or extra model calls");
			return calls === 1 ? sse("list_sessions", "FIRST_THINKING", fixtureModel.id) : sse("submit_review", "FINAL_THINKING", fixtureModel.id);
		},
	}) };
}

test("capture is off by default; role lists and all select only requested workers", (t) => {
	const dir = setup(t, "");
	assert.equal(backgroundCaptureEnabled("auditor"), false);
	assert.equal(createBackgroundCapture({ role: "auditor", runId: "off" }), undefined);
	process.env.LH_BACKGROUND_CAPTURE = "auditor, extractor";
	assert.equal(backgroundCaptureEnabled("auditor"), true);
	assert.equal(backgroundCaptureEnabled("extractor"), true);
	assert.equal(backgroundCaptureEnabled("pdfReader"), false);
	process.env.LH_BACKGROUND_CAPTURE = "all";
	assert.equal(backgroundCaptureEnabled("pdfReader"), true);
	assert.equal(backgroundCaptureEnabled("researcher"), true);
	assert.deepEqual(fs.readdirSync(dir), [], "No eager files or directories per disabled run");
});

test("only latest request remains; snapshots do not mutate inputs and redact transport secrets", (t) => {
	const dir = setup(t);
	const capture = createBackgroundCapture({ role: "auditor", runId: "unit", sourceId: "../../source" })!;
	capture.begin(model, { messages: ["OLD_REQUEST_ONLY"] }, "high");
	capture.reply({ role: "assistant", content: [{ type: "text", text: "OLD_RESPONSE_ONLY" }], stopReason: "stop" } as AssistantMessage);
	capture.begin(model, { messages: ["new context"] }, "high");
	const payload = { messages: [{ role: "user", content: "new payload" }], headers: { authorization: "private" }, config: { api_key: "private", access_token: "private" } };
	capture.payload(payload, model);
	assert.equal(payload.config.api_key, "private", "Capture must not mutate the actual provider request");
	payload.messages[0]!.content = "later mutation";
	capture.finish();
	const result = readCapture(dir);
	assert.deepEqual(result.request.model, identity);
	assert.equal(result.request.thinkingLevel, "high");
	assert.equal(result.request.format, "provider");
	assert.equal(result.request.payload.messages[0].content, "new payload");
	assert.equal(result.request.payload.headers, "[redacted]");
	assert.equal(result.request.payload.config.api_key, "[redacted]");
	assert.equal(result.request.payload.config.access_token, "[redacted]");
	assert.equal(result.response, null, "New request cannot retain a stale successful response");
	assert.equal(result.timings.length, 2);
	assert.ok(!JSON.stringify(result).includes("OLD_REQUEST_ONLY"));
	assert.ok(!JSON.stringify(result).includes("OLD_RESPONSE_ONLY"));
	if (process.platform !== "win32") {
		const file = path.join(dir, fs.readdirSync(dir)[0]!);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	}
});

test("real native adapter captures replayed thinking, tool results AND the final tool call/reasoning", async (t) => {
	const dir = setup(t);
	await runSubagent(tools, {
		role: "auditor", engine: fakeEngine(), systemPrompt: "Synthetic audit instructions.", prompt: "Synthetic findings.",
		chatId: "src_fixture", maxTurns: 3, shouldStop: (message) => message.content.some((part) => part.type === "toolCall" && part.name === "submit_review"),
	});
	const result = readCapture(dir);
	assert.equal(result.role, "auditor");
	assert.equal(result.sourceId, "src_fixture");
	assert.equal(result.request.turn, 2);
	assert.equal(result.request.format, "provider");
	const previous = result.request.payload.messages.find((message: { role: string }) => message.role === "assistant");
	assert.equal(previous.reasoning_content, "FIRST_THINKING");
	assert.equal(previous.tool_calls[0].function.name, "list_sessions");
	assert.match(result.request.payload.messages.at(-1).content, /SYNTHETIC_SESSION_INDEX/);
	assert.ok(result.response.message.content.some((part: { type: string; thinking?: string }) => part.type === "thinking" && part.thinking === "FINAL_THINKING"));
	assert.ok(result.response.message.content.some((part: { type: string; name?: string }) => part.type === "toolCall" && part.name === "submit_review"));
	assert.equal(result.toolResults.length, 1);
	assert.match(JSON.stringify(result.toolResults), /Review accepted/);
	assert.equal(result.error, null);
	assert.equal(result.timings.length, 2);
	for (const timing of result.timings) {
		assert.equal(timing.responseStatus, 200);
		assert.ok(timing.headersReceivedAt >= timing.startedAt);
		assert.ok(timing.finishedAt >= timing.headersReceivedAt);
	}
	const serialized = JSON.stringify(result);
	assert.ok(!serialized.includes("NEVER_RECORD_THIS_FAKE_KEY"));
	assert.ok(!serialized.includes("NEVER_RECORD_THIS_HEADER"));
});

for (const id of ["chat:xiaomi/mimo-v2.6-pro", "chat:deepseek/deepseek-v4.1-flash"]) {
	test(`OpenRouter ${id}: returned thinking and final submit survive capture`, async (t) => {
		const dir = setup(t);
		const catalog = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../node_modules/@earendil-works/pi-ai/dist/providers/data/openrouter.json"), "utf8"));
		const fixtureModel = catalog["openai-completions"][id] as typeof model;
		assert.ok(fixtureModel, "Use the actual installed model definition, never a live provider");
		await runSubagent(tools, {
			role: "auditor", engine: fakeEngine(false, fixtureModel), systemPrompt: "Fixture", prompt: "Fixture", maxTurns: 2,
		});
		const result = readCapture(dir);
		assert.equal(result.request.model.provider, "openrouter");
		assert.equal(result.request.model.id, fixtureModel.id);
		assert.match(JSON.stringify(result.request.payload), /FIRST_THINKING/);
		assert.match(JSON.stringify(result.request.payload), /SYNTHETIC_SESSION_INDEX/);
		assert.match(JSON.stringify(result.response), /FINAL_THINKING/);
		assert.match(JSON.stringify(result.response), /submit_review/);
		assert.equal(result.error, null);
	});
}

test("a failed continuation retains its request/error, not the previous reply or tool result", async (t) => {
	const dir = setup(t);
	await assert.rejects(runSubagent(tools, { role: "auditor", engine: fakeEngine(true), systemPrompt: "Fixture", prompt: "Fixture", maxTurns: 3 }), /waiting for response headers/);
	const result = readCapture(dir);
	assert.equal(result.request.turn, 2);
	assert.match(JSON.stringify(result.request.payload), /SYNTHETIC_SESSION_INDEX/);
	assert.equal(result.response.message.stopReason, "error");
	assert.match(result.error.message, /waiting for response headers/);
	assert.deepEqual(result.toolResults, []);
	assert.equal(result.timings[1].responseStatus, undefined);
	assert.ok(result.finishedAt >= result.startedAt);
});

test("all records other workers separately; adapters without payload hooks use labeled context", async (t) => {
	const dir = setup(t, "all");
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage([fauxText("Offline researcher response.")])]);
	await runSubagent([], { role: "researcher", engine: { model: faux.getModel(), streamFn: faux.streamSimple }, systemPrompt: "Fixture instructions", prompt: "Fixture question", maxTurns: 1 });
	const result = readCapture(dir);
	assert.equal(result.role, "researcher");
	assert.equal(result.request.format, "context");
	assert.match(JSON.stringify(result.request.payload), /Fixture instructions/);
	assert.match(JSON.stringify(result.request.payload), /Fixture question/);
	assert.match(JSON.stringify(result.response), /Offline researcher response/);
	assert.equal(result.error, null);
});

test("concurrent workers retain independent per-run captures", async (t) => {
	const dir = setup(t, "all");
	await Promise.all((["researcher", "extractor"] as const).map(async (role) => {
		await runSubagent(tools, { role, engine: fakeEngine(), systemPrompt: "Fixture", prompt: `Request for ${role}`, maxTurns: 2 });
	}));
	const files = fs.readdirSync(dir);
	assert.equal(files.length, 2);
	const records = files.map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
	assert.equal(new Set(records.map((record) => record.runId)).size, 2);
	for (const record of records) {
		assert.match(JSON.stringify(record.request), new RegExp(`Request for ${record.role}`));
		assert.match(JSON.stringify(record.response), /FINAL_THINKING/);
		const other = record.role === "researcher" ? "extractor" : "researcher";
		assert.ok(!JSON.stringify(record.request).includes(`Request for ${other}`));
	}
});

test("prepared-payload observer uses the process-wide context shared by route module instances", async (t) => {
	const dir = setup(t);
	const capture = createBackgroundCapture({ role: "auditor", runId: "shared-context" })!;
	capture.begin(model, { messages: [] });
	const shared = (globalThis as typeof globalThis & { __lhBackgroundCaptureContext?: AsyncLocalStorage<BackgroundCapture> }).__lhBackgroundCaptureContext;
	assert.ok(shared);
	await shared.run(capture, async () => {
		await Promise.resolve();
		capturePreparedBackgroundPayload({ model: "final-prepared-model", input: [] }, model);
	});
	capture.finish();
	const record = readCapture(dir);
	assert.equal(record.request.format, "provider");
	assert.equal(record.request.payload.model, "final-prepared-model");
});

test("cancelled requests retain their input and abort outcome", async (t) => {
	const dir = setup(t);
	const controller = new AbortController();
	let entered!: () => void;
	const fetchEntered = new Promise<void>((resolve) => { entered = resolve; });
	const engine: PiEngine = { model, level: "high", streamFn: (selected, context, options) => streamSimple(selected as typeof model, context, {
		...options, apiKey: "offline-fixture",
		fetch: async (_url, init) => {
			entered();
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("Fixture cancelled", "AbortError")), { once: true });
			});
		},
	}) };
	const running = runSubagent([], { role: "auditor", engine, systemPrompt: "Fixture", prompt: "Cancelled fixture", maxTurns: 1, abortSignal: controller.signal });
	const rejected = assert.rejects(running, { name: "AbortError" });
	await fetchEntered;
	controller.abort();
	await rejected;
	const result = readCapture(dir);
	assert.match(JSON.stringify(result.request.payload), /Cancelled fixture/);
	assert.equal(result.error.name, "AbortError");
	assert.equal(result.response.message.stopReason, "aborted");
	assert.ok(result.finishedAt >= result.startedAt);
});

test("unselected background roles produce no captures while running normally", async (t) => {
	const dir = setup(t, "auditor");
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage([fauxText("Not captured.")])]);
	await runSubagent([], { role: "extractor", engine: { model: faux.getModel(), streamFn: faux.streamSimple }, prompt: "Fixture", systemPrompt: "Fixture", maxTurns: 1 });
	assert.deepEqual(fs.readdirSync(dir), []);
});

for (const role of ["pdfReader", "visualMaker"] as const) {
	for (const selection of [role, "all", "auditor"]) {
		test(`${role} actual entrypoint honors ${selection} and records its rendered-image session`, async (t) => {
			const dir = setup(t, selection);
			const faux = createFauxCore({});
			const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>';
			faux.setResponses([
				fauxAssistantMessage(role === "pdfReader"
					? [fauxToolCall("pdf_render", { pages: "1" }, { id: "render" })]
					: [fauxToolCall("write_svg", { svg }, { id: "write" }), fauxToolCall("render_svg", {}, { id: "render" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText(`FINAL_${role}_REPLY`)]),
			]);
			const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
			let calls = 0;
			const opts = { engine, headless, chatId: `fixture_${role}`, onUsage: () => { calls++; } };
			if (role === "pdfReader") {
				const result = await runPdfReaderAgent({ path: path.join(import.meta.dirname, "fixtures/sample-3page.pdf"), question: "Synthetic figure?" }, opts);
				assert.equal(result.brief, "FINAL_pdfReader_REPLY");
				assert.deepEqual(result.pagesRead, [1]);
			} else {
				const result = await runVisualMaker({ brief: "Synthetic figure." }, opts);
				assert.equal(result.svg, svg);
				assert.equal(result.notes, "FINAL_visualMaker_REPLY");
			}
			assert.equal(calls, 2, "Instrumentation never adds model calls");
			if (selection === "auditor") { assert.deepEqual(fs.readdirSync(dir), []); return; }
			const record = readCapture(dir);
			assert.equal(record.role, role);
			assert.equal(record.sourceId, `fixture_${role}`);
			assert.equal(record.request.turn, 2);
			assert.equal(record.request.format, "context");
			assert.ok(record.request.payload.messages.some((message: { role: string; content: { type: string }[] }) =>
				message.role === "user" && Array.isArray(message.content) && message.content.some((part) => part.type === "image")));
			assert.match(JSON.stringify(record.request.payload), role === "pdfReader" ? /pdf_render/ : /render_svg/);
			assert.match(JSON.stringify(record.response), new RegExp(`FINAL_${role}_REPLY`));
			assert.equal(record.error, null);
			assert.ok(record.finishedAt >= record.startedAt);
		});
	}
	test(`${role} actual entrypoint retains provider failures`, async (t) => {
		const dir = setup(t, role);
		const opts = { engine: fakeEngine(true), headless };
		const result = role === "pdfReader"
			? await runPdfReaderAgent({ path: path.join(import.meta.dirname, "fixtures/sample-3page.pdf"), question: "Fixture?" }, opts)
			: await runVisualMaker({ brief: "Fixture" }, opts);
		assert.match(JSON.stringify(result), /waiting for response headers/);
		const record = readCapture(dir);
		assert.equal(record.request.turn, 2);
		assert.equal(record.response.message.stopReason, "error");
		assert.match(record.error.message, /waiting for response headers/);
	});
}

test("recording failures and unserializable payloads never throw into a worker", (t) => {
	const dir = setup(t);
	const capture = createBackgroundCapture({ role: "auditor", runId: "cyclic" })!;
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	capture.begin(model, cyclic);
	capture.finish(new Error("Fixture failure", { cause: new Error("Nested failure") }));
	assert.match(readCapture(dir).request.payload.captureError, /serialized/);
	assert.equal(readCapture(dir).error.cause.message, "Nested failure");
	const blocked = path.join(scratch, "not-a-directory");
	fs.writeFileSync(blocked, "fixture");
	backgroundCaptureDir.current = blocked;
	const bad = createBackgroundCapture({ role: "auditor", runId: "blocked" })!;
	const warn = console.warn;
	let warnings = 0;
	console.warn = () => { warnings++; };
	t.after(() => { console.warn = warn; });
	assert.doesNotThrow(() => { bad.begin(model, {}); bad.finish(new Error("Fixture")); });
	assert.equal(warnings, 1, "One warning per run, no endless debug-log errors");
});
