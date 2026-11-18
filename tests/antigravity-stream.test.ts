import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Type, type AssistantMessageEvent, type AssistantMessageEventStream, type ToolResultMessage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { ResolvedAntigravityRuntime } from "../src/agent/antigravity/installation.ts";
import { antigravityTokenFilePath, ensureAntigravityProfile } from "../src/agent/antigravity/profile.ts";
import { toPiAntigravityModel } from "../src/agent/antigravity/provider.ts";
import { createAntigravityStream, isDeclaredLearnHarnessMcpPermission, shutdownAntigravityProcesses } from "../src/agent/antigravity/stream.ts";
import { measuredContextTokens } from "../src/core/context-usage.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const FAKE_ACP = path.resolve(import.meta.dirname, "fixtures", "antigravity", "fake-acp.mjs");

function makeTempRoot(prefix = "lh-agy-stream-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function testModel() {
	return toPiAntigravityModel({
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro",
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

async function collectEvents(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

test("createAntigravityStream translates thinking/text chunks, usage, cliContextWindow, and _meta session config", async () => {
	const root = makeTempRoot();
	const authFile = path.join(root, "auth.json");
	const env = {
		...process.env,
		LH_AUTH_FILE: authFile,
		FAKE_ACP_RECORD_EVENTS: "1",
		FAKE_ACP_CLI_WINDOW: "512000",
	};

	try {
		const profileDir = ensureAntigravityProfile({ authFile, env });
		fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

		const streamFn = createAntigravityStream({
			isEnabled: () => true,
			isSignedIn: () => true,
			resolveRuntime: () => fakeRuntime("1.4.5"),
			ensureProfile: () => profileDir,
			env,
		});

		const stream = streamFn(
			testModel(),
			normalizeContext({
				systemPrompt: "Teach calculus patiently.",
				messages: [{ role: "user", content: "Explain derivatives.", timestamp: 1 }],
				tools: [],
			}),
			{ reasoning: "high", sessionId: "chat-1" },
		);

		const events = await collectEvents(stream);
		const types = events.map((e) => e.type);
		assert.deepEqual(types, [
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"done",
		]);

		const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
		assert.equal(done.reason, "stop");
		const finalMsg = done.message as unknown as LhMessage & { content: Array<{ type: string; thinking?: string; text?: string }> };
		assert.equal(finalMsg.role, "assistant");
		assert.equal(finalMsg.content[0]?.thinking, "Thinking (high): analyzing.");
		assert.equal(finalMsg.content[1]?.text, "Hello from gemini-3.1-pro!");
		assert.equal(finalMsg.usage.input, 100);
		assert.equal(finalMsg.usage.output, 25);
		assert.equal(finalMsg.usage.cacheRead, 20);
		assert.equal(finalMsg.usage.cacheWrite, 5);
		assert.equal(finalMsg.usage.totalTokens, 140);
		assert.equal(finalMsg.usage.cost.total, 0);
		assert.equal(measuredContextTokens([{ ...finalMsg, id: "m1" } as unknown as LhMessage]), 150);
		assert.equal(finalMsg.cliContextWindow, 512000);

		const recordedSession = JSON.parse(
			fs.readFileSync(path.join(profileDir, "antigravity-acp", "last-session-new.json"), "utf8"),
		) as {
			initParams: { clientInfo: { name: string; version: string }; clientCapabilities: { fs: { readTextFile: boolean; writeTextFile: boolean }; terminal: boolean } };
			sessionNewParams: { _meta: { antigravity: { disabledTools: string[]; systemPrompt?: { append: string } } } };
		};
		assert.deepEqual(recordedSession.initParams.clientInfo, { name: "zed", version: "0.0.0" });
		assert.deepEqual(recordedSession.initParams.clientCapabilities, {
			fs: { readTextFile: false, writeTextFile: false },
			terminal: false,
		});
		assert.deepEqual(recordedSession.sessionNewParams._meta.antigravity.disabledTools, ["run_workflow"]);
		assert.equal(
			recordedSession.sessionNewParams._meta.antigravity.systemPrompt?.append,
			"Teach calculus patiently.",
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("createAntigravityStream executes declared LearnHarness MCP tools, rejects wrong auth & undeclared tools, and continues to final text", async () => {
	const root = makeTempRoot();
	const authFile = path.join(root, "auth.json");
	const env = {
		...process.env,
		LH_AUTH_FILE: authFile,
		FAKE_ACP_RECORD_EVENTS: "1",
		FAKE_ACP_STREAM_MODE: "mcp-tool",
		FAKE_ACP_TOOL_NAME: "probe_check",
		FAKE_ACP_TOOL_ARGS_JSON: JSON.stringify({ topic: "chain rule" }),
	};

	try {
		const profileDir = ensureAntigravityProfile({ authFile, env });
		fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

		const streamFn = createAntigravityStream({
			isEnabled: () => true,
			isSignedIn: () => true,
			resolveRuntime: () => fakeRuntime(),
			ensureProfile: () => profileDir,
			env,
		});

		const tools = [
			{
				name: "probe_check",
				description: "Record learner understanding",
				parameters: Type.Object({ topic: Type.String() }),
			},
		];
		const userMessage = { role: "user" as const, content: "Test me", timestamp: 1 };
		const initialCtx = normalizeContext({ systemPrompt: "Be concise.", messages: [userMessage], tools });

		// Step 1: receives MCP tool call emitted cleanly via toolcall_start/delta/end
		const step1Events = await collectEvents(
			streamFn(testModel(), initialCtx, { sessionId: "chat-mcp" }),
		);
		const step1Done = step1Events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
		assert.equal(step1Done.reason, "toolUse");
		const toolCallBlock = step1Done.message.content.find((b) => b.type === "toolCall");
		assert.ok(toolCallBlock && toolCallBlock.type === "toolCall");
		assert.equal(toolCallBlock.name, "probe_check");
		assert.deepEqual(toolCallBlock.arguments, { topic: "chain rule" });

		// Step 2: supply ToolResultMessage back into streamFn -> resumes held MCP HTTP call on same ACP session
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCallBlock.id,
			toolName: "probe_check",
			content: [{ type: "text", text: "Recorded probe for chain rule" }],
			isError: false,
			timestamp: 2,
		};
		const step2Events = await collectEvents(
			streamFn(
				testModel(),
				normalizeContext({
					systemPrompt: "Be concise.",
					messages: [userMessage, step1Done.message, toolResult],
					tools,
				}),
				{ sessionId: "chat-mcp" },
			),
		);
		const step2Done = step2Events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
		assert.equal(step2Done.reason, "stop");
		const finalText = step2Done.message.content.find((b) => b.type === "text");
		assert.ok(finalText && finalText.type === "text");
		assert.equal(finalText.text, "Tool returned: Recorded probe for chain rule");

		// Verify bridge audited 401 on wrong token and only listed declared tools
		const audit = JSON.parse(
			fs.readFileSync(path.join(profileDir, "antigravity-acp", "last-mcp-audit.json"), "utf8"),
		) as {
			badAuthStatus: number;
			listedTools: string[];
			undeclaredError: { message?: string } | null;
		};
		assert.equal(audit.badAuthStatus, 401);
		assert.deepEqual(audit.listedTools, ["probe_check"]);

		// Verify calling an undeclared tool fails closed on the bridge and aborts the turn
		const undeclaredStream = createAntigravityStream({
			isEnabled: () => true,
			isSignedIn: () => true,
			resolveRuntime: () => fakeRuntime(),
			ensureProfile: () => profileDir,
			env: { ...env, FAKE_ACP_TEST_UNDECLARED: "1" },
		})(testModel(), normalizeContext({ systemPrompt: "Be concise.", messages: [userMessage], tools }), {
			sessionId: "chat-mcp-undeclared",
		});
		const undeclaredEvents = await collectEvents(undeclaredStream);
		const undeclaredEnd = undeclaredEvents.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>;
		assert.equal(undeclaredEnd.type, "error");
		assert.match(undeclaredEnd.error.errorMessage ?? "", /undeclared harness tool: run_workflow/i);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("createAntigravityStream unconditionally declines session/request_permission, handles abort cancel, refusal, and Linux IPv6 hint", async () => {
	const root = makeTempRoot();
	const authFile = path.join(root, "auth.json");

	try {
		const profileDir = ensureAntigravityProfile({ authFile, env: { ...process.env, LH_AUTH_FILE: authFile } });
		fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

		// 1) Native permission request declined
		const permStream = createAntigravityStream({
			isEnabled: () => true,
			isSignedIn: () => true,
			resolveRuntime: () => fakeRuntime(),
			ensureProfile: () => profileDir,
			env: {
				...process.env,
				LH_AUTH_FILE: authFile,
				FAKE_ACP_STREAM_MODE: "permission-then-text",
			},
		})(testModel(), normalizeContext({ messages: [{ role: "user", content: "Run shell", timestamp: 1 }], tools: [] }));
		const permEvents = await collectEvents(permStream);
		const permDone = permEvents.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
		assert.equal((permDone.message.content[0] as { text?: string }).text, "permission:cancelled");

		// 2) Abort signal sends session/cancel and ends with aborted
		const abortCtrl = new AbortController();
		const hangStream = createAntigravityStream({
			isEnabled: () => true,
			isSignedIn: () => true,
			resolveRuntime: () => fakeRuntime(),
			ensureProfile: () => profileDir,
			env: {
				...process.env,
				LH_AUTH_FILE: authFile,
				FAKE_ACP_STREAM_MODE: "hang-for-cancel",
			},
		})(testModel(), normalizeContext({ messages: [{ role: "user", content: "Hang", timestamp: 1 }], tools: [] }), { signal: abortCtrl.signal });
		const abortEvents: AssistantMessageEvent[] = [];
		for await (const ev of hangStream) {
			abortEvents.push(ev);
			if (ev.type === "thinking_delta") {
				abortCtrl.abort();
			}
		}
		const aborted = abortEvents.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>;
		assert.equal(aborted.type, "error");
		assert.equal(aborted.reason, "aborted");

		// 3) Refusal stopReason surfaces as error
		const refusalStream = createAntigravityStream({
			isEnabled: () => true,
			isSignedIn: () => true,
			resolveRuntime: () => fakeRuntime(),
			ensureProfile: () => profileDir,
			env: {
				...process.env,
				LH_AUTH_FILE: authFile,
				FAKE_ACP_STREAM_MODE: "refusal",
			},
		})(testModel(), normalizeContext({ messages: [{ role: "user", content: "Refuse", timestamp: 1 }], tools: [] }));
		const refusalEvents = await collectEvents(refusalStream);
		const refusalErr = refusalEvents.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>;
		assert.equal(refusalErr.type, "error");
		assert.equal(refusalErr.reason, "error");

		// 4) Linux AF_INET6 / enforce_kernel_ipv6_support surfaces actionable hint
		const ipv6Stream = createAntigravityStream({
			isEnabled: () => true,
			isSignedIn: () => true,
			resolveRuntime: () => fakeRuntime(),
			ensureProfile: () => profileDir,
			platform: "linux",
			env: {
				...process.env,
				LH_AUTH_FILE: authFile,
				FAKE_ACP_STREAM_MODE: "ipv6-error",
			},
		})(testModel(), normalizeContext({ messages: [{ role: "user", content: "IPv6", timestamp: 1 }], tools: [] }));
		const ipv6Events = await collectEvents(ipv6Stream);
		const ipv6Err = ipv6Events.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>;
		assert.equal(ipv6Err.type, "error");
		assert.match(ipv6Err.error.errorMessage ?? "", /Linux.*IPv6/i);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("isDeclaredLearnHarnessMcpPermission authorizes only declared learnharness MCP tools on the active session", () => {
	const declared = new Set(["submit_findings", "read"]);
	assert.equal(
		isDeclaredLearnHarnessMcpPermission(
			{
				sessionId: "sess-1",
				toolCall: { _meta: { is_mcp_tool_call: true, mcp: { server: "learnharness", tool: "submit_findings" } } },
			},
			declared,
			"sess-1",
		),
		true,
	);
	// Rejects native tool (missing _meta.is_mcp_tool_call)
	assert.equal(
		isDeclaredLearnHarnessMcpPermission(
			{ sessionId: "sess-1", toolCall: { title: "learnharness_submit_findings" } },
			declared,
			"sess-1",
		),
		false,
	);
	// Rejects external MCP server
	assert.equal(
		isDeclaredLearnHarnessMcpPermission(
			{
				sessionId: "sess-1",
				toolCall: { _meta: { is_mcp_tool_call: true, mcp: { server: "other", tool: "submit_findings" } } },
			},
			declared,
			"sess-1",
		),
		false,
	);
	// Rejects undeclared tool name
	assert.equal(
		isDeclaredLearnHarnessMcpPermission(
			{
				sessionId: "sess-1",
				toolCall: { _meta: { is_mcp_tool_call: true, mcp: { server: "learnharness", tool: "run_workflow" } } },
			},
			declared,
			"sess-1",
		),
		false,
	);
	// Rejects mismatched session
	assert.equal(
		isDeclaredLearnHarnessMcpPermission(
			{
				sessionId: "sess-2",
				toolCall: { _meta: { is_mcp_tool_call: true, mcp: { server: "learnharness", tool: "submit_findings" } } },
			},
			declared,
			"sess-1",
		),
		false,
	);
});

test("createAntigravityStream approves learnharness MCP permission requests and declines other MCP servers", async () => {
	const root = makeTempRoot();
	const authFile = path.join(root, "auth.json");

	try {
		const profileDir = ensureAntigravityProfile({ authFile, env: { ...process.env, LH_AUTH_FILE: authFile } });
		fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

		const tools = [
			{
				name: "submit_findings",
				description: "Submit extracted findings",
				parameters: Type.Object({ topic: Type.String() }),
			},
		];
		const userMessage = { role: "user" as const, content: "Extract", timestamp: 1 };

		// 1) Declared learnharness MCP tool requesting session/request_permission is allowed and admitted via bridge
		const allowedEnv = {
			...process.env,
			LH_AUTH_FILE: authFile,
			FAKE_ACP_RECORD_EVENTS: "1",
			FAKE_ACP_STREAM_MODE: "mcp-tool",
			FAKE_ACP_REQUIRE_MCP_PERMISSION: "1",
			FAKE_ACP_TOOL_NAME: "submit_findings",
			FAKE_ACP_TOOL_ARGS_JSON: JSON.stringify({ topic: "tcp" }),
		};
		const streamFn = createAntigravityStream({
			isEnabled: () => true,
			isSignedIn: () => true,
			resolveRuntime: () => fakeRuntime("1.4.5"),
			ensureProfile: () => profileDir,
			env: allowedEnv,
		});
		const allowedStream = streamFn(
			testModel(),
			normalizeContext({ systemPrompt: "Extract.", messages: [userMessage], tools }),
			{ sessionId: "chat-mcp-perm-ok" },
		);
		const step1Events = await collectEvents(allowedStream);
		const step1Done = step1Events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
		assert.equal(step1Done.reason, "toolUse");
		const toolCall = step1Done.message.content.find((b) => b.type === "toolCall");
		assert.ok(toolCall && toolCall.type === "toolCall");
		assert.equal(toolCall.name, "submit_findings");

		const recordedPerm = JSON.parse(
			fs.readFileSync(path.join(profileDir, "antigravity-acp", "last-permission-response.json"), "utf8"),
		) as { result?: { outcome?: { outcome?: string; optionId?: string } } };
		assert.equal(recordedPerm.result?.outcome?.outcome, "selected");
		assert.equal(recordedPerm.result?.outcome?.optionId, "allow");

		// Finish turn cleanly so parked process closes
		const step2Events = await collectEvents(
			streamFn(
				testModel(),
				normalizeContext({
					systemPrompt: "Extract.",
					messages: [
						userMessage,
						step1Done.message,
						{
							role: "toolResult",
							toolCallId: toolCall.id,
							toolName: "submit_findings",
							content: [{ type: "text", text: "ok" }],
							isError: false,
							timestamp: 2,
						},
					],
					tools,
				}),
				{ sessionId: "chat-mcp-perm-ok" },
			),
		);
		assert.equal((step2Events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>).reason, "stop");

		// 2) External/spoofed MCP server requesting session/request_permission is declined
		const deniedStream = createAntigravityStream({
			isEnabled: () => true,
			isSignedIn: () => true,
			resolveRuntime: () => fakeRuntime("1.4.5"),
			ensureProfile: () => profileDir,
			env: {
				...allowedEnv,
				FAKE_ACP_MCP_SERVER_NAME: "rogue-server",
			},
		})(testModel(), normalizeContext({ systemPrompt: "Extract.", messages: [userMessage], tools }), {
			sessionId: "chat-mcp-perm-denied",
		});
		const deniedEvents = await collectEvents(deniedStream);
		const deniedDone = deniedEvents.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
		assert.equal(deniedDone.reason, "stop");
		assert.equal((deniedDone.message.content[0] as { text?: string }).text, "mcp-permission:cancelled");
	} finally {
		await shutdownAntigravityProcesses();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("createAntigravityStream prefers single-call usage_update.used over larger multi-call cumulative PromptResponse.usage", async () => {
	const root = makeTempRoot();
	const authFile = path.join(root, "auth.json");
	const env = {
		...process.env,
		LH_AUTH_FILE: authFile,
		FAKE_ACP_CLI_WINDOW: "1048576",
		FAKE_ACP_USAGE_JSON: JSON.stringify({
			inputTokens: 400,
			outputTokens: 25,
			cachedReadTokens: 350,
			totalTokens: 425,
		}),
	};

	try {
		const profileDir = ensureAntigravityProfile({ authFile, env });
		fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

		const streamFn = createAntigravityStream({
			isEnabled: () => true,
			isSignedIn: () => true,
			resolveRuntime: () => fakeRuntime("1.4.5"),
			ensureProfile: () => profileDir,
			env,
		});

		const stream = streamFn(
			testModel(),
			normalizeContext({
				systemPrompt: "Teach calculus patiently.",
				messages: [{ role: "user", content: "Explain derivatives.", timestamp: 1 }],
				tools: [],
			}),
			{ reasoning: "high", sessionId: "chat-multicall-usage" },
		);

		const events = await collectEvents(stream);
		const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
		assert.equal(done.reason, "stop");
		const finalMsg = done.message as unknown as LhMessage & { usage: NonNullable<typeof done.message.usage> };
		assert.equal(finalMsg.usage.input, 150);
		assert.equal(finalMsg.usage.totalTokens, 150);
		assert.equal(measuredContextTokens([{ ...finalMsg, id: "m-multi" }]), 150);
		assert.equal(finalMsg.cliContextWindow, 1048576);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("createAntigravityStream works with kind='cli' (agy 1.5.10), antigravity-oauth-token, and --gemini-dir flags", async () => {
	const root = makeTempRoot();
	const authFile = path.join(root, "auth.json");
	const env = {
		...process.env,
		LH_AUTH_FILE: authFile,
		FAKE_ACP_MODE: "cli-1510",
		FAKE_ACP_RECORD_EVENTS: "1",
	};

	try {
		const profileDir = ensureAntigravityProfile({ authFile, env });
		const { antigravityCliTokenFilePath } = await import("../src/agent/antigravity/profile.ts");
		fs.writeFileSync(
			antigravityCliTokenFilePath(profileDir),
			JSON.stringify({ access_token: "cli-tok", refresh_token: "cli-ref" }),
			{ mode: 0o600 },
		);

		const streamFn = createAntigravityStream({
			isEnabled: () => true,
			resolveRuntime: () => ({
				source: "cli",
				kind: "cli",
				executablePath: FAKE_ACP,
				args: ["acp"],
				version: "1.5.10",
			}),
			ensureProfile: () => profileDir,
			env,
		});

		const stream = streamFn(
			testModel(),
			normalizeContext({
				systemPrompt: "Be helpful.",
				messages: [{ role: "user", content: "Hello CLI", timestamp: 1 }],
				tools: [],
			}),
			{ reasoning: "high", sessionId: "chat-cli-1510" },
		);

		const events = await collectEvents(stream);
		const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
		assert.equal(done.reason, "stop");
		const recordedArgv = JSON.parse(
			fs.readFileSync(path.join(profileDir, "antigravity-acp", "last-argv.json"), "utf8"),
		) as { argv: string[] };
		assert.deepEqual(recordedArgv.argv, ["acp", "--gemini-dir", profileDir, "--app-data-dir", "antigravity-acp"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("createAntigravityStream nudges once in-session on thinking-only stopReason=stop and recovers text or MCP toolCall", async () => {
	const root = makeTempRoot();
	const authFile = path.join(root, "auth.json");

	try {
		const profileDir = ensureAntigravityProfile({ authFile, env: { ...process.env, LH_AUTH_FILE: authFile } });
		fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

		// 1) Recovers into learner-facing text on the same ACP session
		const textEnv = {
			...process.env,
			LH_AUTH_FILE: authFile,
			FAKE_ACP_RECORD_EVENTS: "1",
			FAKE_ACP_STREAM_MODE: "thinking-only-then-text",
			FAKE_ACP_TEXT: "Recovered answer after thinking.",
		};
		const textStreamFn = createAntigravityStream({
			isEnabled: () => true,
			isSignedIn: () => true,
			resolveRuntime: () => fakeRuntime("1.4.5"),
			ensureProfile: () => profileDir,
			env: textEnv,
		});
		const textEvents = await collectEvents(
			textStreamFn(
				testModel(),
				normalizeContext({
					systemPrompt: "Probe the learner.",
					messages: [{ role: "user", content: "Teach me derivatives", timestamp: 1 }],
					tools: [],
				}),
				{ reasoning: "high", sessionId: "chat-agy-nudge-text" },
			),
		);
		const textDone = textEvents.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
		assert.equal(textDone.type, "done");
		assert.equal(textDone.reason, "stop");
		assert.equal(
			textDone.message.content.find((b) => b.type === "text")?.type === "text"
				? (textDone.message.content.find((b) => b.type === "text") as { text: string }).text
				: "",
			"Recovered answer after thinking.",
		);

		const historyLines = fs
			.readFileSync(path.join(profileDir, "antigravity-acp", "prompt-history.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { sessionId: string; promptNumber: number; prompt: Array<{ text?: string }> });
		assert.equal(historyLines.length, 2);
		assert.equal(historyLines[0]?.sessionId, historyLines[1]?.sessionId);
		assert.equal(historyLines[1]?.promptNumber, 2);
		assert.match(historyLines[1]?.prompt[0]?.text ?? "", /thinking only/i);

		// 2) Recovers into an MCP tool call and completes the held call normally
		const mcpEnv = {
			...process.env,
			LH_AUTH_FILE: authFile,
			FAKE_ACP_STREAM_MODE: "thinking-only-then-mcp-tool",
			FAKE_ACP_TOOL_NAME: "probe_check",
			FAKE_ACP_TOOL_ARGS_JSON: JSON.stringify({ topic: "limits" }),
		};
		const mcpStreamFn = createAntigravityStream({
			isEnabled: () => true,
			isSignedIn: () => true,
			resolveRuntime: () => fakeRuntime("1.4.5"),
			ensureProfile: () => profileDir,
			env: mcpEnv,
		});
		const tools = [
			{
				name: "probe_check",
				description: "Record learner understanding",
				parameters: Type.Object({ topic: Type.String() }),
			},
		];
		const userMessage = { role: "user" as const, content: "Test me", timestamp: 1 };
		const step1Events = await collectEvents(
			mcpStreamFn(testModel(), normalizeContext({ systemPrompt: "Probe.", messages: [userMessage], tools }), {
				sessionId: "chat-agy-nudge-mcp",
			}),
		);
		const step1Done = step1Events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
		assert.equal(step1Done.type, "done");
		assert.equal(step1Done.reason, "toolUse");
		const toolCall = step1Done.message.content.find((b) => b.type === "toolCall");
		assert.ok(toolCall && toolCall.type === "toolCall");
		assert.equal(toolCall.name, "probe_check");

		const step2Events = await collectEvents(
			mcpStreamFn(
				testModel(),
				normalizeContext({
					systemPrompt: "Probe.",
					messages: [
						userMessage,
						step1Done.message,
						{
							role: "toolResult",
							toolCallId: toolCall.id,
							toolName: "probe_check",
							content: [{ type: "text", text: "Recorded probe" }],
							isError: false,
							timestamp: 2,
						},
					],
					tools,
				}),
				{ sessionId: "chat-agy-nudge-mcp" },
			),
		);
		const step2Done = step2Events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
		assert.equal(step2Done.reason, "stop");
	} finally {
		await shutdownAntigravityProcesses();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("createAntigravityStream fails with stopReason=error after one nudge if output stays thinking-only or whitespace-only", async () => {
	const root = makeTempRoot();
	const authFile = path.join(root, "auth.json");

	try {
		const profileDir = ensureAntigravityProfile({ authFile, env: { ...process.env, LH_AUTH_FILE: authFile } });
		fs.writeFileSync(antigravityTokenFilePath(profileDir), JSON.stringify({ token: "tok" }), { mode: 0o600 });

		for (const streamMode of ["thinking-only-always", "thinking-whitespace-only"] as const) {
			const historyPath = path.join(profileDir, "antigravity-acp", "prompt-history.jsonl");
			fs.rmSync(historyPath, { force: true });

			const streamFn = createAntigravityStream({
				isEnabled: () => true,
				isSignedIn: () => true,
				resolveRuntime: () => fakeRuntime("1.4.5"),
				ensureProfile: () => profileDir,
				env: {
					...process.env,
					LH_AUTH_FILE: authFile,
					FAKE_ACP_RECORD_EVENTS: "1",
					FAKE_ACP_STREAM_MODE: streamMode,
				},
			});
			const events = await collectEvents(
				streamFn(
					testModel(),
					normalizeContext({
						systemPrompt: "Probe.",
						messages: [{ role: "user", content: "Start", timestamp: 1 }],
						tools: [],
					}),
					{ reasoning: "high", sessionId: `chat-agy-${streamMode}` },
				),
			);
			const end = events.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>;
			assert.equal(end.type, "error");
			assert.equal(end.reason, "error");
			assert.equal(end.error.stopReason, "error");
			assert.match(end.error.errorMessage ?? "", /thinking only/i);
			assert.ok(end.error.content.some((b) => b.type === "thinking"));
			assert.equal(end.error.usage.totalTokens, 100);

			const historyLines = fs.readFileSync(historyPath, "utf8").trim().split("\n");
			assert.equal(historyLines.length, 2, `${streamMode} must nudge at most once`);
		}
	} finally {
		await shutdownAntigravityProcesses();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
