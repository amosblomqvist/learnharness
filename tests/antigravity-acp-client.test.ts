import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import packageMetadata from "../package.json" with { type: "json" };
import {
	AcpRpcError,
	clientInfoForRuntime,
	formatAntigravityError,
	spawnAcpClient,
} from "../src/agent/antigravity/acp-client.ts";
import { buildAntigravityEnvironment } from "../src/agent/antigravity/profile.ts";

const FAKE_ACP = path.resolve(import.meta.dirname, "fixtures", "antigravity", "fake-acp.mjs");

function makeTempRoot(prefix = "lh-agy-acp-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("clientInfoForRuntime uses zed 0.0.0 below 1.5.1 and learnharness package version at or above 1.5.1", () => {
	assert.deepEqual(clientInfoForRuntime({ version: null }), { name: "zed", version: "0.0.0" });
	assert.deepEqual(clientInfoForRuntime({ version: "1.4.5" }), { name: "zed", version: "0.0.0" });
	assert.deepEqual(clientInfoForRuntime({ version: "1.5.0" }), { name: "zed", version: "0.0.0" });
	assert.deepEqual(clientInfoForRuntime({ version: "1.5.1" }), { name: "learnharness", version: packageMetadata.version });
	assert.deepEqual(clientInfoForRuntime({ version: "1.6.0" }), { name: "learnharness", version: packageMetadata.version });
});

test("formatAntigravityError adds Linux IPv6 remediation hint on AF_INET6 / enforce_kernel_ipv6_support", () => {
	const msg = formatAntigravityError(
		"Socket initialization failed",
		"Address family not supported (AF_INET6) enforce_kernel_ipv6_support",
		"linux",
	);
	assert.match(msg, /Linux/i);
	assert.match(msg, /IPv6/i);
	assert.match(msg, /AF_INET6/);
	assert.equal(formatAntigravityError("Plain failure", "", "linux"), "Plain failure");
});

test("spawnAcpClient handles initialize, session/new metadata/disabledTools, config options, and unconditionally declines session/request_permission", async () => {
	const root = makeTempRoot();
	const geminiHome = path.join(root, "profile");
	const tempDir = path.join(root, "tmp");
	const cwd = path.join(root, "cwd");
	fs.mkdirSync(geminiHome, { recursive: true });
	fs.mkdirSync(tempDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });

	const env = buildAntigravityEnvironment({
		baseEnv: {
			...process.env,
			FAKE_ACP_RECORD_EVENTS: "1",
			FAKE_ACP_STREAM_MODE: "permission-then-text",
		},
		geminiHome,
		tempDir,
		harnessPath: "/tmp/lh_harness",
	});

	const seenPermissions: unknown[] = [];
	const client = spawnAcpClient({
		cwd,
		env,
		runtime: { executablePath: FAKE_ACP, args: [], version: "1.5.0" },
		onPermissionRequest: (params) => {
			seenPermissions.push(params);
		},
	});

	try {
		const init = await client.initialize(5_000);
		assert.equal(init.agentInfo?.name, "antigravity-acp");

		const sess = await client.sessionNew(
			{
				cwd,
				mcpServers: [],
				systemPromptAppend: "You are a tutor.",
				disabledTools: ["run_workflow"],
			},
			5_000,
		);
		assert.ok(sess.sessionId);

		const recordedSessionNew = JSON.parse(
			fs.readFileSync(path.join(geminiHome, "antigravity-acp", "last-session-new.json"), "utf8"),
		) as {
			initParams: {
				clientInfo: { name: string; version: string };
				clientCapabilities: { fs: { readTextFile: boolean; writeTextFile: boolean }; terminal: boolean };
			};
			sessionNewParams: {
				_meta: {
					antigravity: {
						disabledTools: string[];
						systemPrompt?: { append: string };
					};
				};
			};
		};
		assert.deepEqual(recordedSessionNew.initParams.clientInfo, { name: "zed", version: "0.0.0" });
		assert.deepEqual(recordedSessionNew.initParams.clientCapabilities, {
			fs: { readTextFile: false, writeTextFile: false },
			terminal: false,
		});
		assert.deepEqual(recordedSessionNew.sessionNewParams._meta.antigravity.disabledTools, ["run_workflow"]);
		assert.equal(recordedSessionNew.sessionNewParams._meta.antigravity.systemPrompt?.append, "You are a tutor.");

		await client.setConfigOption(sess.sessionId, "model", "gemini-3.1-pro", 5_000);
		const promptRes = await client.prompt(sess.sessionId, [{ type: "text", text: "Hi" }], 5_000);
		assert.equal(promptRes.stopReason, "end_turn");

		assert.equal(seenPermissions.length, 1);
		const recordedPerm = JSON.parse(
			fs.readFileSync(path.join(geminiHome, "antigravity-acp", "last-permission-response.json"), "utf8"),
		) as { result?: { outcome?: { outcome?: string } } };
		assert.equal(recordedPerm.result?.outcome?.outcome, "cancelled");
	} finally {
		await client.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("spawnAcpClient selects allow_once only when approvePermission returns true", async () => {
	const root = makeTempRoot();
	const geminiHome = path.join(root, "profile");
	const tempDir = path.join(root, "tmp");
	const cwd = path.join(root, "cwd");
	fs.mkdirSync(geminiHome, { recursive: true });
	fs.mkdirSync(tempDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });

	const env = buildAntigravityEnvironment({
		baseEnv: {
			...process.env,
			FAKE_ACP_RECORD_EVENTS: "1",
			FAKE_ACP_STREAM_MODE: "permission-then-text",
		},
		geminiHome,
		tempDir,
		harnessPath: "/tmp/lh_harness",
	});

	const client = spawnAcpClient({
		cwd,
		env,
		runtime: { executablePath: FAKE_ACP, args: [], version: "1.4.5" },
		approvePermission: () => true,
	});

	try {
		await client.initialize(5_000);
		const sess = await client.sessionNew({ cwd, mcpServers: [] }, 5_000);
		await client.prompt(sess.sessionId, [{ type: "text", text: "Hi" }], 5_000);
		const recordedPerm = JSON.parse(
			fs.readFileSync(path.join(geminiHome, "antigravity-acp", "last-permission-response.json"), "utf8"),
		) as { result?: { outcome?: { outcome?: string; optionId?: string } } };
		assert.equal(recordedPerm.result?.outcome?.outcome, "selected");
		assert.equal(recordedPerm.result?.outcome?.optionId, "allow_once");
	} finally {
		await client.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("spawnAcpClient surfaces AcpRpcError with IPv6 context on Linux stderr failure", async () => {
	const root = makeTempRoot();
	const geminiHome = path.join(root, "profile");
	const tempDir = path.join(root, "tmp");
	const cwd = path.join(root, "cwd");
	fs.mkdirSync(geminiHome, { recursive: true });
	fs.mkdirSync(tempDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });

	const env = buildAntigravityEnvironment({
		baseEnv: {
			...process.env,
			FAKE_ACP_STREAM_MODE: "ipv6-error",
		},
		geminiHome,
		tempDir,
		harnessPath: "/tmp/lh_harness",
	});

	const client = spawnAcpClient({
		cwd,
		env,
		runtime: { executablePath: FAKE_ACP, args: [], version: "1.5.2" },
		platform: "linux",
	});

	try {
		await client.initialize(5_000);
		const sess = await client.sessionNew({ cwd }, 5_000);
		await assert.rejects(
			() => client.prompt(sess.sessionId, [{ type: "text", text: "Hi" }], 5_000),
			(err: unknown) =>
				err instanceof AcpRpcError && /Linux/.test(err.message) && /IPv6/i.test(err.message),
		);
	} finally {
		await client.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("spawnAcpClient enforces disabledTools=['run_workflow'] on sessionNew, sessionLoad, and sessionResume without creating SKILL.md", async () => {
	const root = makeTempRoot();
	const geminiHome = path.join(root, "profile");
	const tempDir = path.join(root, "tmp");
	const cwd = path.join(root, "cwd");
	fs.mkdirSync(geminiHome, { recursive: true });
	fs.mkdirSync(tempDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });

	const env = buildAntigravityEnvironment({
		baseEnv: {
			...process.env,
			FAKE_ACP_RECORD_EVENTS: "1",
		},
		geminiHome,
		tempDir,
		harnessPath: "/tmp/lh_harness",
	});

	const client = spawnAcpClient({
		cwd,
		env,
		runtime: { executablePath: FAKE_ACP, args: [], version: "1.5.2" },
	});

	try {
		await client.initialize(5_000);
		// Intentionally pass disabledTools: [] or other tools to verify run_workflow is always merged.
		const created = await client.sessionNew({ cwd, disabledTools: [] }, 5_000);
		await client.sessionLoad({ sessionId: created.sessionId, cwd, disabledTools: ["other_tool"] }, 5_000);
		await client.sessionResume({ sessionId: created.sessionId, cwd }, 5_000);

		const newRec = JSON.parse(fs.readFileSync(path.join(geminiHome, "antigravity-acp", "last-session-new.json"), "utf8")) as {
			sessionNewParams: { _meta: { antigravity: { disabledTools: string[] } } };
		};
		const loadRec = JSON.parse(fs.readFileSync(path.join(geminiHome, "antigravity-acp", "last-session-load.json"), "utf8")) as {
			params: { _meta: { antigravity: { disabledTools: string[] } } };
		};
		const resumeRec = JSON.parse(fs.readFileSync(path.join(geminiHome, "antigravity-acp", "last-session-resume.json"), "utf8")) as {
			params: { _meta: { antigravity: { disabledTools: string[] } } };
		};

		assert.deepEqual(newRec.sessionNewParams._meta.antigravity.disabledTools, ["run_workflow"]);
		assert.deepEqual(loadRec.params._meta.antigravity.disabledTools, ["other_tool", "run_workflow"]);
		assert.deepEqual(resumeRec.params._meta.antigravity.disabledTools, ["run_workflow"]);
		assert.equal(fs.existsSync(path.join(cwd, "skills", "system", "run-workflow", "SKILL.md")), false);
	} finally {
		await client.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("client.close closes stdin cleanly first and escalates directly to SIGKILL without SIGTERM", async () => {
	const root = makeTempRoot();
	const geminiHome = path.join(root, "profile");
	const tempDir = path.join(root, "tmp");
	const cwd = path.join(root, "cwd");
	const lifecycleLog = path.join(root, "lifecycle.jsonl");
	fs.mkdirSync(geminiHome, { recursive: true });
	fs.mkdirSync(tempDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });

	const env = buildAntigravityEnvironment({
		baseEnv: {
			...process.env,
			FAKE_ACP_IGNORE_EOF: "1",
			FAKE_ACP_TRAP_SIGTERM: "1",
			FAKE_ACP_LIFECYCLE_LOG: lifecycleLog,
		},
		geminiHome,
		tempDir,
		harnessPath: "/tmp/lh_harness",
	});

	const client = spawnAcpClient({
		cwd,
		env,
		runtime: { executablePath: FAKE_ACP, args: [], version: "1.5.2" },
	});

	try {
		await client.initialize(5_000);
		await client.close({ eofGraceMs: 40 });
		assert.equal(client.child.signalCode, "SIGKILL");

		const events = fs
			.readFileSync(lifecycleLog, "utf8")
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { event: string }).event);
		assert.ok(events.includes("stdin-eof"), `expected stdin-eof in ${events.join(",")}`);
		assert.equal(events.includes("sigterm"), false, `SIGTERM must not be sent, saw: ${events.join(",")}`);
	} finally {
		await client.close({ eofGraceMs: 10 }).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("spawnAcpClient passes --gemini-dir/--app-data-dir and refreshes keyring marker for cli runtimes only", async () => {
	const root = makeTempRoot();
	const geminiHome = path.join(root, "profile");
	const tempDir = path.join(root, "tmp");
	const cwd = path.join(root, "cwd");
	fs.mkdirSync(geminiHome, { recursive: true });
	fs.mkdirSync(tempDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });

	const env = buildAntigravityEnvironment({
		baseEnv: {
			...process.env,
			FAKE_ACP_MODE: "cli-1510",
			FAKE_ACP_RECORD_EVENTS: "1",
		},
		geminiHome,
		tempDir,
	});

	const client = spawnAcpClient({
		cwd,
		env,
		profileDir: geminiHome,
		runtime: { kind: "cli", executablePath: FAKE_ACP, args: ["acp"], version: "1.5.10" },
	});

	try {
		const init = await client.initialize(5_000);
		assert.equal(init.agentInfo?.name, "Antigravity ACP Server");
		assert.equal(init.agentInfo?.version, "1.5.10");

		const markerPath = path.join(geminiHome, "antigravity-acp", "cache", "antigravity-keyring-unavailable");
		assert.equal(fs.existsSync(markerPath), true);

		const recorded = JSON.parse(
			fs.readFileSync(path.join(geminiHome, "antigravity-acp", "last-argv.json"), "utf8"),
		) as { argv: string[] };
		assert.deepEqual(recorded.argv, ["acp", "--gemini-dir", geminiHome, "--app-data-dir", "antigravity-acp"]);
	} finally {
		await client.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
