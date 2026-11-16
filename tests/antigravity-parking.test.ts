import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
	Type,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Message,
	type SimpleStreamOptions,
	type Tool,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { ResolvedAntigravityRuntime } from "../src/agent/antigravity/installation.ts";
import {
	LIVE_PROCESS_IDLE_TIMEOUT_MS,
	antigravityIdleTimeoutMs,
	getActiveAntigravityProcessCount,
	getParkedAntigravityProcessCount,
} from "../src/agent/antigravity/live-processes.ts";
import { discoverAntigravityModels } from "../src/agent/antigravity/models-discovery.ts";
import { antigravityTokenFilePath, ensureAntigravityProfile } from "../src/agent/antigravity/profile.ts";
import { toPiAntigravityModel } from "../src/agent/antigravity/provider.ts";
import { createAntigravityStream, type AntigravityStreamDeps } from "../src/agent/antigravity/stream.ts";
import { measuredContextTokens } from "../src/core/context-usage.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { shutdownAntigravityProcesses } from "../src/server/index.ts";

const FAKE_ACP = path.resolve(import.meta.dirname, "fixtures", "antigravity", "fake-acp.mjs");

const ASK_USER_QUESTION_TOOL: Tool = {
	name: "ask_user_question",
	description: "Ask the learner a clarifying or diagnostic question",
	parameters: Type.Object({ question: Type.String() }),
};

const QUIZ_TOOL: Tool = {
	name: "quiz",
	description: "Run an interactive quiz question",
	parameters: Type.Object({ topic: Type.String() }),
};

type SpawnRecord = {
	child: ChildProcess;
	cwd: string;
	runDir: string;
	env: NodeJS.ProcessEnv | undefined;
};

function makeTempRoot(t: TestContext, prefix = "lh-agy-park-test-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(async () => {
		await shutdownAntigravityProcesses();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

function fakeRuntime(version = "1.5.2"): ResolvedAntigravityRuntime {
	return {
		source: "managed",
		kind: "acp-server",
		executablePath: FAKE_ACP,
		harnessPath: "/tmp/localharness_external",
		args: [],
		version,
	};
}

function testModel(id: "gemini-3.1-pro" | "gemini-3-flash" = "gemini-3.1-pro") {
	return toPiAntigravityModel({
		id,
		name: id === "gemini-3.1-pro" ? "Gemini 3.1 Pro" : "Gemini 3 Flash",
		reasoning: true,
		supportedThinkingLevels: ["low", "medium", "high"],
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		},
		input: ["text", "image"],
		contextWindow: null,
		maxTokens: null,
	});
}

function makeSignedInProfile(root: string, name = "profile"): { authFile: string; profileDir: string } {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	const authFile = path.join(dir, "auth.json");
	const profileDir = ensureAntigravityProfile({
		authFile,
		env: { ...process.env, LH_AUTH_FILE: authFile },
	});
	fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });
	return { authFile, profileDir };
}

function spySpawner(spawns: SpawnRecord[], t: TestContext): NonNullable<AntigravityStreamDeps["spawnProcess"]> {
	return ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
		const child = spawn(command, args, options);
		const cwd = typeof options?.cwd === "string" ? options.cwd : process.cwd();
		spawns.push({
			child,
			cwd,
			runDir: path.dirname(cwd),
			env: options?.env,
		});
		t.after(() => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
			}
		});
		return child;
	}) as NonNullable<AntigravityStreamDeps["spawnProcess"]>;
}

async function collectEvents(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

async function waitForExit(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await Promise.race([
		once(child, "close"),
		sleep(timeoutMs).then(() => {
			throw new Error(`Timed out waiting for child pid ${child.pid} to exit`);
		}),
	]);
}

async function waitForDirRemoved(dir: string, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (fs.existsSync(dir) && Date.now() < deadline) {
		await sleep(15);
	}
	assert.equal(fs.existsSync(dir), false, `expected temp directory ${dir} to be removed`);
}

function readPromptHistory(profileDir: string): Array<{
	pid: number;
	sessionId: string;
	currentModel: string;
	currentThought: string;
	prompt: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}> {
	const file = path.join(profileDir, "antigravity-acp", "prompt-history.jsonl");
	return fs
		.readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function getToolCalls(events: AssistantMessageEvent[]) {
	const done = events.at(-1);
	assert.ok(done?.type === "done" && done.reason === "toolUse", `expected done(toolUse), got ${done?.type}`);
	return done.message.content.filter((block) => block.type === "toolCall");
}

function getFinalText(events: AssistantMessageEvent[]): string {
	const done = events.at(-1);
	assert.ok(done?.type === "done" && done.reason === "stop", `expected done(stop), got ${done?.type}`);
	return done.message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

test("multi-turn learner-question pause parks ACP process and reuses same process across sequential tool calls while preserving cliContextWindow", async (t) => {
	const root = makeTempRoot(t);
	const { authFile, profileDir } = makeSignedInProfile(root);
	const spawns: SpawnRecord[] = [];
	const env = {
		...process.env,
		LH_AUTH_FILE: authFile,
		FAKE_ACP_STREAM_MODE: "two-mcp-tools",
		FAKE_ACP_CLI_WINDOW: "768000",
		FAKE_ACP_RECORD_EVENTS: "1",
	};

	const streamFn = createAntigravityStream({
		isEnabled: () => true,
		isSignedIn: () => true,
		resolveRuntime: () => fakeRuntime(),
		ensureProfile: () => profileDir,
		spawnProcess: spySpawner(spawns, t),
		env,
	});

	const tools = [ASK_USER_QUESTION_TOOL, QUIZ_TOOL];
	const user1: Message = { role: "user", content: "Teach me derivatives", timestamp: 1 };

	// Turn 1: agent invokes ask_user_question -> parked
	const turn1Events = await collectEvents(
		streamFn(testModel(), normalizeContext({ systemPrompt: "Be encouraging.", messages: [user1], tools }), {
			sessionId: "lesson-park-1",
			reasoning: "high",
		}),
	);
	const call1 = getToolCalls(turn1Events)[0]!;
	assert.equal(call1.name, "ask_user_question");
	assert.equal(spawns.length, 1);
	assert.equal(getParkedAntigravityProcessCount(), 1);
	const turn1DoneForCtx = (turn1Events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }> & { message: LhMessage }).message;
	assert.equal(turn1DoneForCtx.cliContextWindow, 768000);
	assert.equal(turn1DoneForCtx.usage.input, 150);
	assert.equal(measuredContextTokens([{ ...turn1DoneForCtx, id: "t1" }]), 150);
	assert.ok(fs.existsSync(spawns[0]!.runDir));

	// Turn 2: learner answers ask_user_question -> same ACP process continues into quiz tool -> still parked
	const toolResult1: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call1.id,
		toolName: "ask_user_question",
		content: [{ type: "text", text: "2x" }],
		isError: false,
		timestamp: 2,
	};
	const turn1DoneMsg = (turn1Events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>).message;
	const turn2Events = await collectEvents(
		streamFn(
			testModel(),
			normalizeContext({
				systemPrompt: "Be encouraging.",
				messages: [user1, turn1DoneMsg, toolResult1],
				tools,
			}),
			{ sessionId: "lesson-park-1", reasoning: "high" },
		),
	);
	const call2 = getToolCalls(turn2Events)[0]!;
	assert.equal(call2.name, "quiz");
	assert.equal(spawns.length, 1, "should reuse parked ACP process without spawning a second child");
	assert.equal(getParkedAntigravityProcessCount(), 1);
	assert.equal((turn2Events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }> & { message: LhMessage }).message.cliContextWindow, 768000);

	// Turn 3: learner answers quiz -> same ACP process completes final answer and cleans up
	const toolResult2: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call2.id,
		toolName: "quiz",
		content: [{ type: "text", text: "score 1/1" }],
		isError: false,
		timestamp: 3,
	};
	const turn2DoneMsg = (turn2Events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>).message;
	const turn3Events = await collectEvents(
		streamFn(
			testModel(),
			normalizeContext({
				systemPrompt: "Be encouraging.",
				messages: [user1, turn1DoneMsg, toolResult1, turn2DoneMsg, toolResult2],
				tools,
			}),
			{ sessionId: "lesson-park-1", reasoning: "high" },
		),
	);
	assert.equal(getFinalText(turn3Events), "Tools returned: 2x | score 1/1");
	assert.equal((turn3Events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }> & { message: LhMessage }).message.cliContextWindow, 768000);
	assert.equal(spawns.length, 1);

	await waitForExit(spawns[0]!.child);
	await waitForDirRemoved(spawns[0]!.runDir);
	assert.equal(getParkedAntigravityProcessCount(), 0);
	assert.equal(getActiveAntigravityProcessCount(), 0);
});

test("caller without sessionId does not park process and cold-starts with replay", async (t) => {
	const root = makeTempRoot(t);
	const { authFile, profileDir } = makeSignedInProfile(root);
	const spawns: SpawnRecord[] = [];
	const streamFn = createAntigravityStream({
		isEnabled: () => true,
		isSignedIn: () => true,
		resolveRuntime: () => fakeRuntime(),
		ensureProfile: () => profileDir,
		spawnProcess: spySpawner(spawns, t),
		env: {
			...process.env,
			LH_AUTH_FILE: authFile,
			FAKE_ACP_STREAM_MODE: "mcp-tool",
			FAKE_ACP_TOOL_NAME: "ask_user_question",
			FAKE_ACP_TEXT_ON_REPLAY: "1",
			FAKE_ACP_RECORD_EVENTS: "1",
		},
	});

	const user1: Message = { role: "user", content: "Start", timestamp: 1 };
	const events1 = await collectEvents(
		streamFn(testModel(), normalizeContext({ systemPrompt: "Sys", messages: [user1], tools: [ASK_USER_QUESTION_TOOL] })),
	);
	const call1 = getToolCalls(events1)[0]!;
	await waitForExit(spawns[0]!.child);
	assert.equal(getParkedAntigravityProcessCount(), 0);
	await waitForDirRemoved(spawns[0]!.runDir);

	const turn1Msg = (events1.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>).message;
	const tr1: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call1.id,
		toolName: "ask_user_question",
		content: [{ type: "text", text: "Answer" }],
		isError: false,
		timestamp: 2,
	};
	const events2 = await collectEvents(
		streamFn(
			testModel(),
			normalizeContext({ systemPrompt: "Sys", messages: [user1, turn1Msg, tr1], tools: [ASK_USER_QUESTION_TOOL] }),
		),
	);
	assert.match(getFinalText(events2), /^Replayed \d+ blocks$/);
	assert.equal(spawns.length, 2);
});

test("mismatch invalidation kills parked process and cold-starts replay preserving text and images across model, reasoning, systemPrompt, tools, history, runtime, profileDir, toolCallId, and trailing user turns", async (t) => {
	type MismatchCase = {
		name: string;
		nextModel?: ReturnType<typeof testModel>;
		nextOptions?: (base: SimpleStreamOptions) => SimpleStreamOptions;
		nextSystemPrompt?: string;
		nextTools?: Tool[];
		mutateMessages?: (msgs: Message[], callId: string) => Message[];
		switchRuntime?: boolean;
		switchProfile?: boolean;
		disableProvider?: boolean;
		signOut?: boolean;
		expectError?: RegExp;
	};

	const cases: MismatchCase[] = [
		{ name: "model changed", nextModel: testModel("gemini-3-flash") },
		{ name: "reasoning changed", nextOptions: (o) => ({ ...o, reasoning: "low" }) },
		{ name: "systemPrompt changed", nextSystemPrompt: "Be strict instead." },
		{
			name: "tool definition changed",
			nextTools: [{ ...ASK_USER_QUESTION_TOOL, description: "Updated question description" }],
		},
		{
			name: "earlier user history changed",
			mutateMessages: (msgs) => [
				{
					...msgs[0]!,
					content: [
						{ type: "text", text: "Tampered question" },
						{ type: "image", data: "USER_PNG_BASE64", mimeType: "image/png" },
					],
				} as Message,
				...msgs.slice(1),
			],
		},
		{
			name: "new user message after toolResult",
			mutateMessages: (msgs) => [...msgs, { role: "user", content: "Wait, change topic", timestamp: 99 }],
		},
		{ name: "runtime changed", switchRuntime: true },
		{ name: "profileDir changed", switchProfile: true },
		{
			name: "toolCallId mismatched",
			mutateMessages: (msgs) =>
				msgs.map((m) => (m.role === "toolResult" ? { ...m, toolCallId: "wrong-call-id" } : m)),
		},
		{
			name: "disabled before resume kills parked process",
			disableProvider: true,
			expectError: /disabled/i,
		},
		{
			name: "signed out before resume kills parked process",
			signOut: true,
			expectError: /not signed in/i,
		},
	];

	for (const tc of cases) {
		const root = makeTempRoot(t, "lh-agy-mismatch-");
		const p1 = makeSignedInProfile(root, "p1");
		const p2 = makeSignedInProfile(root, "p2");
		const spawns: SpawnRecord[] = [];
		let useAltRuntime = false;
		let useAltProfile = false;
		let enabled = true;
		let signedIn = true;

		const streamFn = createAntigravityStream({
			isEnabled: () => enabled,
			isSignedIn: () => signedIn,
			resolveRuntime: () => fakeRuntime(useAltRuntime ? "1.6.0" : "1.5.2"),
			ensureProfile: () => (useAltProfile ? p2.profileDir : p1.profileDir),
			spawnProcess: spySpawner(spawns, t),
			env: {
				...process.env,
				LH_AUTH_FILE: p1.authFile,
				FAKE_ACP_STREAM_MODE: "mcp-tool",
				FAKE_ACP_TOOL_NAME: "ask_user_question",
				FAKE_ACP_TEXT_ON_REPLAY: "1",
				FAKE_ACP_RECORD_EVENTS: "1",
			},
		});

		const userWithImage: Message = {
			role: "user",
			content: [
				{ type: "text", text: "Explain this circuit" },
				{ type: "image", data: "USER_PNG_BASE64", mimeType: "image/png" },
			],
			timestamp: 1,
		};

		const events1 = await collectEvents(
			streamFn(
				testModel("gemini-3.1-pro"),
				normalizeContext({
					systemPrompt: "Be encouraging.",
					messages: [userWithImage],
					tools: [ASK_USER_QUESTION_TOOL],
				}),
				{ sessionId: `sess-${tc.name}`, reasoning: "high" },
			),
		);
		const call1 = getToolCalls(events1)[0]!;
		const parkedSpawn = spawns[0]!;
		assert.equal(getParkedAntigravityProcessCount(), 1, tc.name);

		const trWithImage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call1.id,
			toolName: "ask_user_question",
			content: [
				{ type: "text", text: "Learner sketch attached" },
				{ type: "image", data: "RESULT_JPEG_BASE64", mimeType: "image/jpeg" },
			],
			isError: false,
			timestamp: 2,
		};

		const assistantMsg = (events1.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>).message;
		let nextMessages: Message[] = [userWithImage, assistantMsg, trWithImage];
		if (tc.mutateMessages) {
			nextMessages = tc.mutateMessages(nextMessages, call1.id);
		}
		if (tc.switchRuntime) useAltRuntime = true;
		if (tc.switchProfile) useAltProfile = true;
		if (tc.disableProvider) enabled = false;
		if (tc.signOut) signedIn = false;

		const nextOpts = tc.nextOptions
			? tc.nextOptions({ sessionId: `sess-${tc.name}`, reasoning: "high" })
			: { sessionId: `sess-${tc.name}`, reasoning: "high" as const };

		const events2 = await collectEvents(
			streamFn(
				tc.nextModel ?? testModel("gemini-3.1-pro"),
				normalizeContext({
					systemPrompt: tc.nextSystemPrompt ?? "Be encouraging.",
					messages: nextMessages,
					tools: tc.nextTools ?? [ASK_USER_QUESTION_TOOL],
				}),
				nextOpts,
			),
		);

		// Old parked process and its runDir must be torn down regardless of mismatch type.
		await waitForExit(parkedSpawn.child);
		await waitForDirRemoved(parkedSpawn.runDir);
		assert.equal(getParkedAntigravityProcessCount(), 0, tc.name);

		if (tc.expectError) {
			const last = events2.at(-1);
			assert.equal(last?.type, "error", tc.name);
			assert.match((last as Extract<AssistantMessageEvent, { type: "error" }>).error.errorMessage ?? "", tc.expectError);
			assert.equal(spawns.length, 1, `${tc.name}: should not spawn a new process when gated`);
		} else {
			assert.equal(spawns.length, 2, `${tc.name}: mismatch must cold-start a fresh process`);
			assert.match(getFinalText(events2), /^Replayed \d+ blocks$/);
			const activeProfileDir = tc.switchProfile ? p2.profileDir : p1.profileDir;
			const history = readPromptHistory(activeProfileDir);
			const replayed = history.at(-1)!;
			const types = replayed.prompt.map((b) => b.type);
			assert.ok(types.includes("image"), `${tc.name}: replayed prompt must preserve image blocks`);
			assert.equal(
				replayed.prompt.some((b) => b.type === "image" && b.data === "USER_PNG_BASE64" && b.mimeType === "image/png"),
				true,
				`${tc.name}: missing user image in cold-start replay`,
			);
			assert.equal(
				replayed.prompt.some((b) => b.type === "image" && b.data === "RESULT_JPEG_BASE64" && b.mimeType === "image/jpeg"),
				true,
				`${tc.name}: missing toolResult image in cold-start replay`,
			);
			await waitForExit(spawns[1]!.child);
			await waitForDirRemoved(spawns[1]!.runDir);
		}
	}
});

test("10-minute idle timeout kills orphaned parked process and subsequent tool result cold-starts with replay", async (t) => {
	assert.equal(LIVE_PROCESS_IDLE_TIMEOUT_MS, 10 * 60_000);
	const prevTimeout = antigravityIdleTimeoutMs.current;
	antigravityIdleTimeoutMs.current = 45;
	t.after(() => {
		antigravityIdleTimeoutMs.current = prevTimeout;
	});

	const root = makeTempRoot(t);
	const { authFile, profileDir } = makeSignedInProfile(root);
	const spawns: SpawnRecord[] = [];
	const streamFn = createAntigravityStream({
		isEnabled: () => true,
		isSignedIn: () => true,
		resolveRuntime: () => fakeRuntime(),
		ensureProfile: () => profileDir,
		spawnProcess: spySpawner(spawns, t),
		env: {
			...process.env,
			LH_AUTH_FILE: authFile,
			FAKE_ACP_STREAM_MODE: "mcp-tool",
			FAKE_ACP_TOOL_NAME: "ask_user_question",
			FAKE_ACP_TEXT_ON_REPLAY: "1",
			FAKE_ACP_RECORD_EVENTS: "1",
		},
	});

	const user1: Message = { role: "user", content: "Pause and wait", timestamp: 1 };
	const events1 = await collectEvents(
		streamFn(testModel(), normalizeContext({ systemPrompt: "Sys", messages: [user1], tools: [ASK_USER_QUESTION_TOOL] }), {
			sessionId: "idle-test",
		}),
	);
	const call1 = getToolCalls(events1)[0]!;
	assert.equal(getParkedAntigravityProcessCount(), 1);

	// Wait for idle timer expiry -> parked process and runDir must be torn down automatically.
	await waitForExit(spawns[0]!.child);
	await waitForDirRemoved(spawns[0]!.runDir);
	assert.equal(getParkedAntigravityProcessCount(), 0);
	assert.equal(getActiveAntigravityProcessCount(), 0);

	// Late learner answer cleanly cold-starts with replay instead of failing.
	const tr1: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call1.id,
		toolName: "ask_user_question",
		content: [{ type: "text", text: "Late answer" }],
		isError: false,
		timestamp: 2,
	};
	const assistantMsg = (events1.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>).message;
	const events2 = await collectEvents(
		streamFn(
			testModel(),
			normalizeContext({ systemPrompt: "Sys", messages: [user1, assistantMsg, tr1], tools: [ASK_USER_QUESTION_TOOL] }),
			{ sessionId: "idle-test" },
		),
	);
	assert.equal(spawns.length, 2);
	assert.match(getFinalText(events2), /^Replayed \d+ blocks$/);
});

test("abort during active turn sends cancel, closes stdin cleanly first, skips SIGTERM, escalates to SIGKILL, and removes temp runDir", async (t) => {
	const root = makeTempRoot(t);
	const { authFile, profileDir } = makeSignedInProfile(root);
	const lifecycleLog = path.join(root, "abort-lifecycle.jsonl");
	const spawns: SpawnRecord[] = [];
	const abortCtrl = new AbortController();

	const streamFn = createAntigravityStream({
		isEnabled: () => true,
		isSignedIn: () => true,
		resolveRuntime: () => fakeRuntime(),
		ensureProfile: () => profileDir,
		spawnProcess: spySpawner(spawns, t),
		cancelGraceMs: 40,
		env: {
			...process.env,
			LH_AUTH_FILE: authFile,
			FAKE_ACP_STREAM_MODE: "hang-for-cancel",
			FAKE_ACP_IGNORE_EOF: "1",
			FAKE_ACP_TRAP_SIGTERM: "1",
			FAKE_ACP_LIFECYCLE_LOG: lifecycleLog,
		},
	});

	const stream = streamFn(
		testModel(),
		normalizeContext({ messages: [{ role: "user", content: "Hang now", timestamp: 1 }], tools: [] }),
		{ sessionId: "abort-active", signal: abortCtrl.signal },
	);

	const events: AssistantMessageEvent[] = [];
	for await (const ev of stream) {
		events.push(ev);
		if (ev.type === "thinking_delta") {
			abortCtrl.abort();
		}
	}

	const last = events.at(-1);
	assert.equal(last?.type, "error");
	assert.equal((last as Extract<AssistantMessageEvent, { type: "error" }>).reason, "aborted");

	await waitForExit(spawns[0]!.child);
	await waitForDirRemoved(spawns[0]!.runDir);
	assert.equal(spawns[0]!.child.signalCode, "SIGKILL");

	const lifecycleEvents = fs
		.readFileSync(lifecycleLog, "utf8")
		.trim()
		.split("\n")
		.map((line) => (JSON.parse(line) as { event: string }).event);
	const cancelIdx = lifecycleEvents.indexOf("cancel");
	const eofIdx = lifecycleEvents.indexOf("stdin-eof");
	assert.ok(cancelIdx !== -1, `expected cancel event in ${lifecycleEvents.join(",")}`);
	assert.ok(eofIdx > cancelIdx, `expected stdin-eof after cancel in ${lifecycleEvents.join(",")}`);
	assert.equal(lifecycleEvents.includes("sigterm"), false, `SIGTERM must not be sent, saw: ${lifecycleEvents.join(",")}`);
});

test("abort while parked, pre-aborted continuation, and owner/sessionId isolation all behave cleanly", async (t) => {
	const root = makeTempRoot(t);
	const { authFile, profileDir } = makeSignedInProfile(root);
	const spawns: SpawnRecord[] = [];
	const deps: AntigravityStreamDeps = {
		isEnabled: () => true,
		isSignedIn: () => true,
		resolveRuntime: () => fakeRuntime(),
		ensureProfile: () => profileDir,
		spawnProcess: spySpawner(spawns, t),
		cancelGraceMs: 40,
		env: {
			...process.env,
			LH_AUTH_FILE: authFile,
			FAKE_ACP_STREAM_MODE: "mcp-tool",
			FAKE_ACP_TOOL_NAME: "ask_user_question",
			FAKE_ACP_TEXT_ON_REPLAY: "1",
		},
	};
	const streamFn = createAntigravityStream(deps);
	const otherStreamFn = createAntigravityStream(deps);

	// 1) Aborting the signal attached during turn1 while parked kills the parked ACP child and removes runDir.
	const waitAbort = new AbortController();
	const user1: Message = { role: "user", content: "Pause", timestamp: 1 };
	await collectEvents(
		streamFn(testModel(), normalizeContext({ messages: [user1], tools: [ASK_USER_QUESTION_TOOL] }), {
			sessionId: "abort-while-waiting",
			signal: waitAbort.signal,
		}),
	);
	assert.equal(getParkedAntigravityProcessCount(), 1);
	waitAbort.abort();
	await waitForExit(spawns[0]!.child);
	await waitForDirRemoved(spawns[0]!.runDir);
	assert.equal(getParkedAntigravityProcessCount(), 0);

	// 2) Pre-aborted continuation kills the matching parked process without spawning a replacement.
	const events1 = await collectEvents(
		streamFn(testModel(), normalizeContext({ messages: [user1], tools: [ASK_USER_QUESTION_TOOL] }), {
			sessionId: "abort-parked",
		}),
	);
	const call1 = getToolCalls(events1)[0]!;
	const assistant1 = (events1.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>).message;
	assert.equal(getParkedAntigravityProcessCount(), 1);

	const tr1: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call1.id,
		toolName: "ask_user_question",
		content: [{ type: "text", text: "User reply" }],
		isError: false,
		timestamp: 2,
	};
	const preAborted = new AbortController();
	preAborted.abort();

	const events2 = await collectEvents(
		streamFn(
			testModel(),
			normalizeContext({ messages: [user1, assistant1, tr1], tools: [ASK_USER_QUESTION_TOOL] }),
			{ sessionId: "abort-parked", signal: preAborted.signal },
		),
	);
	assert.equal(events2.at(-1)?.type, "error");
	assert.equal((events2.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>).reason, "aborted");
	assert.equal(spawns.length, 2);
	await waitForExit(spawns[1]!.child);
	await waitForDirRemoved(spawns[1]!.runDir);
	assert.equal(getParkedAntigravityProcessCount(), 0);

	// 3) Separate stream owners cannot hijack each other's parked process even with identical sessionId and toolCallId.
	const eventsOwned = await collectEvents(
		streamFn(testModel(), normalizeContext({ messages: [user1], tools: [ASK_USER_QUESTION_TOOL] }), {
			sessionId: "shared-session",
		}),
	);
	const callOwned = getToolCalls(eventsOwned)[0]!;
	const assistantOwned = (eventsOwned.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>).message;
	const trOwned: ToolResultMessage = {
		role: "toolResult",
		toolCallId: callOwned.id,
		toolName: "ask_user_question",
		content: [{ type: "text", text: "Answer" }],
		isError: false,
		timestamp: 3,
	};
	const eventsOtherOwner = await collectEvents(
		otherStreamFn(
			testModel(),
			normalizeContext({ messages: [user1, assistantOwned, trOwned], tools: [ASK_USER_QUESTION_TOOL] }),
			{ sessionId: "shared-session" },
		),
	);
	assert.match(getFinalText(eventsOtherOwner), /^Replayed \d+ blocks$/);
	assert.equal(spawns.length, 4, "different owner must cold-start instead of hijacking parked process");
});

test("stream and model discovery suppress run_workflow so no SKILL.md files are written to temporary workspaces", async (t) => {
	const root = makeTempRoot(t);
	const { authFile, profileDir } = makeSignedInProfile(root);
	const spawns: SpawnRecord[] = [];
	const env = {
		...process.env,
		LH_AUTH_FILE: authFile,
		LH_DATA_DIR: path.join(root, "data"),
		FAKE_ACP_RECORD_EVENTS: "1",
	};

	// Check models discovery temp workspace never receives SKILL.md (and removes temp dir).
	await discoverAntigravityModels(fakeRuntime(), {
		authFile,
		dataDir: env.LH_DATA_DIR,
		env,
		spawnProcess: spySpawner(spawns, t),
	});
	const sessRec1 = JSON.parse(
		fs.readFileSync(path.join(profileDir, "antigravity-acp", "last-session-new.json"), "utf8"),
	) as { sessionNewParams: { _meta: { antigravity: { disabledTools: string[] } } } };
	assert.ok(sessRec1.sessionNewParams._meta.antigravity.disabledTools.includes("run_workflow"));
	assert.equal(fs.existsSync(path.join(spawns[0]!.cwd, "skills", "system", "run-workflow", "SKILL.md")), false);

	// Check stream temp workspace while active/parked contains no SKILL.md.
	let sawCwdWithoutSkill = false;
	const streamFn = createAntigravityStream({
		isEnabled: () => true,
		isSignedIn: () => true,
		resolveRuntime: () => fakeRuntime(),
		ensureProfile: () => profileDir,
		spawnProcess: ((cmd: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
			const child = spySpawner(spawns, t)(cmd, args, options);
			const cwd = typeof options?.cwd === "string" ? options.cwd : "";
			setTimeout(() => {
				if (cwd && fs.existsSync(cwd)) {
					sawCwdWithoutSkill = !fs.existsSync(path.join(cwd, "skills", "system", "run-workflow", "SKILL.md"));
				}
			}, 30);
			return child;
		}) as NonNullable<AntigravityStreamDeps["spawnProcess"]>,
		env: { ...env, FAKE_ACP_STREAM_MODE: "mcp-tool", FAKE_ACP_TOOL_NAME: "ask_user_question" },
	});

	const events = await collectEvents(
		streamFn(
			testModel(),
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [ASK_USER_QUESTION_TOOL] }),
			{ sessionId: "no-skill-md" },
		),
	);
	assert.equal(events.at(-1)?.type, "done");
	const streamSpawn = spawns[1]!;
	assert.equal(fs.existsSync(path.join(streamSpawn.cwd, "skills", "system", "run-workflow", "SKILL.md")), false);
	await shutdownAntigravityProcesses();
	await waitForExit(streamSpawn.child);
	assert.equal(sawCwdWithoutSkill || !fs.existsSync(streamSpawn.runDir), true);
});

test("shutdownAntigravityProcesses closes all parked processes and cleans temp runDirs", async (t) => {
	const root = makeTempRoot(t);
	const { authFile, profileDir } = makeSignedInProfile(root);
	const spawns: SpawnRecord[] = [];
	const streamFn = createAntigravityStream({
		isEnabled: () => true,
		isSignedIn: () => true,
		resolveRuntime: () => fakeRuntime(),
		ensureProfile: () => profileDir,
		spawnProcess: spySpawner(spawns, t),
		env: {
			...process.env,
			LH_AUTH_FILE: authFile,
			FAKE_ACP_STREAM_MODE: "mcp-tool",
			FAKE_ACP_TOOL_NAME: "ask_user_question",
		},
	});

	await Promise.all([
		collectEvents(
			streamFn(
				testModel(),
				normalizeContext({ messages: [{ role: "user", content: "q1", timestamp: 1 }], tools: [ASK_USER_QUESTION_TOOL] }),
				{ sessionId: "shutdown-1" },
			),
		),
		collectEvents(
			streamFn(
				testModel(),
				normalizeContext({ messages: [{ role: "user", content: "q2", timestamp: 1 }], tools: [ASK_USER_QUESTION_TOOL] }),
				{ sessionId: "shutdown-2" },
			),
		),
	]);

	assert.equal(spawns.length, 2);
	assert.equal(getParkedAntigravityProcessCount(), 2);

	await shutdownAntigravityProcesses();
	await Promise.all(spawns.map((s) => waitForExit(s.child)));

	assert.equal(getParkedAntigravityProcessCount(), 0);
	assert.equal(getActiveAntigravityProcessCount(), 0);
	for (const s of spawns) {
		await waitForDirRemoved(s.runDir);
	}
});

test("process SIGTERM shutdown hook cleans up parked ACP grandchild and temp runDir", async (t) => {
	const root = makeTempRoot(t);
	const { authFile, profileDir } = makeSignedInProfile(root);
	const stateFile = path.join(root, "child-state.json");

	const script = `import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { toPiAntigravityModel } from ${JSON.stringify(path.resolve("src/agent/antigravity/provider.ts"))};
import { createAntigravityStream } from ${JSON.stringify(path.resolve("src/agent/antigravity/stream.ts"))};

let grandchildPid = 0;
let runDir = "";
const streamFn = createAntigravityStream({
	isEnabled: () => true,
	isSignedIn: () => true,
	resolveRuntime: () => ({
		source: "managed",
		kind: "acp-server",
		executablePath: ${JSON.stringify(FAKE_ACP)},
		harnessPath: "/tmp/localharness_external",
		args: [],
		version: "1.5.2",
	}),
	ensureProfile: () => ${JSON.stringify(profileDir)},
	spawnProcess: (cmd, args, options) => {
		const child = spawn(cmd, args, options);
		grandchildPid = child.pid ?? 0;
		runDir = path.dirname(String(options?.cwd ?? ""));
		return child;
	},
	env: {
		...process.env,
		LH_AUTH_FILE: ${JSON.stringify(authFile)},
		FAKE_ACP_STREAM_MODE: "mcp-tool",
		FAKE_ACP_TOOL_NAME: "ask_user_question",
	},
});

const model = toPiAntigravityModel({
	id: "gemini-3.1-pro",
	name: "Gemini 3.1 Pro",
	reasoning: true,
	supportedThinkingLevels: ["low", "medium", "high"],
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	input: ["text", "image"],
	contextWindow: null,
	maxTokens: null,
});

const tool = { name: "ask_user_question", description: "Ask", parameters: Type.Object({ question: Type.String() }) };
const stream = streamFn(model, normalizeContext({ messages: [{ role: "user", content: "park", timestamp: 1 }], tools: [tool] }), {
	sessionId: "sigterm-park",
});
for await (const _ev of stream) {}

fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({ grandchildPid, runDir }));
setInterval(() => {}, 1000);
`;

	const driver = spawn(process.execPath, ["--input-type=module", "--import", "tsx", "-e", script], {
		cwd: process.cwd(),
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let driverStderr = "";
	driver.stderr?.on("data", (chunk: Buffer) => {
		driverStderr += chunk.toString("utf8");
	});
	t.after(() => {
		if (driver.exitCode === null && driver.signalCode === null) {
			driver.kill("SIGKILL");
		}
	});

	// Wait until the driver writes stateFile showing the ACP process is parked.
	const deadline = Date.now() + 5_000;
	while (!fs.existsSync(stateFile) && Date.now() < deadline) {
		await sleep(25);
	}
	assert.ok(fs.existsSync(stateFile), `driver should park ACP process and write stateFile. stderr: ${driverStderr}`);
	const { grandchildPid, runDir } = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
		grandchildPid: number;
		runDir: string;
	};
	assert.ok(grandchildPid > 0);
	assert.ok(fs.existsSync(runDir));

	driver.kill("SIGTERM");
	await waitForExit(driver, 5_000);

	// Give the OS a brief moment to reap the grandchild after EOF/SIGKILL.
	const reapDeadline = Date.now() + 2_000;
	let grandchildAlive = true;
	while (Date.now() < reapDeadline) {
		try {
			process.kill(grandchildPid, 0);
			await sleep(25);
		} catch {
			grandchildAlive = false;
			break;
		}
	}
	assert.equal(grandchildAlive, false, "parked ACP grandchild must exit when host receives SIGTERM");
	await waitForDirRemoved(runDir);
});

test("parked ACP process that cancels/times out or moves on past held MCP tool call unparks cleanly and replays learner answer", async (t) => {
	for (const streamMode of ["mcp-tool-timeout-and-retry", "mcp-tool-move-on"] as const) {
		const root = makeTempRoot(t, `lh-agy-${streamMode}-`);
		const { authFile, profileDir } = makeSignedInProfile(root);
		const spawns: SpawnRecord[] = [];
		const streamFn = createAntigravityStream({
			isEnabled: () => true,
			isSignedIn: () => true,
			resolveRuntime: () => fakeRuntime(),
			ensureProfile: () => profileDir,
			spawnProcess: spySpawner(spawns, t),
			cancelGraceMs: 40,
			env: {
				...process.env,
				LH_AUTH_FILE: authFile,
				FAKE_ACP_STREAM_MODE: streamMode,
				FAKE_ACP_TEXT_ON_REPLAY: "1",
				FAKE_ACP_RECORD_EVENTS: "1",
			},
		});

		const user1: Message = { role: "user", content: "Ask me a question", timestamp: 1 };
		const events1 = await collectEvents(
			streamFn(testModel(), normalizeContext({ systemPrompt: "Sys", messages: [user1], tools: [ASK_USER_QUESTION_TOOL] }), {
				sessionId: `desync-${streamMode}`,
			}),
		);
		const call1 = getToolCalls(events1)[0]!;
		assert.equal(spawns.length, 1);

		// Wait for ACP to abort/move on while parked -> LearnHarness must unpark and kill the stale child.
		await waitForExit(spawns[0]!.child);
		await waitForDirRemoved(spawns[0]!.runDir);
		assert.equal(getParkedAntigravityProcessCount(), 0, `${streamMode}: should unpark stale ACP child`);
		assert.equal(getActiveAntigravityProcessCount(), 0, `${streamMode}: should unregister stale ACP child`);

		// Learner submits their answer -> must cold-start cleanly with replay instead of emitting duplicate tool calls or empty content[].
		const turn1Msg = (events1.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>).message;
		const tr1: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call1.id,
			toolName: "ask_user_question",
			content: [{ type: "text", text: "My real answer" }],
			isError: false,
			timestamp: 2,
		};
		const events2 = await collectEvents(
			streamFn(
				testModel(),
				normalizeContext({ systemPrompt: "Sys", messages: [user1, turn1Msg, tr1], tools: [ASK_USER_QUESTION_TOOL] }),
				{ sessionId: `desync-${streamMode}` },
			),
		);
		assert.equal(spawns.length, 2, `${streamMode}: learner answer must cold-start a fresh ACP session`);
		assert.match(getFinalText(events2), /^Replayed \d+ blocks$/);
		await waitForExit(spawns[1]!.child);
		await waitForDirRemoved(spawns[1]!.runDir);
	}
});
