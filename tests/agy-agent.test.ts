import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { type ChildProcessWithoutNullStreams, type spawn } from "node:child_process";
import { PassThrough } from "node:stream";

import {
	createAssistantMessageEventStream,
	createModels,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Message,
	type Model,
	type SystemMessage,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { resolveAgyBinary } from "../src/agent/agy/binary.ts";
import { parseAgyLine } from "../src/agent/agy/cli-events.ts";
import { AGY_API, AGY_PROVIDER, AgyError } from "../src/agent/agy/constants.ts";
import { inspectAgyInstallation } from "../src/agent/agy/installation.ts";
import { AgyLaunchError, createAgyLauncher } from "../src/agent/agy/launch.ts";
import { createAgyProvider, parseAgyModelsOutput } from "../src/agent/agy/provider.ts";
import { createAgyStreamFunction, toAgyArgs, type RunAgy } from "../src/agent/agy/stream.ts";
import { toAgyPrompt, toAgyStreamJsonLine } from "../src/agent/agy/transcript.ts";

const HOME = "/home/u";

function resolveWith(executables: string[], env: Record<string, string> = {}, platform: NodeJS.Platform = "linux", homeDir = HOME) {
	const found = new Set(executables);
	return resolveAgyBinary({ env, platform, homeDir, isExecutable: (p) => found.has(p) });
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("agy binary lookup", () => {
	it("prefers PATH hit then known dirs on posix", () => {
		assert.equal(resolveWith(["/usr/bin/agy", `${HOME}/.local/bin/agy`], { PATH: "/opt/x:/usr/bin" }), "/usr/bin/agy");
		const all = [
			`${HOME}/.gemini/antigravity-cli/bin/agy`,
			`${HOME}/.local/bin/agy`,
			`${HOME}/.npm-global/bin/agy`,
			"/opt/homebrew/bin/agy",
			"/usr/local/bin/agy",
			"/etc/profiles/per-user/u/bin/agy",
			`${HOME}/.nix-profile/bin/agy`,
			"/run/current-system/sw/bin/agy",
		];
		for (let i = 0; i < all.length; i++) {
			assert.equal(resolveWith(all.slice(i), { PATH: "", USER: "u" }), all[i]);
		}
		assert.equal(resolveWith([], { PATH: "/usr/bin:/bin" }), null);
	});

	it("windows finds native agy.exe and ignores .cmd files", () => {
		const winHome = "C:\\Users\\u";
		const env = { PATH: "C:\\tools;C:\\bin", APPDATA: `${winHome}\\AppData\\Roaming` };
		assert.equal(resolveWith(["C:\\bin\\agy.cmd"], env, "win32", winHome), null);
		assert.equal(resolveWith(["C:\\bin\\agy.exe"], env, "win32", winHome), "C:\\bin\\agy.exe");
		assert.equal(resolveWith([`${winHome}\\.gemini\\antigravity-cli\\bin\\agy.exe`], env, "win32", winHome), `${winHome}\\.gemini\\antigravity-cli\\bin\\agy.exe`);
		assert.equal(resolveWith([`${winHome}\\.local\\bin\\agy.exe`], env, "win32", winHome), `${winHome}\\.local\\bin\\agy.exe`);
	});
});

describe("agy installation check", () => {
	const binary = "/fake/agy";

	it("missing installation returns not-found", async () => {
		const status = await inspectAgyInstallation(() => null, async () => {
			throw new Error("must not run");
		});
		assert.deepEqual(status, { state: "not-found", version: null, minimumVersion: "1.5.0" });
	});

	for (const [output, state, version] of [
		["1.5.0", "meets-minimum", "1.5.0"],
		["1.5.14 (Antigravity CLI)\n", "meets-minimum", "1.5.14"],
		["2.0.0", "meets-minimum", "2.0.0"],
		["1.4.9", "update-required", "1.4.9"],
		["garbage output", "version-unchecked", null],
		["1.5.14-preview", "version-unchecked", null],
	] as const) {
		it(`output ${JSON.stringify(output)} evaluates to ${state}`, async () => {
			assert.deepEqual(await inspectAgyInstallation(() => binary, async () => output), {
				state,
				version,
				minimumVersion: "1.5.0",
			});
		});
	}

	it("probe failure returns version-unchecked", async () => {
		const status = await inspectAgyInstallation(() => binary, async () => {
			throw new Error("timeout");
		});
		assert.deepEqual(status, { state: "version-unchecked", version: null, minimumVersion: "1.5.0" });
	});
});

describe("agy launcher", () => {
	const binary = "/fake/agy";
	const options = { cwd: "/fake/work", env: { NODE_ENV: "test" as const } };

	it("refuses launch when update is required or version check fails", async () => {
		for (const output of ["1.4.9", "malformed", null]) {
			const launch = createAgyLauncher({
				findBinary: () => binary,
				readVersion: async () => {
					if (output === null) throw new Error("probe failed");
					return output;
				},
				spawnProcess: (() => assert.fail("must not spawn")) as typeof spawn,
			});
			await assert.rejects(async () => launch(["--model", "gemini-4-hydrogen-high"], options), AgyLaunchError);
		}
	});

	it("returns null when binary is missing and aborts on aborted signal", async () => {
		assert.equal(await createAgyLauncher({ findBinary: () => null })([], options), null);
		const controller = new AbortController();
		controller.abort();
		const launch = createAgyLauncher({ findBinary: () => binary, readVersion: async () => "1.5.14" });
		await assert.rejects(async () => launch([], { ...options, signal: controller.signal }), AgyLaunchError);
	});

	it("spawns process when version meets minimum", async () => {
		const child = {} as ChildProcessWithoutNullStreams;
		let spawned = false;
		const launch = createAgyLauncher({
			findBinary: () => binary,
			readVersion: async () => "1.5.14",
			spawnProcess: ((file: string, args: string[], opts: unknown) => {
				spawned = true;
				assert.equal(file, binary);
				assert.deepEqual(args, ["--model", "gemini-4-hydrogen-high"]);
				assert.deepEqual(opts, { ...options, stdio: "pipe" });
				return child;
			}) as typeof spawn,
		});
		assert.equal(await launch(["--model", "gemini-4-hydrogen-high"], options), child);
		assert.equal(spawned, true);
	});
});

describe("agy cli-events line parser", () => {
	it("parses init, step_update, and result events and ignores invalid lines", () => {
		assert.deepEqual(
			parseAgyLine(JSON.stringify({ event: "init", conversation_id: "c1", init: { model: "m1" } })),
			{ type: "init", conversationId: "c1", init: { model: "m1" } },
		);
		assert.deepEqual(
			parseAgyLine(JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Hi" } })),
			{ type: "step_update", stepUpdate: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Hi" } },
		);
		assert.deepEqual(
			parseAgyLine(JSON.stringify({ event: "result", result: { status: "ERROR", error: "Quota exceeded" } })),
			{ type: "result", result: { status: "ERROR", error: "Quota exceeded" } },
		);
		assert.equal(parseAgyLine("plain text line"), null);
		assert.equal(parseAgyLine(JSON.stringify({ event: "unknown" })), null);
	});
});

describe("agy transcript conversion", () => {
	const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: 0 });
	const system = (content: string): SystemMessage => ({ role: "system", content, timestamp: 0 });
	const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
		role: "assistant",
		content,
		api: AGY_API,
		provider: AGY_PROVIDER,
		model: "gemini-4-hydrogen-high",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	});
	const toolResult = (toolName: string, content: ToolResultMessage["content"], isError = false): ToolResultMessage =>
		({ role: "toolResult", toolCallId: "call-1", toolName, content, isError, timestamp: 0 });

	it("formats single message, multi-turn replay, system prompt, tool errors, and skips thinking", () => {
		assert.equal(toAgyPrompt([user("What is recursion?")]), "What is recursion?");
		const messages: Message[] = [
			system("Tutor"),
			user("Open file.txt"),
			assistant([
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: "Opening." },
				{ type: "toolCall", id: "t1", name: "read_file", arguments: { path: "file.txt" } },
			]),
			toolResult("read_file", [{ type: "text", text: "missing" }], true),
			user("Retry"),
		];
		assert.equal(toAgyPrompt(messages), [
			"[system]\nTutor",
			"[user]\nOpen file.txt",
			"[assistant]\nOpening.",
			'[tool call read_file] {"path":"file.txt"}',
			"[tool result read_file error]\nmissing",
			"[user]\nRetry",
		].join("\n\n"));
		assert.deepEqual(JSON.parse(toAgyStreamJsonLine("say hi")), { event: "user", message: { content: "say hi" } });
	});
});

describe("agy argument builder", () => {
	it("omits --effort for fixed-effort suffixes and claude models, passes it otherwise", () => {
		assert.deepEqual(toAgyArgs("gemini-4-hydrogen-high", "high"), [
			"--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--model", "gemini-4-hydrogen-high",
		]);
		assert.equal(toAgyArgs("claude-sonnet-4-6", "high").includes("--effort"), false);
		assert.deepEqual(toAgyArgs("gemini-4-hydrogen", "low"), [
			"--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--model", "gemini-4-hydrogen", "--effort", "low",
		]);
	});
});

describe("agy stream adapter", () => {
	function createMockChild() {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => true }) as unknown as ChildProcessWithoutNullStreams;
		return { child, stdin, stdout, stderr };
	}

	const [model] = parseAgyModelsOutput("gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)") as [Model<Api>];

	it("streams thinking and text deltas, updates usage, and completes on result", async () => {
		const { child, stdout } = createMockChild();
		const streamFn = createAgyStreamFunction(() => child);
		const stream = streamFn(model, normalizeContext({ messages: [{ role: "user", content: "Think", timestamp: 0 }] }));

		queueMicrotask(() => {
			stdout.write(JSON.stringify({ event: "init", conversation_id: "c1", init: {} }) + "\n");
			stdout.write(JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "thinking", thinking_delta: "Plan" } }) + "\n");
			stdout.write(JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "thinking" } }) + "\n");
			stdout.write(JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "42" } }) + "\n");
			stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 10, output_tokens: 25, thinking_tokens: 20, total_tokens: 55 } } }) + "\n");
		});

		const events = await collectEvents(stream);
		const doneEvent = events.find((e) => e.type === "done");
		assert(doneEvent && doneEvent.type === "done");
		assert.deepEqual(doneEvent.message.content, [{ type: "thinking", thinking: "Plan" }, { type: "text", text: "42" }]);
		assert.equal(doneEvent.message.usage.reasoning, 20);
		assert.equal(doneEvent.message.usage.output, 25);
	});

	it("handles CLI error result and missing binary", async () => {
		const { child, stdout } = createMockChild();
		const stream = createAgyStreamFunction(() => child)(model, normalizeContext({ messages: [{ role: "user", content: "Fail", timestamp: 0 }] }));
		queueMicrotask(() => {
			stdout.write(JSON.stringify({ event: "result", result: { status: "ERROR", error: "Quota exceeded" } }) + "\n");
		});
		const errEvents = await collectEvents(stream);
		const errEvent = errEvents.find((e) => e.type === "error");
		assert(errEvent && errEvent.type === "error");
		assert.equal(errEvent.error.errorMessage, "Quota exceeded");

		const notFoundEvents = await collectEvents(createAgyStreamFunction(() => null)(model, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] })));
		const notFound = notFoundEvents.find((e) => e.type === "error");
		assert(notFound && notFound.type === "error");
		assert.equal(notFound.error.errorMessage, AgyError.CliNotFound);
	});
});

describe("agy dynamic model discovery", () => {
	it("parses tab-separated `agy models` output and ignores blanks/duplicates", () => {
		const models = parseAgyModelsOutput([
			"",
			"Fetching available models...",
			"gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)",
			"gemini-4-hydrogen-high\tDuplicate",
			"claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
			"\tmissing-id",
			"missing-name\t",
		].join("\n"));
		assert.deepEqual(models.map((m) => [m.id, m.name]), [
			["gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"],
			["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"],
		]);
	});

	it("refreshes models from CLI, drops discontinued models, and preserves last good list on failure", async () => {
		let call = 0;
		const collection = createModels();
		const provider = createAgyProvider(() => createAssistantMessageEventStream(), {
			findBinary: () => "/fake/agy",
			readModels: async () => {
				call++;
				if (call === 1) return "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";
				if (call === 2) return "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\n";
				throw new Error("CLI offline");
			},
		});
		collection.setProvider(provider);
		assert.equal(collection.getModels(AGY_PROVIDER).length, 0);

		const r1 = await collection.refresh({ providers: [AGY_PROVIDER] });
		assert.equal(r1.errors.size, 0);
		assert.deepEqual(collection.getModels(AGY_PROVIDER).map((m) => m.id), ["gemini-3.8-flash-high", "claude-sonnet-4-6"]);

		// Second refresh drops discontinued gemini-3.8-flash-high and picks up gemini-4-hydrogen-high.
		const r2 = await collection.refresh({ providers: [AGY_PROVIDER] });
		assert.equal(r2.errors.size, 0);
		assert.deepEqual(collection.getModels(AGY_PROVIDER).map((m) => m.id), ["gemini-4-hydrogen-high"]);

		// Failed refresh keeps the last good catalog instead of clearing it.
		const r3 = await collection.refresh({ providers: [AGY_PROVIDER] });
		assert.equal(r3.errors.size, 1);
		assert.deepEqual(collection.getModels(AGY_PROVIDER).map((m) => m.id), ["gemini-4-hydrogen-high"]);
	});
});
