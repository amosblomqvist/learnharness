import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { AUTH_FILE } from "../config.ts";
import {
	createAntigravityAuthManager,
	extractAntigravityOAuthUrlFromLine,
	forwardLoopbackCallback,
	parseAndValidateAntigravityOAuthUrl,
	validateManualCallbackUrl,
} from "../src/agent/antigravity/auth.ts";
import { ANTIGRAVITY_AUTH_URL_MARKER } from "../src/agent/antigravity/constants.ts";
import {
	createAntigravityInstallerManager,
	probeAntigravityInitialize,
	type ResolvedAntigravityRuntime,
} from "../src/agent/antigravity/installation.ts";
import {
	antigravityCliTokenFilePath,
	antigravityKeyringUnavailablePath,
	antigravityModelsCachePath,
	antigravityProfileSettingsPath,
	antigravityTokenFilePath,
	buildAntigravityEnvironment,
	createBrowserWrapper,
	deleteAntigravityTokenFile,
	ensureAntigravityProfile,
	isAntigravityProfileSignedIn,
	resolveAntigravityProfileDir,
	verifyBrowserWrapper,
} from "../src/agent/antigravity/profile.ts";
import { isSensitivePath, resolveSourcePath } from "../src/agent/tools/fs-shared.ts";
import { authEnvRecord } from "../src/core/auth-env.ts";
import type { AntigravityStatus } from "../src/core/contracts/antigravity.ts";
import { antigravityAuthResponse } from "../src/server/antigravity.ts";

const FAKE_ACP = path.resolve(import.meta.dirname, "fixtures", "antigravity", "fake-acp.mjs");
const BUILD_SERVER_SCRIPT = path.resolve(import.meta.dirname, "..", "scripts", "build-server.mjs");
const GITIGNORE_PATH = path.resolve(import.meta.dirname, "..", ".gitignore");
const NEXT_CONFIG_PATH = path.resolve(import.meta.dirname, "..", "next.config.ts");

function fakeRuntime(overrides: Partial<ResolvedAntigravityRuntime> = {}): ResolvedAntigravityRuntime {
	return {
		source: "managed",
		kind: "acp-server",
		executablePath: FAKE_ACP,
		harnessPath: "/tmp/localharness_external",
		args: [],
		version: "1.4.5",
		...overrides,
	};
}

function makeTempRoot(prefix = "lh-agy-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function authReq(method: "POST" | "DELETE" | "GET", body?: unknown, headers: Record<string, string> = {}) {
	return new Request("http://localhost:3000/api/antigravity/auth", {
		method,
		headers: {
			"x-learnharness-antigravity": "1",
			...(body !== undefined ? { "content-type": "application/json" } : {}),
			...headers,
		},
		...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
	});
}

test("Antigravity Profile resolves beside LH_AUTH_FILE, enforces 0700/0600, sets oauth-personal, and optionally symlinks ~/.gemini skills", () => {
	const root = makeTempRoot();
	try {
		const authDir = path.join(root, "secrets");
		const authFile = path.join(authDir, "auth.json");
		const fakeHome = path.join(root, "home");
		const geminiSkills = path.join(fakeHome, ".gemini", "config", "skills");
		fs.mkdirSync(geminiSkills, { recursive: true });
		fs.writeFileSync(path.join(geminiSkills, "SKILL.md"), "# test\n");

		const resolved = resolveAntigravityProfileDir({ authFile });
		assert.equal(resolved, path.join(authDir, "antigravity-profile"));
		assert.equal(isAntigravityProfileSignedIn({ authFile }), false);

		const created = ensureAntigravityProfile({ authFile, homeDir: fakeHome });
		assert.equal(created, resolved);

		if (process.platform !== "win32") {
			assert.equal(fs.statSync(created).mode & 0o777, 0o700);
			assert.equal(fs.statSync(path.join(created, "antigravity-acp")).mode & 0o777, 0o700);
			assert.equal(fs.statSync(antigravityProfileSettingsPath(created)).mode & 0o777, 0o600);
		}

		const settings = JSON.parse(fs.readFileSync(antigravityProfileSettingsPath(created), "utf8")) as {
			auth?: { type?: string };
		};
		assert.equal(settings.auth?.type, "oauth-personal");

		const linkedSkills = path.join(created, "config", "skills");
		assert.equal(fs.lstatSync(linkedSkills).isSymbolicLink(), true);
		assert.equal(fs.readlinkSync(linkedSkills), geminiSkills);

		// Absent ~/.gemini skills must never fail profile setup.
		const emptyHome = path.join(root, "empty-home");
		fs.mkdirSync(emptyHome, { recursive: true });
		ensureAntigravityProfile({ authFile, homeDir: emptyHome });

		// Valid acp_token.json marks profile as signed in.
		fs.writeFileSync(antigravityTokenFilePath(created), JSON.stringify({ access_token: "tok-123" }), { mode: 0o600 });
		assert.equal(isAntigravityProfileSignedIn({ authFile }), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("buildAntigravityEnvironment scrubs ambient Google/Vertex/GCloud & LH keys and sets Linux CA + isolated paths", async () => {
	const root = makeTempRoot();
	try {
		const geminiHome = path.join(root, "profile");
		const tempDir = path.join(root, "tmp");
		fs.mkdirSync(geminiHome, { recursive: true });
		fs.mkdirSync(tempDir, { recursive: true });

		const dirtyEnv: Record<string, string | undefined> = {
			PATH: process.env.PATH,
			HOME: root,
			GEMINI_API_KEY: "AIza-ambient-gemini",
			GOOGLE_API_KEY: "AIza-ambient-google",
			GOOGLE_APPLICATION_CREDENTIALS: "/etc/secret/creds.json",
			GOOGLE_CLOUD_PROJECT: "my-gcp-project",
			GOOGLE_CLOUD_LOCATION: "us-central1",
			GOOGLE_CLOUD_QUOTA_PROJECT: "quota-proj",
			GOOGLE_GENAI_USE_VERTEXAI: "true",
			GCLOUD_PROJECT: "gcloud-proj",
			CLOUDSDK_CORE_PROJECT: "cloudsdk-proj",
			AGY_ACP_CCPA_PROJECT: "ccpa-proj",
			AGY_ACP_ENABLE_OAUTH: "0",
			OPENAI_API_KEY: "sk-learnharness-byok",
			CHROME_CRASHPAD_PIPE_NAME: "\\\\.\\pipe\\crashpad",
			GEMINI_HOME: "/wrong/gemini/home",
			NIX_SSL_CERT_FILE: "/nix/store/cacert.pem",
		};

		const { fillGap, realEnv } = authEnvRecord();
		const hadFillGap = fillGap.has("OPENAI_API_KEY");
		const hadRealEnv = realEnv.has("OPENAI_API_KEY");
		fillGap.add("OPENAI_API_KEY");
		realEnv.delete("OPENAI_API_KEY");

		let built: NodeJS.ProcessEnv;
		try {
			built = buildAntigravityEnvironment({
				baseEnv: dirtyEnv,
				geminiHome,
				tempDir,
				harnessPath: "/opt/localharness_external",
				browserScript: "/tmp/open-url.sh",
				platform: "linux",
			});
		} finally {
			if (!hadFillGap) fillGap.delete("OPENAI_API_KEY");
			if (hadRealEnv) realEnv.add("OPENAI_API_KEY");
		}

		for (const stripped of [
			"GEMINI_API_KEY",
			"GOOGLE_API_KEY",
			"GOOGLE_APPLICATION_CREDENTIALS",
			"GOOGLE_CLOUD_PROJECT",
			"GOOGLE_CLOUD_LOCATION",
			"GOOGLE_CLOUD_QUOTA_PROJECT",
			"GOOGLE_GENAI_USE_VERTEXAI",
			"GCLOUD_PROJECT",
			"CLOUDSDK_CORE_PROJECT",
			"AGY_ACP_CCPA_PROJECT",
			"AGY_ACP_ENABLE_OAUTH",
			"OPENAI_API_KEY",
			"CHROME_CRASHPAD_PIPE_NAME",
		]) {
			assert.equal(built[stripped], undefined, `expected ${stripped} to be stripped`);
		}
		assert.equal(built.GEMINI_HOME, geminiHome);
		assert.equal(built.TMPDIR, tempDir);
		assert.equal(built.AGY_ACP_FORCE_FILE_STORAGE, "1");
		assert.equal(built.ANTIGRAVITY_HARNESS_PATH, "/opt/localharness_external");
		assert.equal(built.BROWSER, "/tmp/open-url.sh");
		assert.equal(built.PYTHONUNBUFFERED, "1");
		assert.equal(built.ELECTRON_RUN_AS_NODE, "1");
		assert.equal(built.SSL_CERT_FILE, "/nix/store/cacert.pem");

		// Also verify Linux CA fallback when NIX_SSL_CERT_FILE is absent.
		const caEnv = buildAntigravityEnvironment({
			baseEnv: { PATH: process.env.PATH },
			geminiHome,
			tempDir,
			platform: "linux",
			fileExists: (p) => p === "/etc/ssl/certs/ca-certificates.crt",
		});
		assert.equal(caEnv.SSL_CERT_FILE, "/etc/ssl/certs/ca-certificates.crt");

		// Also verify probeAntigravityInitialize scrubs env when spawning fake-acp in require-scrubbed-env mode.
		const probed = await probeAntigravityInitialize(
			{
				source: "managed",
				kind: "acp-server",
				executablePath: FAKE_ACP,
				args: [],
				version: "1.4.5",
			},
			{
				baseEnv: {
					...dirtyEnv,
					FAKE_ACP_MODE: "require-scrubbed-env",
				},
			},
		);
		assert.equal(probed.version, "1.4.5");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("createBrowserWrapper + verifyBrowserWrapper preflight passes and emits marker on stderr", async () => {
	const wrapper = createBrowserWrapper();
	try {
		assert.equal(wrapper.scriptPath.includes(" "), false, "BROWSER script path must not contain spaces");
		await verifyBrowserWrapper(wrapper.scriptPath);

		const res = spawnSync(wrapper.scriptPath, ["https://accounts.google.com/o/oauth2/v2/auth?x=1"], {
			encoding: "utf8",
			env: process.env,
		});
		assert.equal(res.status, 0);
		assert.match(res.stderr, new RegExp(ANTIGRAVITY_AUTH_URL_MARKER));
		const extracted = extractAntigravityOAuthUrlFromLine(res.stderr.trim());
		assert.deepEqual(extracted, {
			source: "browser",
			rawUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
		});
	} finally {
		wrapper.cleanup();
	}

	await assert.rejects(() => verifyBrowserWrapper(path.join(os.tmpdir(), "nonexistent-browser-wrapper.sh")));
});

test("OAuth URL and manual callback URL validators enforce Google endpoint, loopback port, and state", () => {
	const validOAuth =
		"https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2F&state=secret-state";
	const parsed = parseAndValidateAntigravityOAuthUrl(validOAuth);
	assert.deepEqual(parsed, {
		authUrl: validOAuth,
		port: 43210,
		state: "secret-state",
		redirectUri: "http://127.0.0.1:43210/",
	});

	for (const bad of [
		"http://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=s&redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2F",
		"https://evil.example.com/o/oauth2/v2/auth?response_type=code&state=s&redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2F",
		"https://accounts.google.com/other?response_type=code&state=s&redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2F",
		"https://user:pass@accounts.google.com/o/oauth2/v2/auth?response_type=code&state=s&redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2F",
		"https://accounts.google.com/o/oauth2/v2/auth?response_type=token&state=s&redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2F",
		"https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=&redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2F",
		"https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=s&redirect_uri=http%3A%2F%2Flocalhost%3A43210%2F",
		"https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=s&redirect_uri=http%3A%2F%2F127.0.0.1%3A80%2F",
		"https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=s&redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2Fcb",
	]) {
		assert.equal(parseAndValidateAntigravityOAuthUrl(bad), null, `expected rejection for ${bad}`);
	}

	const validCb = validateManualCallbackUrl("http://127.0.0.1:43210/?state=secret-state&code=4%2Fxyz", {
		port: 43210,
		state: "secret-state",
	});
	assert.deepEqual(validCb, {
		ok: true,
		forwardUrl: "http://127.0.0.1:43210/?state=secret-state&code=4%2Fxyz",
	});

	for (const badCb of [
		"",
		"not a url",
		"https://127.0.0.1:43210/?state=secret-state&code=x",
		"http://localhost:43210/?state=secret-state&code=x",
		"http://127.0.0.1:43210/wrong?state=secret-state&code=x",
		"http://127.0.0.1:55555/?state=secret-state&code=x",
		"http://127.0.0.1:43210/?state=wrong-state&code=x",
		"http://127.0.0.1:43210/?state=secret-state",
	]) {
		const res = validateManualCallbackUrl(badCb, { port: 43210, state: "secret-state" });
		assert.equal(res.ok, false, `expected manual callback rejection for ${badCb}`);
	}

	const stderrExtract = extractAntigravityOAuthUrlFromLine(
		`Open the following link to authenticate the ACP server: ${validOAuth}`,
	);
	assert.deepEqual(stderrExtract, { source: "stderr", rawUrl: validOAuth });
});

test("forwardLoopbackCallback refuses non-loopback targets and delivers loopback GET requests", async () => {
	await assert.rejects(() => forwardLoopbackCallback("http://example.com:8080/?code=1"));
	await assert.rejects(() => forwardLoopbackCallback("http://127.0.0.1:80/?code=1"));

	let hitPath = "";
	const srv = http.createServer((req, res) => {
		hitPath = req.url ?? "";
		res.writeHead(200);
		res.end("ok");
	});
	await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
	try {
		const addr = srv.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		const res = await forwardLoopbackCallback(`http://127.0.0.1:${port}/?state=s&code=c`);
		assert.equal(res.statusCode, 200);
		assert.equal(hitPath, "/?state=s&code=c");
	} finally {
		srv.close();
	}
});

test("createAntigravityAuthManager completes BROWSER capture + manual callback, persists token, and logout clears token + models.json", async () => {
	const root = makeTempRoot();
	try {
		const authFile = path.join(root, "secrets", "auth.json");
		const dataDir = path.join(root, "data");
		const modelsCache = antigravityModelsCachePath({ dataDir });
		fs.mkdirSync(path.dirname(modelsCache), { recursive: true });
		fs.writeFileSync(modelsCache, JSON.stringify([{ id: "gemini-3-pro" }]));

		const manager = createAntigravityAuthManager({
			authFile,
			dataDir,
			env: {
				...process.env,
				FAKE_ACP_MODE: "require-scrubbed-env",
				FAKE_ACP_AUTH_MODE: "browser-only",
				FAKE_ACP_STATE: "browser-state-1",
				FAKE_ACP_RECORD_CLIENT_INFO: "1",
				GEMINI_API_KEY: "should-be-scrubbed",
				GOOGLE_CLOUD_PROJECT: "should-be-scrubbed",
			},
		});

		assert.equal(manager.getState().phase, "idle");
		assert.equal(manager.getState().signedIn, false);

		const started = await manager.startAuth(fakeRuntime());
		assert.equal(started.phase, "waiting");
		assert.ok(started.attemptId);
		assert.ok(started.authUrl);

		const parsed = parseAndValidateAntigravityOAuthUrl(started.authUrl!);
		assert.ok(parsed);
		assert.equal(parsed!.state, "browser-state-1");

		// Verify clientInfo compatibility shim for < 1.5.1 vs >= 1.5.1.
		const profileDir = resolveAntigravityProfileDir({ authFile });
		const recordedInfo = JSON.parse(
			fs.readFileSync(path.join(profileDir, "antigravity-acp", "last-client-info.json"), "utf8"),
		) as { name?: string };
		assert.equal(recordedInfo.name, "zed");

		const completed = await manager.submitCallback(
			`http://127.0.0.1:${parsed!.port}/?state=browser-state-1&code=auth-code-99`,
			started.attemptId!,
		);
		assert.equal(completed.phase, "succeeded");
		assert.equal(completed.signedIn, true);
		assert.equal(isAntigravityProfileSignedIn({ authFile }), true);

		const afterLogout = await manager.logout(fakeRuntime());
		assert.equal(afterLogout.phase, "idle");
		assert.equal(afterLogout.signedIn, false);
		assert.equal(isAntigravityProfileSignedIn({ authFile }), false);
		assert.equal(fs.existsSync(modelsCache), false, "logout must delete cached Antigravity models.json");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("createAntigravityAuthManager supports stderr fallback, direct loopback browser completion, cancel, and error transitions", async () => {
	const root = makeTempRoot();
	try {
		const authFile = path.join(root, "auth.json");
		const dataDir = path.join(root, "data");

		// 1) stderr-only fallback + direct loopback hit (simulating real browser redirect)
		const stderrMgr = createAntigravityAuthManager({
			authFile,
			dataDir,
			env: {
				...process.env,
				FAKE_ACP_AUTH_MODE: "stderr-only",
				FAKE_ACP_STATE: "stderr-state-2",
			},
		});
		const waiting = await stderrMgr.startAuth(fakeRuntime({ version: "1.5.1" }));
		assert.equal(waiting.phase, "waiting");
		const parsed = parseAndValidateAntigravityOAuthUrl(waiting.authUrl!)!;
		await forwardLoopbackCallback(`http://127.0.0.1:${parsed.port}/?state=stderr-state-2&code=direct-code`);
		await stderrMgr.waitForIdle();
		assert.equal(stderrMgr.getState().phase, "succeeded");
		assert.equal(stderrMgr.getState().signedIn, true);

		// 2) cancel during waiting terminates child cleanly and transitions to cancelled
		const cancelMgr = createAntigravityAuthManager({
			authFile,
			dataDir,
			env: { ...process.env, FAKE_ACP_AUTH_MODE: "browser-only", FAKE_ACP_STATE: "cancel-state" },
		});
		const active = await cancelMgr.startAuth(fakeRuntime());
		assert.equal(active.phase, "waiting");
		const cancelled = await cancelMgr.cancelAuth(active.attemptId!);
		assert.equal(cancelled.phase, "cancelled");
		assert.equal(cancelled.authUrl, null);

		// 3) invalid OAuth URL transitions to failed
		const invalidUrlMgr = createAntigravityAuthManager({
			authFile,
			dataDir,
			env: { ...process.env, FAKE_ACP_AUTH_MODE: "invalid-url" },
		});
		const invalidRes = await invalidUrlMgr.startAuth(fakeRuntime());
		await invalidUrlMgr.waitForIdle();
		assert.equal(invalidUrlMgr.getState().phase, "failed");
		assert.match(invalidRes.error ?? invalidUrlMgr.getState().error ?? "", /invalid OAuth/i);

		// 4) synthetic ACP auth-error transitions to failed
		const errMgr = createAntigravityAuthManager({
			authFile,
			dataDir,
			env: { ...process.env, FAKE_ACP_AUTH_MODE: "auth-error" },
		});
		await errMgr.startAuth(fakeRuntime());
		await errMgr.waitForIdle();
		assert.equal(errMgr.getState().phase, "failed");
		assert.match(errMgr.getState().error ?? "", /synthetic auth error/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("antigravityAuthResponse enforces origin/header guards, validates actions, and drives start -> callback -> logout / DELETE", async () => {
	const root = makeTempRoot();
	try {
		const authFile = path.join(root, "auth.json");
		const dataDir = path.join(root, "data");
		const modelsCache = antigravityModelsCachePath({ dataDir });
		fs.mkdirSync(path.dirname(modelsCache), { recursive: true });
		fs.writeFileSync(modelsCache, "[]");

		const installer = createAntigravityInstallerManager({
			resolveRuntime: async () => ({
				runtime: fakeRuntime(),
				managedInstalled: true,
				updateRequiredVersion: null,
				error: null,
			}),
		});
		const auth = createAntigravityAuthManager({
			authFile,
			dataDir,
			env: {
				...process.env,
				FAKE_ACP_AUTH_MODE: "browser-and-stderr",
				FAKE_ACP_STATE: "http-state-1",
			},
		});
		const deps = {
			enabled: () => true,
			installer,
			auth,
			resolveRuntime: async () => ({
				runtime: fakeRuntime(),
				managedInstalled: true,
				updateRequiredVersion: null,
				error: null,
			}),
		};

		// Method + CSRF + disabled checks
		assert.equal((await antigravityAuthResponse(authReq("GET"), deps)).status, 405);
		assert.equal(
			(await antigravityAuthResponse(authReq("POST", { action: "start" }, { "x-learnharness-antigravity": "" }), deps)).status,
			403,
		);
		assert.equal(
			(await antigravityAuthResponse(authReq("POST", { action: "start" }, { origin: "https://evil.invalid" }), deps)).status,
			403,
		);
		assert.equal(
			(await antigravityAuthResponse(authReq("POST", { action: "start" }), { ...deps, enabled: () => false })).status,
			403,
		);

		// Missing runtime returns 409
		const missingRt = await antigravityAuthResponse(authReq("POST", { action: "start" }), {
			...deps,
			resolveRuntime: async () => ({
				runtime: null,
				managedInstalled: false,
				updateRequiredVersion: null,
				error: "Runtime missing",
			}),
		});
		assert.equal(missingRt.status, 409);

		// Content-type / invalid JSON / unknown action
		assert.equal(
			(
				await antigravityAuthResponse(
					new Request("http://localhost:3000/api/antigravity/auth", {
						method: "POST",
						headers: { "x-learnharness-antigravity": "1", "content-type": "text/plain" },
						body: "{}",
					}),
					deps,
				)
			).status,
			415,
		);
		assert.equal((await antigravityAuthResponse(authReq("POST", "{bad json"), deps)).status, 400);
		assert.equal((await antigravityAuthResponse(authReq("POST", { action: "unknown" }), deps)).status, 400);

		// Start sign-in -> 202 with waiting authUrl
		const startRes = await antigravityAuthResponse(authReq("POST", { action: "start" }), deps);
		assert.equal(startRes.status, 202);
		const startedStatus = (await startRes.json()) as AntigravityStatus;
		assert.equal(startedStatus.auth.phase, "waiting");
		const parsed = parseAndValidateAntigravityOAuthUrl(startedStatus.auth.authUrl!)!;

		// Bad manual callback -> 400
		const badCb = await antigravityAuthResponse(
			authReq("POST", { action: "callback", attemptId: startedStatus.auth.attemptId, callbackUrl: "https://evil.invalid" }),
			deps,
		);
		assert.equal(badCb.status, 400);

		// Wrong attemptId -> 409
		const wrongAttempt = await antigravityAuthResponse(
			authReq("POST", {
				action: "callback",
				attemptId: "wrong-attempt",
				callbackUrl: `http://127.0.0.1:${parsed.port}/?state=http-state-1&code=c1`,
			}),
			deps,
		);
		assert.equal(wrongAttempt.status, 409);

		// Valid manual callback -> 200 succeeded
		const cbRes = await antigravityAuthResponse(
			authReq("POST", {
				action: "callback",
				attemptId: startedStatus.auth.attemptId,
				callbackUrl: `http://127.0.0.1:${parsed.port}/?state=http-state-1&code=c1`,
			}),
			deps,
		);
		assert.equal(cbRes.status, 200);
		const cbStatus = (await cbRes.json()) as AntigravityStatus;
		assert.equal(cbStatus.auth.phase, "succeeded");
		assert.equal(cbStatus.auth.signedIn, true);

		// DELETE signs out and removes cached models.json
		const delRes = await antigravityAuthResponse(authReq("DELETE"), deps);
		assert.equal(delRes.status, 200);
		const delStatus = (await delRes.json()) as AntigravityStatus;
		assert.equal(delStatus.auth.signedIn, false);
		assert.equal(fs.existsSync(modelsCache), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("Secret boundaries: .gitignore, next.config.ts, and scripts/build-server.mjs exclude and refuse antigravity-profile", () => {
	const gitignore = fs.readFileSync(GITIGNORE_PATH, "utf8");
	assert.match(gitignore, /^antigravity-profile\/$/m);

	const nextConfig = fs.readFileSync(NEXT_CONFIG_PATH, "utf8");
	assert.match(nextConfig, /\*\*\/antigravity-profile\/\*\*\/\*/);

	const buildServerSource = fs.readFileSync(BUILD_SERVER_SCRIPT, "utf8");
	assert.match(buildServerSource, /antigravity-profile/);
	assert.match(buildServerSource, /REFUSING: standalone contains/);

	// Learner fs tools must refuse antigravity-profile beside LH_AUTH_FILE even outside ~/.gemini.
	const customHome = "/tmp/lh-learner-home";
	const customAuthFile = "/tmp/lh-custom-user-data/auth.json";
	const tokenOutsideHome = "/tmp/lh-custom-user-data/antigravity-profile/antigravity-acp/acp_token.json";
	assert.equal(isSensitivePath(tokenOutsideHome, customHome, customAuthFile), true);
	assert.equal(isSensitivePath("/tmp/lh-custom-user-data/antigravity-profile", customHome, customAuthFile), true);
	assert.equal(isSensitivePath("/tmp/lh-custom-user-data/notes.md", customHome, customAuthFile), false);

	const runtimeProfileToken = path.join(path.dirname(AUTH_FILE), "antigravity-profile", "antigravity-acp", "acp_token.json");
	assert.throws(() => resolveSourcePath(runtimeProfileToken), /Access denied/);
});

test("logout clears local token, models.json, and state even when ACP logout fails, and external token deletion updates signedIn", async () => {
	const root = makeTempRoot();
	try {
		const authFile = path.join(root, "secrets", "auth.json");
		const dataDir = path.join(root, "data");
		const modelsCache = antigravityModelsCachePath({ dataDir });
		fs.mkdirSync(path.dirname(modelsCache), { recursive: true });
		fs.writeFileSync(modelsCache, JSON.stringify([{ id: "gemini-3-pro" }]));

		const manager = createAntigravityAuthManager({
			authFile,
			dataDir,
			env: {
				...process.env,
				FAKE_ACP_AUTH_MODE: "browser-only",
				FAKE_ACP_STATE: "logout-err-state",
				FAKE_ACP_LOGOUT_MODE: "error",
			},
		});

		const started = await manager.startAuth(fakeRuntime());
		const parsed = parseAndValidateAntigravityOAuthUrl(started.authUrl!)!;
		await manager.submitCallback(
			`http://127.0.0.1:${parsed.port}/?state=logout-err-state&code=code-1`,
			started.attemptId!,
		);
		assert.equal(manager.getState().phase, "succeeded");
		assert.equal(manager.getState().signedIn, true);

		// External deletion of acp_token.json must immediately flip signedIn to false.
		const profileDir = resolveAntigravityProfileDir({ authFile });
		const tokenPath = antigravityTokenFilePath(profileDir);
		fs.rmSync(tokenPath, { force: true });
		assert.equal(manager.getState().signedIn, false);

		// Re-write token + models cache and verify failing ACP logout still purges local files & resets state.
		fs.writeFileSync(tokenPath, JSON.stringify({ token: "stale-tok" }), { mode: 0o600 });
		fs.writeFileSync(modelsCache, JSON.stringify([{ id: "gemini-3-pro" }]));
		await assert.rejects(() => manager.logout(fakeRuntime()), /synthetic logout error/);
		assert.equal(fs.existsSync(tokenPath), false);
		assert.equal(fs.existsSync(modelsCache), false);
		assert.equal(manager.getState().phase, "idle");
		assert.equal(manager.getState().signedIn, false);

		// HTTP handler returns 502 on ACP logout failure but clears local token/cache and model error.
		fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
		fs.writeFileSync(tokenPath, JSON.stringify({ token: "stale-tok-2" }), { mode: 0o600 });
		fs.writeFileSync(modelsCache, JSON.stringify([{ id: "gemini-3-pro" }]));
		let clearedError = false;
		const installer = createAntigravityInstallerManager({
			resolveRuntime: async () => ({
				runtime: fakeRuntime(),
				managedInstalled: true,
				updateRequiredVersion: null,
				error: null,
			}),
		});
		const models = {
			getStatus: () => ({ count: 0, updatedAt: null, discovering: false, error: null }),
			clearError: () => {
				clearedError = true;
			},
		};
		const res = await antigravityAuthResponse(authReq("POST", { action: "logout" }), {
			enabled: () => true,
			installer,
			auth: manager,
			models: models as never,
			resolveRuntime: async () => ({
				runtime: fakeRuntime(),
				managedInstalled: true,
				updateRequiredVersion: null,
				error: null,
			}),
		});
		assert.equal(res.status, 502);
		assert.equal(clearedError, true);
		assert.equal(fs.existsSync(tokenPath), false);
		assert.equal(fs.existsSync(modelsCache), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("agy 1.5.x CLI OAuth URLs, /auth/callback validation, antigravity-oauth-token detection, SSH stripping, and xdg-open capture work end-to-end", async () => {
	const cliOAuthUrl =
		"https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=cid&redirect_uri=http%3A%2F%2Flocalhost%3A45341%2Fauth%2Fcallback&state=cli-state";
	const parsedCli = parseAndValidateAntigravityOAuthUrl(cliOAuthUrl);
	assert.deepEqual(parsedCli, {
		authUrl: cliOAuthUrl,
		port: 45341,
		state: "cli-state",
		redirectUri: "http://localhost:45341/auth/callback",
	});

	assert.deepEqual(
		validateManualCallbackUrl("http://localhost:45341/auth/callback?state=cli-state&code=abc", {
			port: 45341,
			state: "cli-state",
			redirectUri: parsedCli!.redirectUri,
		}),
		{
			ok: true,
			forwardUrl: "http://127.0.0.1:45341/auth/callback?state=cli-state&code=abc",
		},
	);
	assert.equal(
		validateManualCallbackUrl("http://localhost:45341/wrong?state=cli-state&code=abc", {
			port: 45341,
			state: "cli-state",
			redirectUri: parsedCli!.redirectUri,
		}).ok,
		false,
	);

	const root = makeTempRoot();
	try {
		const authFile = path.join(root, "secrets", "auth.json");
		const dataDir = path.join(root, "data");
		const fakeHome = path.join(root, "home");
		fs.mkdirSync(fakeHome, { recursive: true });

		const profileDir = ensureAntigravityProfile({ authFile, homeDir: fakeHome });
		assert.equal(fs.existsSync(antigravityKeyringUnavailablePath(profileDir)), true);
		assert.equal(isAntigravityProfileSignedIn({ profileDir }), false);

		const cliTokenPath = antigravityCliTokenFilePath(profileDir);
		fs.writeFileSync(cliTokenPath, JSON.stringify({ token: { access_token: "nested-cli-tok" } }), { mode: 0o600 });
		assert.equal(isAntigravityProfileSignedIn({ profileDir }), true);
		assert.equal(deleteAntigravityTokenFile({ profileDir }), true);
		assert.equal(isAntigravityProfileSignedIn({ profileDir }), false);

		const scrubbedEnv = buildAntigravityEnvironment({
			baseEnv: {
				PATH: "/usr/bin:/bin",
				SSH_CONNECTION: "1.2.3.4 1000 5.6.7.8 22",
				SSH_CLIENT: "1.2.3.4 1000 22",
				SSH_TTY: "/dev/pts/0",
			},
			geminiHome: profileDir,
			tempDir: path.join(root, "tmp"),
			browserScript: "/tmp/lh-browser-dir/open-url.sh",
			platform: "linux",
		});
		assert.equal(scrubbedEnv.SSH_CONNECTION, undefined);
		assert.equal(scrubbedEnv.SSH_CLIENT, undefined);
		assert.equal(scrubbedEnv.SSH_TTY, undefined);
		assert.equal(scrubbedEnv.PATH?.startsWith("/tmp/lh-browser-dir:"), true);

		const manager = createAntigravityAuthManager({
			authFile,
			dataDir,
			homeDir: fakeHome,
			platform: "linux",
			env: {
				...process.env,
				HOME: fakeHome,
				FAKE_ACP_MODE: "cli-1510",
				FAKE_ACP_STATE: "cli-e2e-state",
				FAKE_ACP_RECORD_EVENTS: "1",
				SSH_CONNECTION: "1.2.3.4 1000 5.6.7.8 22",
				SSH_CLIENT: "1.2.3.4 1000 22",
				SSH_TTY: "/dev/pts/0",
				DISPLAY: "",
				WAYLAND_DISPLAY: "",
			},
		});

		const cliRuntime: ResolvedAntigravityRuntime = {
			source: "cli",
			kind: "cli",
			executablePath: FAKE_ACP,
			args: ["acp"],
			version: "1.5.10",
		};

		const started = await manager.startAuth(cliRuntime);
		assert.equal(started.phase, "waiting");
		assert.ok(started.authUrl);
		const parsed = parseAndValidateAntigravityOAuthUrl(started.authUrl!)!;
		assert.equal(parsed.redirectUri, `http://localhost:${parsed.port}/auth/callback`);

		const completed = await manager.submitCallback(
			`http://localhost:${parsed.port}/auth/callback?state=cli-e2e-state&code=cli-code-1`,
			started.attemptId!,
		);
		assert.equal(completed.phase, "succeeded");
		assert.equal(completed.signedIn, true);
		assert.equal(fs.existsSync(cliTokenPath), true);
		assert.deepEqual(fs.readdirSync(fakeHome), ["."].filter(() => false));

		const afterLogout = await manager.logout(cliRuntime);
		assert.equal(afterLogout.phase, "idle");
		assert.equal(afterLogout.signedIn, false);
		assert.equal(fs.existsSync(cliTokenPath), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
