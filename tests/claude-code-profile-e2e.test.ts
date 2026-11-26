import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { configureClaudeConfigDir } from "../src/agent/claude-code/config-dir.ts";
import { ClaudeLaunchError, createClaudeLauncher } from "../src/agent/claude-code/launch.ts";
import { createClaudeCodeStreamFunction } from "../src/agent/claude-code/stream.ts";
import { claudeCodeProfilesResponse } from "../src/server/claude-code.ts";
import { effectiveClaudeConfigDir } from "../src/server/claude-code-config.ts";
import { discoverClaudeCodeProfiles } from "../src/server/claude-code-profiles.ts";
import { parseClaudeCodeSettingsBody } from "../src/server/settings-body.ts";
import { settingsStore } from "../src/store/settings.ts";

type StreamContext = Parameters<ReturnType<typeof createClaudeCodeStreamFunction>>[1];

const MODEL: Model<Api> = {
	id: "sonnet",
	name: "Claude Sonnet",
	api: "anthropic-messages",
	provider: "claude-code",
	baseUrl: "https://cli.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_384,
};

function makeContext(text: string): StreamContext {
	return {
		systemPrompt: "Be concise.",
		messages: [{ role: "user", content: text, timestamp: Date.now() }],
	} as unknown as StreamContext;
}

/** Executable synthetic Claude CLI script in tmpdir: answers --version and
 *  echoes its received process.env.CLAUDE_CONFIG_DIR over stream-json. */
function writeSyntheticClaudeCli(dir: string): string {
	const scriptPath = path.join(dir, "mock-claude");
	const script = `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("--version")) {
	process.stdout.write("2.1.329 (Claude Code)\\n");
	process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
	if (!line.trim()) return;
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (msg.type === "control_request") {
		process.stdout.write(JSON.stringify({
			type: "control_response",
			response: { subtype: "success", request_id: msg.request_id, response: { maxTokens: 180000 } },
		}) + "\\n");
		return;
	}
	if (msg.type === "user") {
		const observed = process.env.CLAUDE_CONFIG_DIR ?? "<UNSET>";
		const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
		out({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 10 } } } });
		out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
		out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "CONFIG_DIR=" + observed } } });
		out({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
		out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } });
		out({ type: "stream_event", event: { type: "message_stop" } });
		out({ type: "result", subtype: "success", is_error: false, result: "CONFIG_DIR=" + observed });
		rl.close();
		process.exit(0);
	}
});
`;
	fs.writeFileSync(scriptPath, script, { mode: 0o755 });
	return scriptPath;
}

async function runPromptAndReadText(
	streamFn: ReturnType<typeof createClaudeCodeStreamFunction>,
	prompt: string,
): Promise<string> {
	const stream = streamFn(MODEL, makeContext(prompt), { sessionId: "e2e-session-1" });
	let text = "";
	for await (const event of stream) {
		if (event.type === "text_delta") text += event.delta;
		if (event.type === "error") throw new Error(event.error.errorMessage ?? "stream error");
	}
	return text;
}

test("end-to-end isolated profile discovery, settings persistence, real child CLAUDE_CONFIG_DIR precedence, and fail-closed launch", async (t) => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-e2e-"));
	const mockHome = path.join(tmpRoot, "home");
	const mockDataDir = path.join(tmpRoot, "data");
	const mockBinDir = path.join(tmpRoot, "bin");
	fs.mkdirSync(mockHome, { recursive: true });
	fs.mkdirSync(mockDataDir, { recursive: true });
	fs.mkdirSync(mockBinDir, { recursive: true });

	const prevDataDir = process.env.LH_DATA_DIR;
	const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
	t.after(() => {
		if (prevDataDir === undefined) delete process.env.LH_DATA_DIR;
		else process.env.LH_DATA_DIR = prevDataDir;
		if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
		configureClaudeConfigDir(() => effectiveClaudeConfigDir());
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	process.env.LH_DATA_DIR = mockDataDir;
	delete process.env.CLAUDE_CONFIG_DIR;

	// Create isolated mock Claude Code profile directories + secret sentinel
	const SECRET_SENTINEL = "SECRET_DO_NOT_LEAK_TOKEN_999";
	const defaultDir = path.join(mockHome, ".claude");
	const secondDir = path.join(mockHome, ".claude-second");
	const thirdDir = path.join(mockHome, ".claude-3");
	const symlinkTarget = path.join(tmpRoot, "external-claude-linked");
	fs.mkdirSync(defaultDir);
	fs.mkdirSync(secondDir);
	fs.mkdirSync(thirdDir);
	fs.mkdirSync(symlinkTarget);
	fs.writeFileSync(path.join(defaultDir, "settings.json"), '{"theme":"dark"}');
	fs.writeFileSync(path.join(secondDir, "settings.json"), '{"model":"opus"}');
	fs.writeFileSync(
		path.join(secondDir, ".credentials.json"),
		JSON.stringify({
			claudeAiOauth: {
				accessToken: SECRET_SENTINEL,
				refreshToken: `${SECRET_SENTINEL}_REFRESH`,
			},
			apiKey: `${SECRET_SENTINEL}_API`,
		}),
	);
	fs.writeFileSync(
		path.join(mockHome, ".claude.json"),
		JSON.stringify({
			primaryApiKey: `${SECRET_SENTINEL}_PRIMARY`,
			mcpServers: { secret: { env: { TOKEN: SECRET_SENTINEL } } },
			oauthAccount: {
				emailAddress: "default@example.com",
				billingType: "stripe_subscription",
				accountUuid: `${SECRET_SENTINEL}_UUID`,
			},
		}),
	);
	fs.writeFileSync(
		path.join(secondDir, ".claude.json"),
		JSON.stringify({
			primaryApiKey: `${SECRET_SENTINEL}_SECOND`,
			oauthAccount: { emailAddress: "second@example.com" },
		}),
	);
	fs.symlinkSync(symlinkTarget, path.join(mockHome, ".claude-linked"));

	const mockClaudeBinary = writeSyntheticClaudeCli(mockBinDir);

	// Wire config-dir getter against isolated mockHome
	configureClaudeConfigDir(() => effectiveClaudeConfigDir(mockHome));
	const launcher = createClaudeLauncher({ findBinary: () => mockClaudeBinary });
	const streamFn = createClaudeCodeStreamFunction(launcher);

	// 1. Enable Claude Code and discover profiles over the guarded HTTP handler
	const enableParsed = parseClaudeCodeSettingsBody({ enabled: true });
	assert.equal(enableParsed.ok, true);
	settingsStore.writeSettings({ version: 1, claudeCode: enableParsed.settings });

	const req = new Request("http://localhost:3000/api/claude-code/profiles", {
		method: "GET",
		headers: {
			host: "localhost:3000",
			origin: "http://localhost:3000",
			"x-learnharness-claude-code": "1",
		},
	});
	const res = await claudeCodeProfilesResponse(
		req,
		() => discoverClaudeCodeProfiles({
			homeDir: mockHome,
			env: process.env,
			configuredDir: settingsStore.readSettings()?.claudeCode?.configDir ?? null,
		}),
		() => settingsStore.readSettings()?.claudeCode?.enabled === true,
	);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("cache-control"), "no-store");
	const rawJson = await res.text();
	assert(!rawJson.includes(SECRET_SENTINEL), "Discovery payload must never leak secrets from .credentials.json or .claude.json");
	const discovery = JSON.parse(rawJson);
	const labels = discovery.profiles.map((p: { label: string }) => p.label);
	assert(labels.includes("Default (.claude)"));
	assert(labels.includes(".claude-second"));
	assert(labels.includes(".claude-3"));
	assert(labels.includes(".claude-linked"));
	assert(!labels.includes(".claude.json"));
	const defaultProfile = discovery.profiles.find((p: { label: string }) => p.label === "Default (.claude)");
	const secondProfile = discovery.profiles.find((p: { label: string }) => p.label === ".claude-second");
	assert.equal(defaultProfile?.email, "default@example.com");
	assert.equal(defaultProfile?.subscriptionPlan, "Subscription");
	assert.equal(secondProfile?.email, "second@example.com");

	// 2. Select ~/.claude-second via settings body parser + store; verify real child receives expanded path
	//    even when an inherited CLAUDE_CONFIG_DIR points elsewhere.
	process.env.CLAUDE_CONFIG_DIR = thirdDir;
	const pickSecond = parseClaudeCodeSettingsBody({ enabled: true, configDir: "~/.claude-second" });
	assert.equal(pickSecond.ok, true);
	settingsStore.writeSettings({ version: 1, claudeCode: pickSecond.settings });

	const outSecond = await runPromptAndReadText(streamFn, "hello-second");
	assert.equal(outSecond, `CONFIG_DIR=${secondDir}`);

	// 3. Switch to .claude-3; verify new child spawns with .claude-3
	const pickThird = parseClaudeCodeSettingsBody({ enabled: true, configDir: thirdDir });
	assert.equal(pickThird.ok, true);
	settingsStore.writeSettings({ version: 1, claudeCode: pickThird.settings });

	const outThird = await runPromptAndReadText(streamFn, "hello-third");
	assert.equal(outThird, `CONFIG_DIR=${thirdDir}`);

	// 4. Reset configDir to null; verify fallback to inherited CLAUDE_CONFIG_DIR, then unset
	const reset = parseClaudeCodeSettingsBody({ enabled: true, configDir: null });
	assert.equal(reset.ok, true);
	assert.equal(reset.settings.configDir, undefined);
	settingsStore.writeSettings({ version: 1, claudeCode: reset.settings });

	process.env.CLAUDE_CONFIG_DIR = secondDir;
	const outInherited = await runPromptAndReadText(streamFn, "hello-inherited");
	assert.equal(outInherited, `CONFIG_DIR=${secondDir}`);

	delete process.env.CLAUDE_CONFIG_DIR;
	const outDefault = await runPromptAndReadText(streamFn, "hello-default");
	assert.equal(outDefault, "CONFIG_DIR=<UNSET>");

	// 5. Missing configured directory fails closed with ClaudeLaunchError (never falls back to ~/.claude)
	const missingDir = path.join(mockHome, ".claude-does-not-exist");
	const pickMissing = parseClaudeCodeSettingsBody({ enabled: true, configDir: missingDir });
	assert.equal(pickMissing.ok, true);
	settingsStore.writeSettings({ version: 1, claudeCode: pickMissing.settings });

	await assert.rejects(
		() => runPromptAndReadText(streamFn, "hello-missing"),
		(err: unknown) => {
			assert(err instanceof Error);
			assert.match(err.message, /does not exist|cannot be accessed/i);
			return true;
		},
	);
	// Direct launcher check verifies ClaudeLaunchError class
	await assert.rejects(
		async () => {
			await launcher(["-p"], { cwd: tmpRoot, env: { ...process.env, CLAUDE_CONFIG_DIR: missingDir } });
		},
		ClaudeLaunchError,
	);
});
