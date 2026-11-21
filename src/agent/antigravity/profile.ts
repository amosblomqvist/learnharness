import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AUTH_FILE, PATHS } from "../../../config.ts";
import { externalCliEnv } from "../../core/auth-env.ts";
import {
	ANTIGRAVITY_AUTH_URL_MARKER,
	ANTIGRAVITY_ENV_STRIP_KEYS,
	ANTIGRAVITY_PROFILE_DIRNAME,
	LINUX_CA_BUNDLE_PATHS,
} from "./constants.ts";

function defaultFileExists(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function defaultDirExists(dirPath: string): boolean {
	try {
		return fs.statSync(dirPath).isDirectory();
	} catch {
		return false;
	}
}

function writeFileAtomic(filePath: string, content: string, mode = 0o600): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
	fs.writeFileSync(tmp, content, { encoding: "utf8", mode });
	fs.renameSync(tmp, filePath);
}

/** Resolves the isolated Antigravity Profile (`GEMINI_HOME`) beside `LH_AUTH_FILE`
 *  so OAuth tokens never land in `LH_DATA_DIR` or packaged builds (ADR-0002). */
export function resolveAntigravityProfileDir(options: {
	authFile?: string;
	env?: Record<string, string | undefined>;
} = {}): string {
	const env = options.env ?? process.env;
	const authFile = options.authFile?.trim()
		? path.resolve(options.authFile.trim())
		: env.LH_AUTH_FILE?.trim()
			? path.resolve(env.LH_AUTH_FILE.trim())
			: AUTH_FILE;
	return path.join(path.dirname(authFile), ANTIGRAVITY_PROFILE_DIRNAME);
}

export function antigravityProfileSettingsPath(profileDir: string): string {
	return path.join(profileDir, "antigravity-acp", "settings.json");
}

export function antigravityTokenFilePath(profileDir: string): string {
	return path.join(profileDir, "antigravity-acp", "acp_token.json");
}

export function antigravityCliTokenFilePath(profileDir: string): string {
	return path.join(profileDir, "antigravity-acp", "antigravity-oauth-token");
}

export function antigravityKeyringUnavailablePath(profileDir: string): string {
	return path.join(profileDir, "antigravity-acp", "cache", "antigravity-keyring-unavailable");
}

/** Keeps `antigravity-acp/cache/antigravity-keyring-unavailable` fresh so `agy`
 *  1.5+ uses profile-local file token storage rather than the host OS keyring. */
export function touchAntigravityKeyringUnavailable(
	profileDir: string,
	platform: NodeJS.Platform = process.platform,
): void {
	const markerPath = antigravityKeyringUnavailablePath(profileDir);
	const cacheDir = path.dirname(markerPath);
	fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
	if (platform !== "win32") {
		fs.chmodSync(cacheDir, 0o700);
	}
	writeFileAtomic(markerPath, "1\n", 0o600);
}

export function antigravityModelsCachePath(options: {
	dataDir?: string;
	env?: Record<string, string | undefined>;
} = {}): string {
	const env = options.env ?? process.env;
	const dataDir = options.dataDir?.trim()
		? path.resolve(options.dataDir.trim())
		: env.LH_DATA_DIR?.trim()
			? path.resolve(env.LH_DATA_DIR.trim())
			: PATHS.data;
	return path.join(dataDir, "antigravity", "models.json");
}

function readJsonTokenObject(filePath: string): Record<string, unknown> | null {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return null;
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function hasNonEmptyCliTokenField(parsed: Record<string, unknown>): boolean {
	for (const key of ["access_token", "refresh_token", "id_token", "api_key", "token", "accessToken", "refreshToken"]) {
		const val = parsed[key];
		if (typeof val === "string" && val.trim().length > 0) return true;
	}
	const nestedToken = parsed.token;
	if (nestedToken && typeof nestedToken === "object" && !Array.isArray(nestedToken)) {
		const inner = nestedToken as Record<string, unknown>;
		for (const key of ["access_token", "refresh_token", "token", "accessToken", "refreshToken"]) {
			const val = inner[key];
			if (typeof val === "string" && val.trim().length > 0) return true;
		}
	}
	return false;
}

/** Checks whether the isolated Antigravity profile holds a persisted OAuth token blob. */
export function isAntigravityProfileSignedIn(options: {
	profileDir?: string;
	authFile?: string;
	env?: Record<string, string | undefined>;
} = {}): boolean {
	const profileDir = options.profileDir ?? resolveAntigravityProfileDir(options);
	const acpToken = readJsonTokenObject(antigravityTokenFilePath(profileDir));
	if (
		acpToken &&
		Object.values(acpToken).some((val) => typeof val === "string" && val.trim().length > 0)
	) {
		return true;
	}
	const cliToken = readJsonTokenObject(antigravityCliTokenFilePath(profileDir));
	if (cliToken && hasNonEmptyCliTokenField(cliToken)) {
		return true;
	}
	return false;
}

/** Creates and hardens `antigravity-profile/` (`0700`), writes `oauth-personal`
 *  settings, and optionally symlinks user skills from `~/.gemini` if present. */
export function ensureAntigravityProfile(options: {
	authFile?: string;
	env?: Record<string, string | undefined>;
	homeDir?: string;
	platform?: NodeJS.Platform;
} = {}): string {
	const platform = options.platform ?? process.platform;
	const homeDir = options.homeDir ?? os.homedir();
	const profileDir = resolveAntigravityProfileDir(options);
	const acpDir = path.join(profileDir, "antigravity-acp");

	fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(acpDir, { recursive: true, mode: 0o700 });
	if (platform !== "win32") {
		fs.chmodSync(profileDir, 0o700);
		fs.chmodSync(acpDir, 0o700);
	}

	const settingsPath = antigravityProfileSettingsPath(profileDir);
	let existing: Record<string, unknown> = {};
	try {
		const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			existing = raw as Record<string, unknown>;
		}
	} catch {
		// absent or malformed — rewrite cleanly
	}
	const existingAuth =
		existing.auth && typeof existing.auth === "object" && !Array.isArray(existing.auth)
			? (existing.auth as Record<string, unknown>)
			: {};
	const nextSettings: Record<string, unknown> = {
		...existing,
		auth: {
			...existingAuth,
			type: "oauth-personal",
		},
	};
	writeFileAtomic(settingsPath, `${JSON.stringify(nextSettings, null, "\t")}\n`, 0o600);
	touchAntigravityKeyringUnavailable(profileDir, platform);

	// Optional user skills symlinks from ~/.gemini (read-only convenience; never fatal).
	const geminiRoot = path.join(homeDir, ".gemini");
	const skillLinks: Array<[string, string]> = [
		[path.join(geminiRoot, "config", "skills"), path.join(profileDir, "config", "skills")],
		[path.join(geminiRoot, "antigravity-cli", "skills"), path.join(profileDir, "antigravity-cli", "skills")],
		[path.join(geminiRoot, "skills"), path.join(profileDir, "skills")],
	];
	for (const [src, dest] of skillLinks) {
		if (!defaultDirExists(src)) continue;
		try {
			fs.lstatSync(dest);
			continue; // already exists (file, dir, or symlink)
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") continue;
		}
		try {
			fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
			fs.symlinkSync(src, dest, platform === "win32" ? "junction" : "dir");
		} catch {
			// Best-effort optional skills symlink
		}
	}

	return profileDir;
}

export function deleteAntigravityModelsCache(options: {
	dataDir?: string;
	env?: Record<string, string | undefined>;
} = {}): boolean {
	const cachePath = antigravityModelsCachePath(options);
	try {
		const existed = fs.existsSync(cachePath);
		fs.rmSync(cachePath, { force: true });
		return existed;
	} catch {
		return false;
	}
}

export function deleteAntigravityTokenFile(options: {
	profileDir?: string;
	authFile?: string;
	env?: Record<string, string | undefined>;
} = {}): boolean {
	const profileDir = options.profileDir ?? resolveAntigravityProfileDir(options);
	const candidates = [
		antigravityTokenFilePath(profileDir),
		antigravityCliTokenFilePath(profileDir),
		path.join(profileDir, "antigravity-cli", "antigravity-oauth-token"),
	];
	let anyExisted = false;
	for (const tokenPath of candidates) {
		try {
			if (fs.existsSync(tokenPath)) anyExisted = true;
			fs.rmSync(tokenPath, { force: true });
		} catch {
			// continue clearing remaining candidate paths
		}
	}
	return anyExisted;
}

export interface BuildAntigravityEnvOptions {
	baseEnv?: Record<string, string | undefined>;
	geminiHome: string;
	tempDir: string;
	harnessPath?: string;
	browserScript?: string;
	platform?: NodeJS.Platform;
	fileExists?: (filePath: string) => boolean;
}

/** Builds a scrubbed child environment for `Antigravity Runtime` processes,
 *  stripping LearnHarness-reflected keys and ambient Google/Vertex/GCloud vars. */
export function buildAntigravityEnvironment({
	baseEnv = process.env,
	geminiHome,
	tempDir,
	harnessPath,
	browserScript,
	platform = process.platform,
	fileExists = defaultFileExists,
}: BuildAntigravityEnvOptions): NodeJS.ProcessEnv {
	const env = externalCliEnv(baseEnv as NodeJS.ProcessEnv);
	for (const key of ANTIGRAVITY_ENV_STRIP_KEYS) {
		delete env[key];
	}
	env.GEMINI_HOME = geminiHome;
	env.TMPDIR = tempDir;
	env.AGY_ACP_FORCE_FILE_STORAGE = "1";
	env.PYTHONUNBUFFERED = "1";
	env.ELECTRON_RUN_AS_NODE = "1";
	if (harnessPath) env.ANTIGRAVITY_HARNESS_PATH = harnessPath;
	if (browserScript) {
		env.BROWSER = browserScript;
		if (platform !== "win32") {
			const browserDir = path.dirname(browserScript);
			const pathModule = path.posix;
			if (browserDir && browserDir !== ".") {
				env.PATH = env.PATH ? `${browserDir}${pathModule.delimiter}${env.PATH}` : browserDir;
			}
		}
	}
	if (platform === "linux" && !env.SSL_CERT_FILE) {
		const fallback = env.NIX_SSL_CERT_FILE ?? LINUX_CA_BUNDLE_PATHS.find((p) => fileExists(p));
		if (fallback) env.SSL_CERT_FILE = fallback;
	}
	return env;
}

function shellQuotePosix(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface BrowserWrapper {
	dir: string;
	scriptPath: string;
	capturedUrlPath?: string;
	cleanup: () => void;
}

/** Creates an executable `BROWSER` wrapper script (no spaces in `BROWSER` path)
 *  and POSIX `xdg-open` shim because `agy_acp_server.par` ignores inline
 *  `node -e` strings while `agy` CLI invokes `xdg-open` directly on Linux
 *  and discards its child stderr. */
export function createBrowserWrapper(options: {
	baseTmpDir?: string;
	nodePath?: string;
	platform?: NodeJS.Platform;
} = {}): BrowserWrapper {
	const platform = options.platform ?? process.platform;
	const nodePath = options.nodePath ?? process.execPath;
	const dir = fs.mkdtempSync(path.join(options.baseTmpDir ?? os.tmpdir(), "lh-agy-browser-"));
	if (platform !== "win32") {
		fs.chmodSync(dir, 0o700);
	}

	const capturedUrlPath = path.join(dir, "captured-url.txt");
	const helperPath = path.join(dir, "capture-url.mjs");
	fs.writeFileSync(
		helperPath,
		[
			"import * as fs from 'node:fs';",
			"const url = (process.argv[2] ?? '').trim();",
			"if (url) {",
			`  if (!url.startsWith('https://learnharness.invalid/')) fs.writeFileSync(${JSON.stringify(capturedUrlPath)}, url + '\\n', { encoding: 'utf8', mode: 0o600 });`,
			`  process.stderr.write(${JSON.stringify(ANTIGRAVITY_AUTH_URL_MARKER)} + JSON.stringify(url) + '\\n');`,
			"}",
			"",
		].join("\n"),
		{ encoding: "utf8", mode: 0o600 },
	);

	let scriptPath: string;
	if (platform === "win32") {
		scriptPath = path.join(dir, "open-url.cmd");
		fs.writeFileSync(
			scriptPath,
			`@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${nodePath}" "${helperPath}" %*\r\n`,
			{ encoding: "utf8" },
		);
	} else {
		scriptPath = path.join(dir, "open-url.sh");
		const wrapperScript = `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${shellQuotePosix(nodePath)} ${shellQuotePosix(helperPath)} "$@"\n`;
		fs.writeFileSync(scriptPath, wrapperScript, { encoding: "utf8", mode: 0o700 });
		fs.chmodSync(scriptPath, 0o700);

		const xdgOpenPath = path.join(dir, "xdg-open");
		fs.writeFileSync(xdgOpenPath, wrapperScript, { encoding: "utf8", mode: 0o700 });
		fs.chmodSync(xdgOpenPath, 0o700);
	}

	return {
		dir,
		scriptPath,
		capturedUrlPath,
		cleanup: () => {
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** Preflight-verifies that the `BROWSER` wrapper script is executable and emits
 *  the expected URL marker on stderr when invoked with a URL argument. */
export async function verifyBrowserWrapper(
	scriptPath: string,
	options: {
		platform?: NodeJS.Platform;
		timeoutMs?: number;
		env?: NodeJS.ProcessEnv;
	} = {},
): Promise<void> {
	const platform = options.platform ?? process.platform;
	const timeoutMs = options.timeoutMs ?? 5_000;
	const stat = fs.statSync(scriptPath);
	if (!stat.isFile()) {
		throw new Error("BROWSER wrapper path is not a regular file.");
	}
	if (platform !== "win32") {
		fs.accessSync(scriptPath, fs.constants.X_OK);
	}

	const probeUrl = "https://learnharness.invalid/browser-preflight";
	const expectedLine = `${ANTIGRAVITY_AUTH_URL_MARKER}${JSON.stringify(probeUrl)}`;

	await new Promise<void>((resolve, reject) => {
		const child = spawn(scriptPath, [probeUrl], {
			cwd: path.dirname(scriptPath),
			env: { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			shell: platform === "win32",
		});
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				child.kill("SIGKILL");
			} catch {
				// ignore
			}
			reject(new Error("BROWSER wrapper preflight timed out."));
		}, timeoutMs);
		timer.unref();

		child.stderr?.on("data", (chunk: Buffer | string) => {
			if (stderr.length < 4096) stderr += chunk.toString();
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`BROWSER wrapper preflight failed to spawn: ${err.message}`));
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`BROWSER wrapper preflight exited with code ${code ?? "null"}.`));
				return;
			}
			if (!stderr.includes(expectedLine)) {
				reject(new Error("BROWSER wrapper preflight did not emit expected OAuth URL marker."));
				return;
			}
			resolve();
		});
	});
}
