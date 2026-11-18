import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { AntigravityAuthPhase, AntigravityAuthState } from "../../core/contracts/antigravity.ts";
import { clientInfoForRuntime, terminateAcpProcess } from "./acp-client.ts";
import {
	ANTIGRAVITY_AUTH_URL_MARKER,
	ANTIGRAVITY_AUTH_URL_WAIT_MS,
	ANTIGRAVITY_INIT_PROBE_TIMEOUT_MS,
	ANTIGRAVITY_LOGOUT_TIMEOUT_MS,
	ANTIGRAVITY_OAUTH_TIMEOUT_MS,
	ANTIGRAVITY_STDERR_AUTH_PROMPT,
} from "./constants.ts";
import { antigravityRuntimeArgs, type ResolvedAntigravityRuntime } from "./installation.ts";
import { shutdownAntigravityProcesses } from "./live-processes.ts";
import {
	buildAntigravityEnvironment,
	createBrowserWrapper,
	deleteAntigravityModelsCache,
	deleteAntigravityTokenFile,
	ensureAntigravityProfile,
	isAntigravityProfileSignedIn,
	touchAntigravityKeyringUnavailable,
	verifyBrowserWrapper,
	type BrowserWrapper,
} from "./profile.ts";

export { terminateAcpProcess };

export interface ValidatedAntigravityOAuthUrl {
	authUrl: string;
	port: number;
	state: string;
	redirectUri: string;
}

export interface ExtractedOAuthCandidate {
	source: "browser" | "stderr";
	rawUrl: string;
}

/** Extracts an OAuth URL candidate from either our preflighted `BROWSER` wrapper
 *  marker or `agy_acp_server`'s `stderr` fallback prompt line. */
export function extractAntigravityOAuthUrlFromLine(line: string): ExtractedOAuthCandidate | null {
	const markerIdx = line.indexOf(ANTIGRAVITY_AUTH_URL_MARKER);
	if (markerIdx !== -1) {
		const payload = line.slice(markerIdx + ANTIGRAVITY_AUTH_URL_MARKER.length).trim();
		try {
			const parsed = JSON.parse(payload) as unknown;
			if (typeof parsed === "string" && parsed.trim().length > 0) {
				return { source: "browser", rawUrl: parsed.trim() };
			}
		} catch {
			return null;
		}
	}

	const promptIdx = line.indexOf(ANTIGRAVITY_STDERR_AUTH_PROMPT);
	if (promptIdx !== -1) {
		const rest = line.slice(promptIdx + ANTIGRAVITY_STDERR_AUTH_PROMPT.length).trim();
		const token = rest.split(/\s+/, 1)[0]?.trim() ?? "";
		if (token) {
			return { source: "stderr", rawUrl: token };
		}
	}

	return null;
}

/** Strictly validates Google OAuth authorization URLs produced by Antigravity ACP:
 *  - `agy_acp_server`: `https://accounts.google.com/o/oauth2/v2/auth` -> `http://127.0.0.1:<port>/`
 *  - `agy` CLI 1.5+: `https://accounts.google.com/o/oauth2/auth` -> `http://localhost:<port>/auth/callback` (or `127.0.0.1` / `/`)
 *  with `response_type=code`, non-empty `state`, no embedded credentials, and integer port >= 1024. */
export function parseAndValidateAntigravityOAuthUrl(rawUrl: string): ValidatedAntigravityOAuthUrl | null {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl.trim());
	} catch {
		return null;
	}

	if (parsed.protocol !== "https:") return null;
	if (parsed.hostname !== "accounts.google.com") return null;
	const isLegacyV2 = parsed.pathname === "/o/oauth2/v2/auth";
	const isCliV1 = parsed.pathname === "/o/oauth2/auth";
	if (!isLegacyV2 && !isCliV1) return null;
	if (parsed.username || parsed.password) return null;
	if (parsed.searchParams.get("response_type") !== "code") return null;

	const state = parsed.searchParams.get("state");
	if (typeof state !== "string" || state.trim().length === 0) return null;

	const rawRedirect = parsed.searchParams.get("redirect_uri");
	if (!rawRedirect) return null;

	let redirect: URL;
	try {
		redirect = new URL(rawRedirect);
	} catch {
		return null;
	}

	if (redirect.protocol !== "http:") return null;
	if (redirect.username || redirect.password) return null;
	if (isLegacyV2) {
		if (redirect.hostname !== "127.0.0.1") return null;
		if (redirect.pathname !== "/") return null;
	} else {
		if (redirect.hostname !== "127.0.0.1" && redirect.hostname !== "localhost") return null;
		if (redirect.pathname !== "/" && redirect.pathname !== "/auth/callback") return null;
	}
	if (redirect.search || redirect.hash) return null;
	if (!/^\d+$/.test(redirect.port)) return null;

	const port = Number(redirect.port);
	if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) return null;

	return {
		authUrl: parsed.toString(),
		port,
		state,
		redirectUri: redirect.toString(),
	};
}

export type CallbackValidationResult =
	| { ok: true; forwardUrl: string }
	| { ok: false; error: string };

/** Validates a user-pasted manual OAuth redirect URL against the active attempt's
 *  loopback port, host/path, and state parameter before building a safe `127.0.0.1` GET target. */
export function validateManualCallbackUrl(
	rawCallbackUrl: string,
	expected: { port: number; state: string; redirectUri?: string },
): CallbackValidationResult {
	const trimmed = rawCallbackUrl.trim();
	if (!trimmed) {
		return { ok: false, error: "Paste the redirect URL from your browser." };
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { ok: false, error: "Redirect URL is not a valid URL." };
	}

	let expectedHost = "127.0.0.1";
	let expectedPath = "/";
	if (expected.redirectUri) {
		try {
			const expectedRedirect = new URL(expected.redirectUri);
			if (expectedRedirect.hostname === "localhost" || expectedRedirect.hostname === "127.0.0.1") {
				expectedHost = expectedRedirect.hostname;
			}
			if (expectedRedirect.pathname === "/" || expectedRedirect.pathname === "/auth/callback") {
				expectedPath = expectedRedirect.pathname;
			}
		} catch {
			// Fall back to strict 127.0.0.1 / defaults
		}
	}

	const hostAllowed =
		expectedHost === "localhost"
			? parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
			: parsed.hostname === "127.0.0.1";

	if (parsed.protocol !== "http:" || !hostAllowed || parsed.username || parsed.password) {
		return { ok: false, error: `Redirect URL must point to http://${expectedHost}:<port>${expectedPath}.` };
	}

	if (parsed.pathname !== expectedPath) {
		return { ok: false, error: `Redirect URL path must be ${expectedPath}.` };
	}

	if (!/^\d+$/.test(parsed.port) || Number(parsed.port) !== expected.port) {
		return {
			ok: false,
			error: `Redirect URL port does not match active sign-in attempt (${expected.port}).`,
		};
	}

	const actualState = parsed.searchParams.get("state");
	if (typeof actualState !== "string" || actualState.length === 0) {
		return { ok: false, error: "Redirect URL is missing the OAuth state parameter." };
	}
	const actualBuf = Buffer.from(actualState, "utf8");
	const expectedBuf = Buffer.from(expected.state, "utf8");
	if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
		return { ok: false, error: "Redirect URL state does not match the active sign-in attempt." };
	}

	const code = parsed.searchParams.get("code")?.trim() ?? "";
	const oauthError = parsed.searchParams.get("error")?.trim() ?? "";
	if (!code && !oauthError) {
		return { ok: false, error: "Redirect URL is missing an authorization code or error parameter." };
	}

	return {
		ok: true,
		forwardUrl: `http://127.0.0.1:${expected.port}${expectedPath}${parsed.search}`,
	};
}

export async function forwardLoopbackCallback(
	forwardUrl: string,
	timeoutMs = 10_000,
): Promise<{ statusCode: number }> {
	const parsed = new URL(forwardUrl);
	if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
		throw new Error("Refusing to forward callback outside 127.0.0.1.");
	}
	const port = Number(parsed.port);
	if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
		throw new Error("Refusing to forward callback to invalid port.");
	}

	return new Promise<{ statusCode: number }>((resolve, reject) => {
		const req = http.get(
			{
				hostname: "127.0.0.1",
				port,
				path: `${parsed.pathname}${parsed.search}`,
				timeout: timeoutMs,
			},
			(res) => {
				res.resume();
				const statusCode = res.statusCode ?? 0;
				res.on("end", () => {
					if (statusCode >= 400 || statusCode === 0) {
						reject(new Error(`Local OAuth callback listener returned HTTP ${statusCode}.`));
						return;
					}
					resolve({ statusCode });
				});
			},
		);
		req.on("timeout", () => {
			req.destroy(new Error("Timed out forwarding callback to local OAuth listener."));
		});
		req.on("error", (err) => {
			reject(new Error(`Could not reach local OAuth callback listener: ${err.message}`));
		});
	});
}

export interface AntigravityAuthManagerDeps {
	authFile?: string;
	dataDir?: string;
	env?: Record<string, string | undefined>;
	homeDir?: string;
	platform?: NodeJS.Platform;
	spawnProcess?: typeof spawn;
	ensureProfile?: () => string;
	isSignedIn?: () => boolean;
	clearModelsCache?: () => boolean;
	clearTokenFile?: () => boolean;
	createBrowserWrapper?: () => BrowserWrapper;
	verifyBrowserWrapper?: (scriptPath: string) => Promise<void>;
	forwardCallback?: (forwardUrl: string) => Promise<{ statusCode: number }>;
	onSignedIn?: (runtime: ResolvedAntigravityRuntime) => Promise<void> | void;
	authUrlWaitMs?: number;
	oauthTimeoutMs?: number;
	logoutTimeoutMs?: number;
	initTimeoutMs?: number;
}

interface ActiveAttempt {
	attemptId: string;
	phase: AntigravityAuthPhase;
	authUrl: string | null;
	callbackPort: number | null;
	expectedState: string | null;
	redirectUri: string | null;
	error: string | null;
	cancelled: boolean;
	child: ChildProcess | null;
	runDir: string | null;
	browserWrapper: BrowserWrapper | null;
	completionPromise: Promise<void>;
	resolveUrlReady: () => void;
	urlReadyPromise: Promise<void>;
}

export class AntigravityAuthError extends Error {
	statusCode: number;
	constructor(message: string, statusCode = 400) {
		super(message);
		this.statusCode = statusCode;
	}
}

export function createAntigravityAuthManager(deps: AntigravityAuthManagerDeps = {}) {
	const platform = deps.platform ?? process.platform;
	const spawnProcess = deps.spawnProcess ?? spawn;
	const ensureProfile =
		deps.ensureProfile ??
		(() =>
			ensureAntigravityProfile({
				authFile: deps.authFile,
				env: deps.env,
				homeDir: deps.homeDir,
				platform,
			}));
	const checkSignedIn =
		deps.isSignedIn ??
		(() =>
			isAntigravityProfileSignedIn({
				authFile: deps.authFile,
				env: deps.env,
			}));
	const clearModelsCache =
		deps.clearModelsCache ??
		(() =>
			deleteAntigravityModelsCache({
				dataDir: deps.dataDir,
				env: deps.env,
			}));
	const clearTokenFile =
		deps.clearTokenFile ??
		(() =>
			deleteAntigravityTokenFile({
				authFile: deps.authFile,
				env: deps.env,
			}));
	const makeBrowserWrapper =
		deps.createBrowserWrapper ?? (() => createBrowserWrapper({ platform }));
	const checkBrowserWrapper =
		deps.verifyBrowserWrapper ?? ((scriptPath: string) => verifyBrowserWrapper(scriptPath, { platform }));
	const forwardCallback = deps.forwardCallback ?? forwardLoopbackCallback;

	const authUrlWaitMs = deps.authUrlWaitMs ?? ANTIGRAVITY_AUTH_URL_WAIT_MS;
	const oauthTimeoutMs = deps.oauthTimeoutMs ?? ANTIGRAVITY_OAUTH_TIMEOUT_MS;
	const logoutTimeoutMs = deps.logoutTimeoutMs ?? ANTIGRAVITY_LOGOUT_TIMEOUT_MS;
	const initTimeoutMs = deps.initTimeoutMs ?? ANTIGRAVITY_INIT_PROBE_TIMEOUT_MS;

	let phase: AntigravityAuthPhase = "idle";
	let lastAttemptId: string | null = null;
	let lastAuthUrl: string | null = null;
	let lastError: string | null = null;
	let active: ActiveAttempt | null = null;

	function getState(): AntigravityAuthState {
		const diskSignedIn = checkSignedIn();
		if (active) {
			return {
				signedIn: diskSignedIn,
				phase: active.phase,
				attemptId: active.attemptId,
				authUrl: active.authUrl,
				error: active.error,
			};
		}
		return {
			signedIn: diskSignedIn,
			phase,
			attemptId: lastAttemptId,
			authUrl: lastAuthUrl,
			error: lastError,
		};
	}

	function syncSnapshotFromAttempt(attempt: ActiveAttempt): void {
		phase = attempt.phase;
		lastAttemptId = attempt.attemptId;
		lastAuthUrl = attempt.authUrl;
		lastError = attempt.error;
	}

	async function cleanupAttemptResources(attempt: ActiveAttempt, forceTerm = false): Promise<void> {
		if (attempt.child) {
			const child = attempt.child;
			attempt.child = null;
			await terminateAcpProcess(child, { forceTerm });
		}
		if (attempt.browserWrapper) {
			const wrapper = attempt.browserWrapper;
			attempt.browserWrapper = null;
			try {
				wrapper.cleanup();
			} catch {
				// ignore
			}
		}
		if (attempt.runDir) {
			const runDir = attempt.runDir;
			attempt.runDir = null;
			try {
				fs.rmSync(runDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	}

	async function startAuth(runtime: ResolvedAntigravityRuntime): Promise<AntigravityAuthState> {
		if (active && (active.phase === "starting" || active.phase === "waiting" || active.phase === "verifying")) {
			return getState();
		}

		const attemptId = randomUUID();
		let resolveUrlReady!: () => void;
		const urlReadyPromise = new Promise<void>((resolve) => {
			resolveUrlReady = resolve;
		});

		const attempt: ActiveAttempt = {
			attemptId,
			phase: "starting",
			authUrl: null,
			callbackPort: null,
			expectedState: null,
			redirectUri: null,
			error: null,
			cancelled: false,
			child: null,
			runDir: null,
			browserWrapper: null,
			completionPromise: Promise.resolve(),
			resolveUrlReady,
			urlReadyPromise,
		};

		active = attempt;
		syncSnapshotFromAttempt(attempt);

		attempt.completionPromise = (async () => {
			let rl: readline.Interface | null = null;
			let stderrRl: readline.Interface | null = null;
			let oauthTimer: ReturnType<typeof setTimeout> | null = null;
			let initTimer: ReturnType<typeof setTimeout> | null = null;
			let urlPollTimer: ReturnType<typeof setInterval> | null = null;

			const finishAttempt = async (
				nextPhase: AntigravityAuthPhase,
				errorMessage: string | null,
				forceTerm = false,
			) => {
				if (oauthTimer) clearTimeout(oauthTimer);
				if (initTimer) clearTimeout(initTimer);
				if (urlPollTimer) clearInterval(urlPollTimer);
				rl?.close();
				stderrRl?.close();
				if (attempt.cancelled) {
					attempt.phase = "cancelled";
					attempt.authUrl = null;
					attempt.error = null;
				} else {
					attempt.phase = nextPhase;
					attempt.error = errorMessage;
					if (nextPhase !== "waiting") attempt.authUrl = null;
				}
				syncSnapshotFromAttempt(attempt);
				attempt.resolveUrlReady();
				await cleanupAttemptResources(attempt, forceTerm);
				if (active === attempt) {
					active = null;
				}
			};

			try {
				const profileDir = ensureProfile();
				if (runtime.kind === "cli") {
					touchAntigravityKeyringUnavailable(profileDir, platform);
				}
				const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-auth-"));
				const cwd = path.join(runDir, "cwd");
				const tempDir = path.join(runDir, "tmp");
				fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
				fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
				attempt.runDir = runDir;

				const wrapper = makeBrowserWrapper();
				attempt.browserWrapper = wrapper;
				await checkBrowserWrapper(wrapper.scriptPath);
				if (wrapper.capturedUrlPath) {
					try {
						fs.rmSync(wrapper.capturedUrlPath, { force: true });
					} catch {
						// ignore
					}
				}
				if (attempt.cancelled) {
					await finishAttempt("cancelled", null);
					return;
				}

				const env = buildAntigravityEnvironment({
					baseEnv: deps.env ?? process.env,
					geminiHome: profileDir,
					tempDir,
					harnessPath: runtime.harnessPath,
					browserScript: wrapper.scriptPath,
					platform,
				});
				if (platform === "linux" && runtime.kind === "cli" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
					env.DISPLAY = ":0";
				}

				const child = spawnProcess(runtime.executablePath, antigravityRuntimeArgs(runtime, profileDir), {
					cwd,
					env,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
				attempt.child = child;

				let initDone = false;
				let authSettled = false;
				let stderrTail = "";

				await new Promise<void>((resolveRun) => {
					const failRun = (msg: string, forceTerm = true) => {
						if (authSettled) return;
						authSettled = true;
						void finishAttempt("failed", msg, forceTerm).then(resolveRun);
					};

					const succeedRun = () => {
						if (authSettled) return;
						authSettled = true;
						if (oauthTimer) clearTimeout(oauthTimer);
						if (initTimer) clearTimeout(initTimer);
						if (urlPollTimer) clearInterval(urlPollTimer);
						if (!deps.onSignedIn) {
							void finishAttempt("succeeded", null, false).then(resolveRun);
							return;
						}
						void (async () => {
							if (!attempt.cancelled) {
								attempt.phase = "verifying";
								attempt.authUrl = null;
								syncSnapshotFromAttempt(attempt);
							}
							rl?.close();
							stderrRl?.close();
							await cleanupAttemptResources(attempt, false);
							if (!attempt.cancelled) {
								try {
									await deps.onSignedIn!(runtime);
								} catch {
									// Sign-in succeeded even if initial model discovery fails.
								}
							}
							await finishAttempt("succeeded", null, false);
							resolveRun();
						})();
					};

					oauthTimer = setTimeout(() => {
						failRun("Google sign-in timed out before completing.", true);
					}, oauthTimeoutMs);
					oauthTimer.unref();

					initTimer = setTimeout(() => {
						if (!initDone) {
							failRun("Antigravity runtime did not respond to initialize.", true);
						}
					}, initTimeoutMs);
					initTimer.unref();

					const acceptCandidateUrl = (rawUrl: string) => {
						if (attempt.cancelled || authSettled) return;
						const validated = parseAndValidateAntigravityOAuthUrl(rawUrl);
						if (!validated) {
							if (!attempt.authUrl) {
								failRun("Antigravity emitted an invalid OAuth authorization URL.", true);
							}
							return;
						}
						if (!attempt.authUrl) {
							if (urlPollTimer) {
								clearInterval(urlPollTimer);
								urlPollTimer = null;
							}
							attempt.authUrl = validated.authUrl;
							attempt.callbackPort = validated.port;
							attempt.expectedState = validated.state;
							attempt.redirectUri = validated.redirectUri;
							if (attempt.phase === "starting") {
								attempt.phase = "waiting";
							}
							syncSnapshotFromAttempt(attempt);
							attempt.resolveUrlReady();
						}
					};

					const handleCandidateLine = (line: string) => {
						if (attempt.cancelled || authSettled) return;
						const extracted = extractAntigravityOAuthUrlFromLine(line);
						if (!extracted) return;
						acceptCandidateUrl(extracted.rawUrl);
					};

					if (wrapper.capturedUrlPath) {
						const capturedUrlPath = wrapper.capturedUrlPath;
						urlPollTimer = setInterval(() => {
							if (attempt.cancelled || authSettled || attempt.authUrl) {
								if (urlPollTimer) {
									clearInterval(urlPollTimer);
									urlPollTimer = null;
								}
								return;
							}
							try {
								const raw = fs.readFileSync(capturedUrlPath, "utf8").trim();
								if (raw) {
									const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
									if (firstLine) acceptCandidateUrl(firstLine);
								}
							} catch {
								// file not written yet
							}
						}, 40);
						urlPollTimer.unref();
					}

					if (child.stderr) {
						stderrRl = readline.createInterface({ input: child.stderr });
						stderrRl.on("line", (line) => {
							if (stderrTail.length < 4096) {
								stderrTail += `${line}\n`;
							}
							handleCandidateLine(line);
						});
					}

					if (child.stdout) {
						rl = readline.createInterface({ input: child.stdout });
						rl.on("line", (line) => {
							const trimmed = line.trim();
							if (!trimmed) return;
							let msg: {
								id?: unknown;
								error?: { message?: unknown };
								result?: unknown;
							};
							try {
								msg = JSON.parse(trimmed) as typeof msg;
							} catch {
								return;
							}
							if (msg.id === 1 && !initDone) {
								initDone = true;
								if (initTimer) clearTimeout(initTimer);
								if (msg.error) {
									const reason =
										typeof msg.error.message === "string" ? msg.error.message : "initialize failed";
									failRun(`Antigravity initialize failed: ${reason}`, false);
									return;
								}
								const authReq = JSON.stringify({
									jsonrpc: "2.0",
									id: 2,
									method: "authenticate",
									params: { methodId: "oauth-personal" },
								});
								child.stdin?.write(`${authReq}\n`, (err) => {
									if (err) failRun(`Failed sending authenticate request: ${err.message}`, true);
								});
								return;
							}
							if (msg.id === 2) {
								if (msg.error) {
									const reason =
										typeof msg.error.message === "string" ? msg.error.message : "authentication failed";
									failRun(`Google sign-in failed: ${reason}`, false);
									return;
								}
								succeedRun();
							}
						});
					}

					child.on("error", (err) => {
						failRun(`Failed to start Antigravity runtime: ${err.message}`, true);
					});

					child.on("close", (code) => {
						if (authSettled) return;
						if (attempt.cancelled) {
							authSettled = true;
							void finishAttempt("cancelled", null, false).then(resolveRun);
							return;
						}
						const detail = stderrTail.trim() ? `: ${stderrTail.trim().slice(0, 240)}` : "";
						failRun(`Antigravity exited before sign-in finished (code ${code ?? "null"})${detail}`, false);
					});

					const initReq = JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {
							protocolVersion: 1,
							clientInfo: clientInfoForRuntime(runtime),
							clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
						},
					});
					child.stdin?.write(`${initReq}\n`, (err) => {
						if (err) failRun(`Failed sending initialize request: ${err.message}`, true);
					});
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Could not start Antigravity sign-in.";
				await finishAttempt("failed", msg, true);
			}
		})();

		const waitTimer = new Promise<void>((resolve) => {
			const t = setTimeout(resolve, authUrlWaitMs);
			t.unref();
		});
		await Promise.race([attempt.urlReadyPromise, waitTimer]);
		return getState();
	}

	async function submitCallback(callbackUrl: string, attemptId?: string): Promise<AntigravityAuthState> {
		const current = active;
		if (!current || (current.phase !== "waiting" && current.phase !== "verifying")) {
			throw new AntigravityAuthError("No active Google sign-in attempt is waiting for a callback.", 409);
		}
		if (attemptId && attemptId !== current.attemptId) {
			throw new AntigravityAuthError("Callback does not match the active sign-in attempt.", 409);
		}
		if (current.callbackPort === null || current.expectedState === null) {
			throw new AntigravityAuthError("Sign-in attempt has not initialized a callback listener yet.", 409);
		}

		const validated = validateManualCallbackUrl(callbackUrl, {
			port: current.callbackPort,
			state: current.expectedState,
			redirectUri: current.redirectUri ?? undefined,
		});
		if (!validated.ok) {
			throw new AntigravityAuthError(validated.error, 400);
		}

		current.phase = "verifying";
		syncSnapshotFromAttempt(current);

		try {
			await forwardCallback(validated.forwardUrl);
		} catch (err) {
			if (active === current && !current.cancelled) {
				current.phase = "waiting";
				syncSnapshotFromAttempt(current);
			}
			const msg = err instanceof Error ? err.message : "Failed forwarding callback to local listener.";
			throw new AntigravityAuthError(msg, 502);
		}

		const settleTimeout = new Promise<void>((resolve) => {
			const t = setTimeout(resolve, 10_000);
			t.unref();
		});
		await Promise.race([current.completionPromise, settleTimeout]);
		return getState();
	}

	async function cancelAuth(attemptId?: string): Promise<AntigravityAuthState> {
		const current = active;
		if (!current) {
			if (phase !== "idle" && phase !== "succeeded") {
				phase = "cancelled";
				lastAuthUrl = null;
				lastError = null;
			}
			return getState();
		}
		if (attemptId && attemptId !== current.attemptId) {
			throw new AntigravityAuthError("Attempt ID does not match active sign-in.", 409);
		}

		current.cancelled = true;
		current.phase = "cancelled";
		current.authUrl = null;
		current.error = null;
		syncSnapshotFromAttempt(current);
		current.resolveUrlReady();
		if (current.child) {
			await terminateAcpProcess(current.child, { forceTerm: true });
		}
		await current.completionPromise;
		return getState();
	}

	async function logout(runtime: ResolvedAntigravityRuntime | null): Promise<AntigravityAuthState> {
		if (active) {
			await cancelAuth();
		}
		await shutdownAntigravityProcesses();

		try {
			if (runtime) {
				const profileDir = ensureProfile();
				if (runtime.kind === "cli") {
					touchAntigravityKeyringUnavailable(profileDir, platform);
				}
				const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-logout-"));
				const cwd = path.join(runDir, "cwd");
				const tempDir = path.join(runDir, "tmp");
				fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
				fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });

				try {
					const env = buildAntigravityEnvironment({
						baseEnv: deps.env ?? process.env,
						geminiHome: profileDir,
						tempDir,
						harnessPath: runtime.harnessPath,
						platform,
					});

					await new Promise<void>((resolve, reject) => {
						const child = spawnProcess(runtime.executablePath, antigravityRuntimeArgs(runtime, profileDir), {
							cwd,
							env,
							stdio: ["pipe", "pipe", "pipe"],
							windowsHide: true,
						});
						const rl = child.stdout ? readline.createInterface({ input: child.stdout }) : null;
						let settled = false;
						let initDone = false;

						const finish = (err?: Error) => {
							if (settled) return;
							settled = true;
							clearTimeout(timer);
							rl?.close();
							void terminateAcpProcess(child, { forceTerm: false }).then(() => {
								if (err) reject(err);
								else resolve();
							});
						};

						const timer = setTimeout(() => {
							finish(new Error("Antigravity logout timed out."));
						}, logoutTimeoutMs);
						timer.unref();

						rl?.on("line", (line) => {
							const trimmed = line.trim();
							if (!trimmed) return;
							let msg: { id?: unknown; error?: { message?: unknown } };
							try {
								msg = JSON.parse(trimmed) as typeof msg;
							} catch {
								return;
							}
							if (msg.id === 1 && !initDone) {
								initDone = true;
								if (msg.error) {
									finish(new Error(typeof msg.error.message === "string" ? msg.error.message : "initialize failed"));
									return;
								}
								const logoutReq = JSON.stringify({
									jsonrpc: "2.0",
									id: 2,
									method: "logout",
									params: {},
								});
								child.stdin?.write(`${logoutReq}\n`, (err) => {
									if (err) finish(new Error(`Failed sending logout request: ${err.message}`));
								});
								return;
							}
							if (msg.id === 2) {
								if (msg.error) {
									finish(new Error(typeof msg.error.message === "string" ? msg.error.message : "logout failed"));
									return;
								}
								finish();
							}
						});

						child.on("error", (err) => {
							finish(new Error(`Failed to spawn Antigravity runtime for logout: ${err.message}`));
						});

						child.on("close", (code) => {
							if (!settled) {
								finish(new Error(`Antigravity exited during logout (code ${code ?? "null"}).`));
							}
						});

						const initReq = JSON.stringify({
							jsonrpc: "2.0",
							id: 1,
							method: "initialize",
							params: {
								protocolVersion: 1,
								clientInfo: clientInfoForRuntime(runtime),
								clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
							},
						});
						child.stdin?.write(`${initReq}\n`, (err) => {
							if (err) finish(new Error(`Failed writing initialize request: ${err.message}`));
						});
					});
				} finally {
					fs.rmSync(runDir, { recursive: true, force: true });
				}
			}
		} finally {
			clearTokenFile();
			clearModelsCache();
			phase = "idle";
			lastAttemptId = null;
			lastAuthUrl = null;
			lastError = null;
		}
		return getState();
	}

	async function waitForIdle(): Promise<void> {
		if (active) {
			await active.completionPromise;
		}
	}

	return {
		getState,
		startAuth,
		submitCallback,
		cancelAuth,
		logout,
		waitForIdle,
	};
}
