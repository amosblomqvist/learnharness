#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as readline from "node:readline";

const mode = process.env.FAKE_ACP_MODE ?? "ok";
const authMode = process.env.FAKE_ACP_AUTH_MODE ?? "browser-and-stderr";
const logoutMode = process.env.FAKE_ACP_LOGOUT_MODE ?? "ok";
const streamMode = process.env.FAKE_ACP_STREAM_MODE ?? "text";
const recordEvents = process.env.FAKE_ACP_RECORD_EVENTS === "1";
const ignoreEof = process.env.FAKE_ACP_IGNORE_EOF === "1";
const trapSigterm = process.env.FAKE_ACP_TRAP_SIGTERM === "1";
const lifecycleLogPath = process.env.FAKE_ACP_LIFECYCLE_LOG;

const argv = process.argv.slice(2);
const hasAcpSubcommand = argv[0] === "acp";
let cliGeminiDir = null;
let cliAppDataDir = null;
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === "--gemini-dir" && argv[i + 1]) {
		cliGeminiDir = argv[++i];
	} else if (arg.startsWith("--gemini-dir=")) {
		cliGeminiDir = arg.slice("--gemini-dir=".length);
	} else if (arg === "--app-data-dir" && argv[i + 1]) {
		cliAppDataDir = argv[++i];
	} else if (arg.startsWith("--app-data-dir=")) {
		cliAppDataDir = arg.slice("--app-data-dir=".length);
	}
}

if (mode === "immediate-exit") {
	process.exit(2);
}

let activeServer = null;
let recordedInitParams = null;
const sessions = new Map();
const pendingIncomingResponses = new Map();
const activePrompts = new Map();

function logLifecycle(event) {
	if (!lifecycleLogPath) return;
	fs.mkdirSync(path.dirname(lifecycleLogPath), { recursive: true });
	fs.appendFileSync(lifecycleLogPath, `${JSON.stringify({ pid: process.pid, event, at: Date.now() })}\n`);
}

if (trapSigterm) {
	process.on("SIGTERM", () => {
		logLifecycle("sigterm");
	});
}

function writeOut(payload) {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function effectiveAppDataDir() {
	const base = cliGeminiDir ?? process.env.GEMINI_HOME;
	if (!base) return null;
	return path.join(base, cliAppDataDir ?? "antigravity-acp");
}

function recordArtifact(filename, data) {
	const dir = effectiveAppDataDir();
	if (!recordEvents || !dir) return;
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
}

function appendArtifactLine(filename, data) {
	const dir = effectiveAppDataDir();
	if (!recordEvents || !dir) return;
	fs.mkdirSync(dir, { recursive: true });
	fs.appendFileSync(path.join(dir, filename), `${JSON.stringify(data)}\n`);
}

function simulateSkillFileIfWorkflowEnabled(cwd, meta) {
	const disabledTools = meta?.antigravity?.disabledTools;
	if (!Array.isArray(disabledTools) || !disabledTools.includes("run_workflow")) {
		const skillPath = path.join(cwd, "skills", "system", "run-workflow", "SKILL.md");
		fs.mkdirSync(path.dirname(skillPath), { recursive: true });
		fs.writeFileSync(skillPath, "# run-workflow\n");
	}
}

function getFixtureModels() {
	if (process.env.FAKE_ACP_MODELS_JSON) {
		try {
			return JSON.parse(process.env.FAKE_ACP_MODELS_JSON);
		} catch {
			return [];
		}
	}
	const includeCtx = process.env.FAKE_ACP_INCLUDE_CONTEXT === "1";
	return [
		{
			value: "gemini-3.1-pro",
			name: "Gemini 3.1 Pro",
			...(includeCtx ? { contextWindow: 1000000, maxTokens: 65536 } : {}),
			thoughtValues: ["low", "medium", "high"],
		},
		{
			value: "gemini-3-flash",
			name: "Gemini 3 Flash",
			thoughtValues: ["off", "minimal", "low", "medium", "high"],
		},
		{
			value: "non-reasoning-mini",
			name: "Non-Reasoning Mini",
			thoughtValues: [],
		},
	];
}

function buildConfigOptions(models, selectedModelId, selectedThought) {
	const modelChoices = models.map((m) => {
		const copy = { ...m };
		delete copy.thoughtValues;
		return copy;
	});
	const active = models.find((m) => m.value === selectedModelId) ?? models[0];
	const thoughtValues = active?.thoughtValues ?? [];
	const currentThought = selectedThought && thoughtValues.includes(selectedThought) ? selectedThought : thoughtValues[0] ?? "";
	const options = [
		{
			id: "model",
			category: "model",
			type: "select",
			currentValue: active?.value ?? "",
			options: modelChoices,
		},
	];
	if (thoughtValues.length > 0) {
		options.push({
			id: "thought_level",
			category: "thought_level",
			type: "select",
			currentValue: currentThought,
			options: thoughtValues.map((v) => ({ value: v, name: v })),
		});
	}
	return options;
}

function sendClientRequest(method, params) {
	const id = `srv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	return new Promise((resolve) => {
		pendingIncomingResponses.set(id, resolve);
		writeOut({ jsonrpc: "2.0", id, method, params });
	});
}

function emitSessionUpdate(sessionId, update) {
	writeOut({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId, update },
	});
}

async function parseMcpResponseBody(response) {
	const text = await response.text();
	const trimmed = text.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return JSON.parse(trimmed);
	}
	// Parse SSE data lines
	let lastJson = null;
	for (const line of trimmed.split(/\r?\n/)) {
		if (line.startsWith("data:")) {
			const payload = line.slice(5).trim();
			if (payload) {
				try {
					lastJson = JSON.parse(payload);
				} catch {
					// ignore keepalives
				}
			}
		}
	}
	return lastJson;
}

async function callMcpJsonRpc(url, authHeader, sessionId, payload, signal) {
	const headers = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		...(authHeader ? { Authorization: authHeader } : {}),
		...(sessionId ? { "mcp-session-id": sessionId } : {}),
	};
	const res = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
		...(signal ? { signal } : {}),
	});
	const nextSessionId = res.headers.get("mcp-session-id") ?? sessionId;
	const body = await parseMcpResponseBody(res);
	return { status: res.status, sessionId: nextSessionId, body };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let msg;
	try {
		msg = JSON.parse(trimmed);
	} catch {
		return;
	}

	// Responses to server-initiated requests (e.g. session/request_permission)
	if (msg.id !== undefined && !msg.method && pendingIncomingResponses.has(msg.id)) {
		const resolver = pendingIncomingResponses.get(msg.id);
		pendingIncomingResponses.delete(msg.id);
		resolver(msg);
		return;
	}

	if (msg.method === "initialize") {
		recordedInitParams = msg.params ?? null;
		if (mode === "hang") {
			return;
		}
		if (mode === "error") {
			writeOut({
				jsonrpc: "2.0",
				id: msg.id,
				error: { code: -32000, message: "synthetic initialize error" },
			});
			return;
		}
		if (mode === "wrong-agent") {
			writeOut({
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					protocolVersion: 1,
					agentInfo: { name: "not-antigravity", version: "1.0.0" },
				},
			});
			return;
		}
		if (mode === "require-scrubbed-env") {
			const forbidden = [
				"GEMINI_API_KEY",
				"GOOGLE_API_KEY",
				"GOOGLE_APPLICATION_CREDENTIALS",
				"GOOGLE_CLOUD_PROJECT",
				"GOOGLE_CLOUD_LOCATION",
				"GOOGLE_CLOUD_QUOTA_PROJECT",
				"GOOGLE_GENAI_USE_VERTEXAI",
				"GCLOUD_PROJECT",
				"CLOUDSDK_CORE_PROJECT",
			];
			if (forbidden.some((k) => Boolean(process.env[k]))) {
				writeOut({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32001, message: "ambient google env leaked" },
				});
				return;
			}
			if (!process.env.GEMINI_HOME || process.env.AGY_ACP_FORCE_FILE_STORAGE !== "1") {
				writeOut({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32002, message: "missing isolated profile env" },
				});
				return;
			}
		}

		if (mode === "cli-1510") {
			if (!hasAcpSubcommand || !cliGeminiDir || cliAppDataDir !== "antigravity-acp") {
				writeOut({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32003, message: "missing cli acp --gemini-dir/--app-data-dir flags" },
				});
				return;
			}
			const markerPath = path.join(cliGeminiDir, "antigravity-acp", "cache", "antigravity-keyring-unavailable");
			if (!fs.existsSync(markerPath)) {
				writeOut({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32003, message: "missing keyring unavailable marker" },
				});
				return;
			}
		}

		if (process.env.FAKE_ACP_RECORD_CLIENT_INFO === "1") {
			const dir = effectiveAppDataDir();
			if (dir) {
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, "last-client-info.json"), JSON.stringify(msg.params?.clientInfo ?? null));
			}
		}
		recordArtifact("last-argv.json", { argv });

		writeOut({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				protocolVersion: 1,
				agentCapabilities: {
					loadSession: true,
					sessionCapabilities: { resume: {} },
					auth: { logout: {} },
				},
				authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
				agentInfo: {
					name: mode === "cli-1510" ? "Antigravity ACP Server" : "antigravity-acp",
					title: "Google Antigravity",
					version: process.env.FAKE_ACP_VERSION ?? (mode === "cli-1510" ? "1.5.10" : "1.4.5"),
				},
			},
		});
		return;
	}

	if (msg.method === "authenticate") {
		if (authMode === "auth-error") {
			writeOut({
				jsonrpc: "2.0",
				id: msg.id,
				error: { code: -32005, message: "synthetic auth error" },
			});
			return;
		}
		if (authMode === "invalid-url") {
			process.stderr.write(
				"Open the following link to authenticate the ACP server: https://evil.example.com/o/oauth2/v2/auth?response_type=code&state=bad\n",
			);
			return;
		}
		if (mode === "cli-1510") {
			if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY) {
				writeOut({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32005, message: "browser sign-in is disabled over SSH" },
				});
				return;
			}
			if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
				writeOut({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32005, message: "no display server available" },
				});
				return;
			}
		}

		const expectedState = process.env.FAKE_ACP_STATE ?? "fake-oauth-state-123";
		const server = http.createServer((req, res) => {
			const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
			if (mode === "cli-1510" && reqUrl.pathname !== "/auth/callback") {
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Not found");
				return;
			}
			if (reqUrl.searchParams.get("state") !== expectedState) {
				res.writeHead(400, { "Content-Type": "text/plain" });
				res.end("Invalid state");
				return;
			}
			const appDir = effectiveAppDataDir();
			if (appDir) {
				const tokenPath =
					mode === "cli-1510"
						? path.join(appDir, "antigravity-oauth-token")
						: path.join(appDir, "acp_token.json");
				fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
				const tokenPayload =
					mode === "cli-1510"
						? {
								access_token: "fake-cli-access-token",
								refresh_token: "fake-cli-refresh-token",
								token_type: "Bearer",
								code: reqUrl.searchParams.get("code") ?? "fake-code",
							}
						: {
								token: "fake-access-token",
								refresh_token: "fake-refresh-token",
								code: reqUrl.searchParams.get("code") ?? "fake-code",
							};
				fs.writeFileSync(tokenPath, JSON.stringify(tokenPayload), { mode: 0o600 });
			}
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end("<h1>Authentication successful</h1>");
			server.close();
			if (activeServer === server) activeServer = null;
			writeOut({ jsonrpc: "2.0", id: msg.id, result: {} });
		});
		activeServer = server;
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			const authUrl =
				mode === "cli-1510"
					? `https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(`http://localhost:${port}/auth/callback`)}&scope=openid&state=${encodeURIComponent(expectedState)}`
					: `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/`)}&scope=openid&state=${encodeURIComponent(expectedState)}`;
			if (mode === "cli-1510") {
				// Simulate Go exec.Command("xdg-open", authUrl) where child stderr is discarded.
				spawnSync("xdg-open", [authUrl], {
					stdio: "ignore",
					env: process.env,
				});
				return;
			}
			if ((authMode === "browser-only" || authMode === "browser-and-stderr") && process.env.BROWSER) {
				spawnSync(process.env.BROWSER, [authUrl], {
					stdio: ["ignore", "ignore", "inherit"],
					env: process.env,
				});
			}
			if (authMode === "stderr-only" || authMode === "browser-and-stderr") {
				process.stderr.write(`Open the following link to authenticate the ACP server: ${authUrl}\n`);
			}
		});
		return;
	}

	if (msg.method === "logout") {
		if (logoutMode === "error") {
			writeOut({
				jsonrpc: "2.0",
				id: msg.id,
				error: { code: -32006, message: "synthetic logout error" },
			});
			return;
		}
		const appDir = effectiveAppDataDir();
		if (appDir) {
			fs.rmSync(path.join(appDir, "acp_token.json"), { force: true });
			fs.rmSync(path.join(appDir, "antigravity-oauth-token"), { force: true });
		}
		writeOut({ jsonrpc: "2.0", id: msg.id, result: {} });
		return;
	}

	if (msg.method === "session/new" || msg.method === "session/load" || msg.method === "session/resume") {
		const isNew = msg.method === "session/new";
		const sessionId = isNew ? `sess-${sessions.size + 1}` : (msg.params?.sessionId ?? `sess-${sessions.size + 1}`);
		const models = getFixtureModels();
		const cwd = msg.params?.cwd ?? process.cwd();
		const session = {
			sessionId,
			cwd,
			mcpServers: Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [],
			_meta: msg.params?._meta ?? null,
			models,
			currentModel: models[0]?.value ?? "",
			currentThought: models[0]?.thoughtValues?.[0] ?? "",
		};
		sessions.set(sessionId, session);
		simulateSkillFileIfWorkflowEnabled(cwd, msg.params?._meta);
		const artifactName =
			msg.method === "session/new"
				? "last-session-new.json"
				: msg.method === "session/load"
					? "last-session-load.json"
					: "last-session-resume.json";
		recordArtifact(artifactName, {
			initParams: recordedInitParams,
			...(isNew ? { sessionNewParams: msg.params ?? null } : { params: msg.params ?? null }),
		});
		writeOut({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				sessionId,
				configOptions: buildConfigOptions(models, session.currentModel, session.currentThought),
			},
		});
		return;
	}

	if (msg.method === "session/set_config_option") {
		const { sessionId, configId, value } = msg.params ?? {};
		const session = sessions.get(sessionId);
		if (!session) {
			writeOut({
				jsonrpc: "2.0",
				id: msg.id,
				error: { code: -32004, message: `Unknown session: ${sessionId}` },
			});
			return;
		}

		if (process.env.FAKE_ACP_HANG_CONFIG_VALUE && value === process.env.FAKE_ACP_HANG_CONFIG_VALUE) {
			return;
		}
		if (process.env.FAKE_ACP_ERROR_CONFIG_VALUE && value === process.env.FAKE_ACP_ERROR_CONFIG_VALUE) {
			writeOut({
				jsonrpc: "2.0",
				id: msg.id,
				error: { code: -32010, message: `Synthetic config error for ${value}` },
			});
			return;
		}

		if (configId === "model") {
			session.currentModel = value;
		} else if (configId === "thought_level") {
			session.currentThought = value;
		}

		recordArtifact("last-config-options.json", {
			configId,
			value,
			currentModel: session.currentModel,
			currentThought: session.currentThought,
		});

		const configOptions = buildConfigOptions(session.models, session.currentModel, session.currentThought);
		if (process.env.FAKE_ACP_CONFIG_VIA_NOTIFICATION === "1") {
			emitSessionUpdate(sessionId, { sessionUpdate: "config_option_update", configOptions });
			writeOut({ jsonrpc: "2.0", id: msg.id, result: {} });
			return;
		}
		writeOut({
			jsonrpc: "2.0",
			id: msg.id,
			result: { configOptions },
		});
		return;
	}

	if (msg.method === "session/cancel") {
		const sessionId = msg.params?.sessionId;
		logLifecycle("cancel");
		recordArtifact("last-cancel.json", { sessionId });
		if (ignoreEof) {
			return;
		}
		const active = activePrompts.get(sessionId);
		if (active) {
			activePrompts.delete(sessionId);
			writeOut({
				jsonrpc: "2.0",
				id: active.msgId,
				result: { stopReason: "cancelled" },
			});
		}
		return;
	}

	if (msg.method === "session/prompt") {
		const sessionId = msg.params?.sessionId;
		const session = sessions.get(sessionId);
		if (!session) {
			writeOut({
				jsonrpc: "2.0",
				id: msg.id,
				error: { code: -32004, message: `Unknown session: ${sessionId}` },
			});
			return;
		}

		const promptBlocks = Array.isArray(msg.params?.prompt) ? msg.params.prompt : [];
		session.promptCount = (session.promptCount ?? 0) + 1;
		const promptNumber = session.promptCount;
		const promptRecord = {
			pid: process.pid,
			sessionId,
			promptNumber,
			currentModel: session.currentModel,
			currentThought: session.currentThought,
			prompt: promptBlocks,
		};
		recordArtifact("last-prompt.json", promptRecord);
		appendArtifactLine("prompt-history.jsonl", promptRecord);

		const isReplayPrompt = promptBlocks.some(
			(block) => block?.type === "text" && typeof block.text === "string" && block.text.includes("[tool result"),
		);

		void (async () => {
			if (streamMode === "ipv6-error") {
				process.stderr.write("Error creating socket: Address family not supported by protocol (AF_INET6) enforce_kernel_ipv6_support\n");
				await new Promise((resolve) => setTimeout(resolve, 20));
				writeOut({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32020, message: "Socket initialization failed" },
				});
				return;
			}

			if (streamMode === "prompt-error") {
				emitSessionUpdate(sessionId, {
					sessionUpdate: "error",
					message: "Upstream model quota exhausted",
				});
				writeOut({
					jsonrpc: "2.0",
					id: msg.id,
					result: { stopReason: "end_turn" },
				});
				return;
			}

			if (streamMode === "refusal") {
				writeOut({
					jsonrpc: "2.0",
					id: msg.id,
					result: { stopReason: "refusal" },
				});
				return;
			}

			if (streamMode === "thinking-only-always" || streamMode === "thinking-whitespace-only") {
				emitSessionUpdate(sessionId, {
					sessionUpdate: "agent_thought_chunk",
					content: { type: "text", text: `Silent thought #${promptNumber}.` },
				});
				if (streamMode === "thinking-whitespace-only") {
					emitSessionUpdate(sessionId, {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "   \n  " },
					});
				}
				writeOut({
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						stopReason: "end_turn",
						usage: { inputTokens: 80, outputTokens: 20, thoughtTokens: 20, totalTokens: 100 },
					},
				});
				return;
			}

			if (
				(streamMode === "thinking-only-then-text" || streamMode === "thinking-only-then-mcp-tool") &&
				promptNumber === 1
			) {
				emitSessionUpdate(sessionId, {
					sessionUpdate: "agent_thought_chunk",
					content: { type: "text", text: "Planning first attempt silently." },
				});
				writeOut({
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						stopReason: "end_turn",
						usage: { inputTokens: 60, outputTokens: 15, thoughtTokens: 15, totalTokens: 75 },
					},
				});
				return;
			}

			if (streamMode === "hang-for-cancel") {
				emitSessionUpdate(sessionId, {
					sessionUpdate: "agent_thought_chunk",
					content: { type: "text", text: "Starting long task..." },
				});
				activePrompts.set(sessionId, { msgId: msg.id });
				return;
			}

			if (streamMode === "permission-then-text") {
				const permResponse = await sendClientRequest("session/request_permission", {
					sessionId,
					toolCall: {
						toolCallId: "native-perm-1",
						title: "Execute bash command",
						kind: "execute",
					},
					options: [
						{ optionId: "allow_once", name: "Allow", kind: "allow_once" },
						{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
					],
				});
				recordArtifact("last-permission-response.json", permResponse);
				const outcome = permResponse?.result?.outcome?.outcome ?? "unknown";
				emitSessionUpdate(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `permission:${outcome}` },
				});
				writeOut({
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						stopReason: "end_turn",
						usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
					},
				});
				return;
			}

			if (
				(streamMode === "mcp-tool" ||
					streamMode === "thinking-only-then-mcp-tool" ||
					streamMode === "two-mcp-tools" ||
					streamMode === "mcp-tool-timeout-and-retry" ||
					streamMode === "mcp-tool-move-on") &&
				!(process.env.FAKE_ACP_TEXT_ON_REPLAY === "1" && isReplayPrompt)
			) {
				const server = session.mcpServers[0];
				if (!server) {
					writeOut({
						jsonrpc: "2.0",
						id: msg.id,
						error: { code: -32030, message: "No MCP server registered" },
					});
					return;
				}
				const authHeader = server.headers?.find((h) => h.name.toLowerCase() === "authorization")?.value;
				const badAuthRes = await fetch(server.url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						Authorization: "Bearer wrong-token",
					},
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
				});

				const initRes = await callMcpJsonRpc(server.url, authHeader, null, {
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2024-11-05",
						capabilities: {},
						clientInfo: { name: "fake-acp", version: "1.0.0" },
					},
				});
				await callMcpJsonRpc(server.url, authHeader, initRes.sessionId, {
					jsonrpc: "2.0",
					method: "notifications/initialized",
					params: {},
				});
				const listRes = await callMcpJsonRpc(server.url, authHeader, initRes.sessionId, {
					jsonrpc: "2.0",
					id: 2,
					method: "tools/list",
					params: {},
				});
				let undeclaredError = null;
				if (process.env.FAKE_ACP_TEST_UNDECLARED === "1") {
					const undeclaredRes = await callMcpJsonRpc(server.url, authHeader, initRes.sessionId, {
						jsonrpc: "2.0",
						id: 3,
						method: "tools/call",
						params: { name: "run_workflow", arguments: {} },
					});
					undeclaredError = undeclaredRes.body?.error ?? null;
				}

				if (process.env.FAKE_ACP_CLI_WINDOW) {
					emitSessionUpdate(sessionId, {
						sessionUpdate: "usage_update",
						used: 150,
						size: Number(process.env.FAKE_ACP_CLI_WINDOW),
					});
				}

				if (streamMode === "two-mcp-tools") {
					const sequence = process.env.FAKE_ACP_TOOL_SEQUENCE_JSON
						? JSON.parse(process.env.FAKE_ACP_TOOL_SEQUENCE_JSON)
						: [
								{ name: "ask_user_question", arguments: { question: "What is d/dx(x^2)?" } },
								{ name: "quiz", arguments: { topic: "derivatives" } },
							];
					const toolTexts = [];
					for (let idx = 0; idx < sequence.length; idx++) {
						const step = sequence[idx];
						const callRes = await callMcpJsonRpc(server.url, authHeader, initRes.sessionId, {
							jsonrpc: "2.0",
							id: 10 + idx,
							method: "tools/call",
							params: { name: step.name, arguments: step.arguments ?? {} },
						});
						toolTexts.push(callRes.body?.result?.content?.[0]?.text ?? "");
					}
					emitSessionUpdate(sessionId, {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: `Tools returned: ${toolTexts.join(" | ")}` },
					});
					writeOut({
						jsonrpc: "2.0",
						id: msg.id,
						result: {
							stopReason: "end_turn",
							usage: { inputTokens: 45, outputTokens: 15, totalTokens: 60 },
						},
					});
					return;
				}

				if (streamMode === "mcp-tool-timeout-and-retry") {
					const ac = new AbortController();
					setTimeout(() => ac.abort(), 40);
					await callMcpJsonRpc(
						server.url,
						authHeader,
						initRes.sessionId,
						{
							jsonrpc: "2.0",
							id: 10,
							method: "tools/call",
							params: { name: "ask_user_question", arguments: { question: "Initial question" } },
						},
						ac.signal,
					).catch(() => {});
					// Simulate ACP timing out the held call and internally retrying + finishing.
					void callMcpJsonRpc(server.url, authHeader, initRes.sessionId, {
						jsonrpc: "2.0",
						id: 11,
						method: "tools/call",
						params: { name: "ask_user_question", arguments: { question: "Initial question" } },
					}).catch(() => {});
					emitSessionUpdate(sessionId, {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Timed out waiting on MCP tool." },
					});
					writeOut({
						jsonrpc: "2.0",
						id: msg.id,
						result: {
							stopReason: "end_turn",
							usage: { inputTokens: 200, cachedReadTokens: 50, outputTokens: 20, totalTokens: 220 },
						},
					});
					return;
				}

				if (streamMode === "mcp-tool-move-on") {
					void callMcpJsonRpc(server.url, authHeader, initRes.sessionId, {
						jsonrpc: "2.0",
						id: 10,
						method: "tools/call",
						params: { name: "ask_user_question", arguments: { question: "Ignored wait" } },
					}).catch(() => {});
					await new Promise((resolve) => setTimeout(resolve, 40));
					emitSessionUpdate(sessionId, {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Moving on without waiting" },
					});
					writeOut({
						jsonrpc: "2.0",
						id: msg.id,
						result: {
							stopReason: "end_turn",
							usage: { inputTokens: 200, cachedReadTokens: 50, outputTokens: 20, totalTokens: 220 },
						},
					});
					return;
				}

				const toolName = process.env.FAKE_ACP_TOOL_NAME ?? "probe_check";
				const toolArgs = process.env.FAKE_ACP_TOOL_ARGS_JSON
					? JSON.parse(process.env.FAKE_ACP_TOOL_ARGS_JSON)
					: { query: "status" };
				if (process.env.FAKE_ACP_REQUIRE_MCP_PERMISSION === "1") {
					const permResponse = await sendClientRequest("session/request_permission", {
						sessionId,
						toolCall: {
							toolCallId: `mcp-perm-${toolName}`,
							title: `learnharness_${toolName}`,
							kind: "other",
							status: "pending",
							_meta: {
								is_mcp_tool_call: true,
								mcp: {
									server: process.env.FAKE_ACP_MCP_SERVER_NAME ?? "learnharness",
									tool: toolName,
								},
							},
						},
						options: [
							{ optionId: "allow_always", name: "Allow Always", kind: "allow_always" },
							{ optionId: "allow", name: "Allow", kind: "allow_once" },
							{ optionId: "deny", name: "Deny", kind: "reject_once" },
						],
					});
					recordArtifact("last-permission-response.json", permResponse);
					if (permResponse?.result?.outcome?.outcome !== "selected") {
						emitSessionUpdate(sessionId, {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: `mcp-permission:${permResponse?.result?.outcome?.outcome ?? "unknown"}` },
						});
						writeOut({
							jsonrpc: "2.0",
							id: msg.id,
							result: {
								stopReason: "end_turn",
								usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
							},
						});
						return;
					}
				}
				const callRes = await callMcpJsonRpc(server.url, authHeader, initRes.sessionId, {
					jsonrpc: "2.0",
					id: 4,
					method: "tools/call",
					params: { name: toolName, arguments: toolArgs },
				});
				recordArtifact("last-mcp-audit.json", {
					badAuthStatus: badAuthRes.status,
					listedTools: listRes.body?.result?.tools?.map((t) => t.name) ?? [],
					undeclaredError,
					toolCallResult: callRes.body?.result ?? null,
				});
				const toolText = callRes.body?.result?.content?.[0]?.text ?? "done";
				emitSessionUpdate(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `Tool returned: ${toolText}` },
				});
				writeOut({
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						stopReason: "end_turn",
						usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
					},
				});
				return;
			}

			// Default "text" mode (or replay fallback): emit thought + text + optional usage_update + prompt response
			if (process.env.FAKE_ACP_THOUGHT !== "0") {
				emitSessionUpdate(sessionId, {
					sessionUpdate: "agent_thought_chunk",
					content: { type: "text", text: `Thinking (${session.currentThought || "default"}): ` },
				});
				emitSessionUpdate(sessionId, {
					sessionUpdate: "agent_thought_chunk",
					content: { type: "text", text: "analyzing." },
				});
			}
			const textChunks = isReplayPrompt && process.env.FAKE_ACP_TEXT_ON_REPLAY === "1"
				? [`Replayed ${promptBlocks.length} blocks`]
				: process.env.FAKE_ACP_TEXT
					? [process.env.FAKE_ACP_TEXT]
					: ["Hello ", `from ${session.currentModel}!`];
			for (const chunk of textChunks) {
				emitSessionUpdate(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: chunk },
				});
			}
			if (process.env.FAKE_ACP_CLI_WINDOW) {
				emitSessionUpdate(sessionId, {
					sessionUpdate: "usage_update",
					used: 150,
					size: Number(process.env.FAKE_ACP_CLI_WINDOW),
				});
			}
			const usagePayload = process.env.FAKE_ACP_USAGE_JSON
				? JSON.parse(process.env.FAKE_ACP_USAGE_JSON)
				: {
						inputTokens: 100,
						outputTokens: 25,
						thoughtTokens: 15,
						cachedReadTokens: 20,
						cachedWriteTokens: 5,
						totalTokens: 140,
					};
			writeOut({
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					stopReason: "end_turn",
					usage: usagePayload,
				},
			});
		})();
	}
});

rl.on("close", () => {
	logLifecycle("stdin-eof");
	if (ignoreEof) {
		// Simulate an ACP server blocked on an unresponsive thread/RPC despite stdin EOF.
		setInterval(() => {}, 10_000);
		return;
	}
	if (activeServer) {
		try {
			activeServer.close();
		} catch {
			// ignore
		}
	}
	process.exit(0);
});
