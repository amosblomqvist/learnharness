import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { PATHS } from "../../../config.ts";
import packageMetadata from "../../../package.json" with { type: "json" };
import { externalCliEnv } from "../../core/auth-env.ts";
import type {
	AntigravityAuthState,
	AntigravityInstallProgress,
	AntigravityRuntimeSource,
	AntigravityStatus,
} from "../../core/contracts/antigravity.ts";
import {
	ANTIGRAVITY_INIT_PROBE_TIMEOUT_MS,
	ANTIGRAVITY_MINIMUM_CLI_VERSION,
	ANTIGRAVITY_VERSION_TIMEOUT_MS,
} from "./constants.ts";
import { buildAntigravityEnvironment, touchAntigravityKeyringUnavailable } from "./profile.ts";
import { getAntigravityRelease, type AntigravityReleaseManifestEntry } from "./release.ts";

export type AntigravityRuntimeKind = "acp-server" | "cli";

export interface ResolvedAntigravityRuntime {
	source: AntigravityRuntimeSource;
	kind: AntigravityRuntimeKind;
	executablePath: string;
	harnessPath?: string;
	args: string[];
	version: string | null;
}

export interface AntigravityResolutionResult {
	runtime: ResolvedAntigravityRuntime | null;
	managedInstalled: boolean;
	updateRequiredVersion: string | null;
	error: string | null;
}

export type ReadAntigravityVersion = (binary: string) => Promise<string>;
export type ValidateAntigravityRuntime = (runtime: ResolvedAntigravityRuntime) => Promise<{ version: string | null }>;

export interface ResolveAntigravityOptions {
	binaryPath?: string;
	env?: Record<string, string | undefined>;
	platform?: NodeJS.Platform;
	arch?: string;
	homeDir?: string;
	dataDir?: string;
	cwd?: string;
	isExecutable?: (filePath: string) => boolean;
	fileExists?: (filePath: string) => boolean;
	readFileText?: (filePath: string) => string;
	statSize?: (filePath: string) => number | null;
	readVersion?: ReadAntigravityVersion;
}

interface InstallCompleteMarker {
	releaseId: string;
	version?: string;
	executable: { name: string; bytes?: number };
	harness?: { name: string; bytes?: number };
}

interface ActiveMarker {
	releaseId: string;
}

function defaultIsExecutable(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function defaultFileExists(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function defaultReadFileText(filePath: string): string {
	return fs.readFileSync(filePath, "utf8");
}

function defaultStatSize(filePath: string): number | null {
	try {
		const stat = fs.statSync(filePath);
		return stat.isFile() ? stat.size : null;
	} catch {
		return null;
	}
}

const cliVersionCache = new Map<string, string | null>();

function cliCacheKey(binary: string): string | null {
	try {
		const stat = fs.statSync(binary);
		return stat.isFile() ? `${binary}:${stat.mtimeMs}:${stat.size}` : null;
	} catch {
		return null;
	}
}

function recordCliVersionCache(binary: string, parsed: string | null): void {
	const key = cliCacheKey(binary);
	if (key) cliVersionCache.set(key, parsed);
}

function readCliVersionSyncCached(binary: string): string | null {
	const key = cliCacheKey(binary);
	if (key && cliVersionCache.has(key)) {
		return cliVersionCache.get(key) ?? null;
	}
	let parsed: string | null = null;
	try {
		const stdout = execFileSync(binary, ["--version"], {
			cwd: os.tmpdir(),
			env: externalCliEnv(),
			windowsHide: true,
			timeout: 1_500,
			killSignal: "SIGKILL",
			maxBuffer: 4_096,
			encoding: "utf8",
		});
		parsed = parseAntigravityCliVersion(stdout);
	} catch {
		parsed = null;
	}
	if (key) cliVersionCache.set(key, parsed);
	return parsed;
}

export const readAntigravityCliVersion: ReadAntigravityVersion = (binary) =>
	new Promise((resolve, reject) => {
		execFile(
			binary,
			["--version"],
			{
				cwd: os.tmpdir(),
				env: externalCliEnv(),
				windowsHide: true,
				timeout: ANTIGRAVITY_VERSION_TIMEOUT_MS,
				killSignal: "SIGKILL",
				maxBuffer: 4_096,
			},
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		);
	});

export function parseAntigravityCliVersion(output: string): string | null {
	const firstLine = output.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
	const match = /^(?:(?:agy|antigravity)\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+.\s].*)?$/i.exec(firstLine);
	if (!match) return null;
	const parts = match.slice(1).map(Number);
	if (!parts.every(Number.isSafeInteger)) return null;
	return parts.join(".");
}

export function compareSemver(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const av = pa[i] ?? 0;
		const bv = pb[i] ?? 0;
		if (av !== bv) return av > bv ? 1 : -1;
	}
	return 0;
}

function resolveDataDir(dataDir?: string, env: Record<string, string | undefined> = process.env): string {
	if (dataDir) return path.resolve(dataDir);
	if (env.LH_DATA_DIR) return path.resolve(env.LH_DATA_DIR);
	return PATHS.data;
}

export function managedRuntimeRoot(
	dataDir?: string,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	env: Record<string, string | undefined> = process.env,
): string {
	return path.join(resolveDataDir(dataDir, env), "antigravity", "runtime", `${platform}-${arch}`);
}

export function t3ExternalRuntimeRoot(
	homeDir: string = os.homedir(),
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string {
	return path.join(homeDir, ".t3", "tools", "antigravity-acp", `${platform}-${arch}`);
}

function expandHome(inputPath: string, homeDir: string): string {
	if (inputPath === "~") return homeDir;
	if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
		return path.join(homeDir, inputPath.slice(2));
	}
	return inputPath;
}

function pathModuleFor(platform: NodeJS.Platform): path.PlatformPath {
	return platform === "win32" ? path.win32 : path.posix;
}

function isSafeMarkerSegment(segment: unknown): segment is string {
	return (
		typeof segment === "string" &&
		segment.length > 0 &&
		!segment.includes("\0") &&
		!segment.includes("/") &&
		!segment.includes("\\") &&
		segment !== "." &&
		segment !== ".."
	);
}

function buildCustomRuntime(
	executablePath: string,
	source: "env" | "custom",
	platform: NodeJS.Platform,
	isExecutable: (filePath: string) => boolean,
): ResolvedAntigravityRuntime {
	const paths = pathModuleFor(platform);
	const base = paths.basename(executablePath).toLowerCase();
	if (base === "agy" || base === "agy.exe" || base === "antigravity" || base === "antigravity.exe") {
		return {
			source,
			kind: "cli",
			executablePath,
			args: ["acp"],
			version: null,
		};
	}
	const dir = paths.dirname(executablePath);
	const harnessName = platform === "win32" ? "localharness_external.exe" : "localharness_external";
	const candidateHarness = paths.join(dir, harnessName);
	const harnessPath = isExecutable(candidateHarness) ? candidateHarness : undefined;
	const isAgyServer = base.startsWith("agy_acp_server");
	return {
		source,
		kind: "acp-server",
		executablePath,
		...(harnessPath ? { harnessPath } : {}),
		args: isAgyServer && platform === "linux" ? ["--uid="] : [],
		version: null,
	};
}

function readInstalledMarkerRuntime(
	root: string,
	source: "managed" | "t3-external",
	platform: NodeJS.Platform,
	isExecutable: (filePath: string) => boolean,
	fileExists: (filePath: string) => boolean,
	readFileText: (filePath: string) => string,
	statSize: (filePath: string) => number | null,
): ResolvedAntigravityRuntime | null {
	const paths = pathModuleFor(platform);
	const activePath = paths.join(root, "active.json");
	if (!fileExists(activePath)) return null;

	let active: ActiveMarker;
	try {
		active = JSON.parse(readFileText(activePath)) as ActiveMarker;
	} catch {
		return null;
	}
	if (!isSafeMarkerSegment(active?.releaseId)) return null;

	const versionDir = paths.join(root, "versions", active.releaseId);
	const markerPath = paths.join(versionDir, ".install-complete.json");
	if (!fileExists(markerPath)) return null;

	let marker: InstallCompleteMarker;
	try {
		marker = JSON.parse(readFileText(markerPath)) as InstallCompleteMarker;
	} catch {
		return null;
	}
	if (marker?.releaseId !== active.releaseId || !isSafeMarkerSegment(marker.executable?.name)) return null;

	const execPath = paths.join(versionDir, marker.executable.name);
	if (!isExecutable(execPath)) return null;
	if (typeof marker.executable.bytes === "number") {
		const actual = statSize(execPath);
		if (actual !== marker.executable.bytes) return null;
	}

	let harnessPath: string | undefined;
	if (marker.harness !== undefined) {
		if (!isSafeMarkerSegment(marker.harness.name)) return null;
		const candidateHarness = paths.join(versionDir, marker.harness.name);
		if (!isExecutable(candidateHarness)) return null;
		if (typeof marker.harness.bytes === "number") {
			const actual = statSize(candidateHarness);
			if (actual !== marker.harness.bytes) return null;
		}
		harnessPath = candidateHarness;
	}

	return {
		source,
		kind: "acp-server",
		executablePath: execPath,
		...(harnessPath ? { harnessPath } : {}),
		args: platform === "linux" ? ["--uid="] : [],
		version: typeof marker.version === "string" ? marker.version : null,
	};
}

function getCliCandidates(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform,
	homeDir: string,
	cwd: string,
	isExecutable: (filePath: string) => boolean,
): string[] {
	const paths = pathModuleFor(platform);
	const names = platform === "win32" ? ["agy.exe", "antigravity.exe"] : ["agy", "antigravity"];
	const knownDirs =
		platform === "win32"
			? [
					paths.join(homeDir, ".local", "bin"),
					paths.join(env.LOCALAPPDATA ?? paths.join(homeDir, "AppData", "Local"), "Programs", "Antigravity", "bin"),
				]
			: [
					paths.join(homeDir, ".local", "bin"),
					"/opt/homebrew/bin",
					"/usr/local/bin",
					...(env.USER ? [paths.join("/etc/profiles/per-user", env.USER, "bin")] : []),
					paths.join(homeDir, ".nix-profile", "bin"),
					"/run/current-system/sw/bin",
				];
	const pathDirs = (env.PATH ?? "").split(paths.delimiter).filter(Boolean);
	const seen = new Set<string>();
	const found: string[] = [];
	for (const name of names) {
		for (const dir of [...pathDirs, ...knownDirs]) {
			const candidate = paths.resolve(cwd, dir, name);
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			if (isExecutable(candidate)) found.push(candidate);
		}
	}
	return found;
}

async function resolveCustomCliVersion(
	runtime: ResolvedAntigravityRuntime,
	readVersion: ReadAntigravityVersion,
	cacheResult: boolean,
): Promise<ResolvedAntigravityRuntime> {
	if (runtime.kind !== "cli") return runtime;
	try {
		const output = await readVersion(runtime.executablePath);
		const parsed = parseAntigravityCliVersion(output);
		if (cacheResult) recordCliVersionCache(runtime.executablePath, parsed);
		return { ...runtime, version: parsed };
	} catch {
		if (cacheResult) recordCliVersionCache(runtime.executablePath, null);
		return runtime;
	}
}

/** Strict runtime resolution precedence:
 *  1. LH_ANTIGRAVITY_BIN env override
 *  2. Settings binaryPath
 *  3. LearnHarness-managed install under LH_DATA_DIR
 *  4. agy / antigravity CLI on PATH (>= 1.5.0)
 *  5. Read-only T3 Code fallback under ~/.t3/tools/antigravity-acp
 */
export async function resolveAntigravityRuntime(
	options: ResolveAntigravityOptions = {},
): Promise<AntigravityResolutionResult> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const homeDir = options.homeDir ?? os.homedir();
	const cwd = options.cwd ?? process.cwd();
	const isExecutable = options.isExecutable ?? defaultIsExecutable;
	const fileExists = options.fileExists ?? defaultFileExists;
	const readFileText = options.readFileText ?? defaultReadFileText;
	const statSize = options.statSize ?? defaultStatSize;
	const readVersion = options.readVersion ?? readAntigravityCliVersion;
	const paths = pathModuleFor(platform);

	const managedRoot = managedRuntimeRoot(options.dataDir, platform, arch, env);
	const managedRuntime = readInstalledMarkerRuntime(
		managedRoot,
		"managed",
		platform,
		isExecutable,
		fileExists,
		readFileText,
		statSize,
	);
	const managedInstalled = managedRuntime !== null;

	// 1. LH_ANTIGRAVITY_BIN override
	const envBin = env.LH_ANTIGRAVITY_BIN?.trim();
	if (envBin) {
		const resolved = paths.resolve(cwd, expandHome(envBin, homeDir));
		if (!isExecutable(resolved)) {
			return {
				runtime: null,
				managedInstalled,
				updateRequiredVersion: null,
				error: "Configured LH_ANTIGRAVITY_BIN path was not found or is not executable.",
			};
		}
		const baseRuntime = buildCustomRuntime(resolved, "env", platform, isExecutable);
		return {
			runtime: await resolveCustomCliVersion(baseRuntime, readVersion, !options.readVersion),
			managedInstalled,
			updateRequiredVersion: null,
			error: null,
		};
	}

	// 2. Settings binaryPath override
	const customBin = options.binaryPath?.trim();
	if (customBin) {
		const resolved = paths.resolve(cwd, expandHome(customBin, homeDir));
		if (!isExecutable(resolved)) {
			return {
				runtime: null,
				managedInstalled,
				updateRequiredVersion: null,
				error: "Configured custom binary path was not found or is not executable.",
			};
		}
		const baseRuntime = buildCustomRuntime(resolved, "custom", platform, isExecutable);
		return {
			runtime: await resolveCustomCliVersion(baseRuntime, readVersion, !options.readVersion),
			managedInstalled,
			updateRequiredVersion: null,
			error: null,
		};
	}

	// 3. LearnHarness-managed install under LH_DATA_DIR
	if (managedRuntime) {
		return {
			runtime: managedRuntime,
			managedInstalled: true,
			updateRequiredVersion: null,
			error: null,
		};
	}

	// 4. agy / antigravity on PATH (>= 1.5.0)
	let updateRequiredVersion: string | null = null;
	for (const candidate of getCliCandidates(env, platform, homeDir, cwd, isExecutable)) {
		try {
			const output = await readVersion(candidate);
			const parsed = parseAntigravityCliVersion(output);
			if (!options.readVersion) recordCliVersionCache(candidate, parsed);
			if (!parsed) continue;
			if (compareSemver(parsed, ANTIGRAVITY_MINIMUM_CLI_VERSION) >= 0) {
				return {
					runtime: {
						source: "cli",
						kind: "cli",
						executablePath: candidate,
						args: ["acp"],
						version: parsed,
					},
					managedInstalled: false,
					updateRequiredVersion: null,
					error: null,
				};
			}
			updateRequiredVersion ??= parsed;
		} catch {
			if (!options.readVersion) recordCliVersionCache(candidate, null);
		}
	}

	// 5. Read-only T3 Code fallback
	const t3Root = t3ExternalRuntimeRoot(homeDir, platform, arch);
	const t3Runtime = readInstalledMarkerRuntime(
		t3Root,
		"t3-external",
		platform,
		isExecutable,
		fileExists,
		readFileText,
		statSize,
	);
	if (t3Runtime) {
		return {
			runtime: t3Runtime,
			managedInstalled: false,
			updateRequiredVersion: null,
			error: null,
		};
	}

	return {
		runtime: null,
		managedInstalled: false,
		updateRequiredVersion,
		error: null,
	};
}

/** Synchronous runtime resolution for catalog availability checks (no ACP spawning). */
export function resolveAntigravityRuntimeSync(
	options: Omit<ResolveAntigravityOptions, "readVersion"> = {},
): ResolvedAntigravityRuntime | null {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const homeDir = options.homeDir ?? os.homedir();
	const cwd = options.cwd ?? process.cwd();
	const isExecutable = options.isExecutable ?? defaultIsExecutable;
	const fileExists = options.fileExists ?? defaultFileExists;
	const readFileText = options.readFileText ?? defaultReadFileText;
	const statSize = options.statSize ?? defaultStatSize;
	const paths = pathModuleFor(platform);

	// 1. LH_ANTIGRAVITY_BIN override
	const envBin = env.LH_ANTIGRAVITY_BIN?.trim();
	if (envBin) {
		const resolved = paths.resolve(cwd, expandHome(envBin, homeDir));
		if (!isExecutable(resolved)) return null;
		const rt = buildCustomRuntime(resolved, "env", platform, isExecutable);
		return rt.kind === "cli" ? { ...rt, version: readCliVersionSyncCached(resolved) } : rt;
	}

	// 2. Settings binaryPath override
	const customBin = options.binaryPath?.trim();
	if (customBin) {
		const resolved = paths.resolve(cwd, expandHome(customBin, homeDir));
		if (!isExecutable(resolved)) return null;
		const rt = buildCustomRuntime(resolved, "custom", platform, isExecutable);
		return rt.kind === "cli" ? { ...rt, version: readCliVersionSyncCached(resolved) } : rt;
	}

	// 3. LearnHarness-managed install under LH_DATA_DIR
	const managedRoot = managedRuntimeRoot(options.dataDir, platform, arch, env);
	const managedRuntime = readInstalledMarkerRuntime(
		managedRoot,
		"managed",
		platform,
		isExecutable,
		fileExists,
		readFileText,
		statSize,
	);
	if (managedRuntime) return managedRuntime;

	// 4. agy / antigravity on PATH (>= 1.5.0)
	for (const candidate of getCliCandidates(env, platform, homeDir, cwd, isExecutable)) {
		const parsed = readCliVersionSyncCached(candidate);
		if (!parsed) continue;
		if (compareSemver(parsed, ANTIGRAVITY_MINIMUM_CLI_VERSION) >= 0) {
			return {
				source: "cli",
				kind: "cli",
				executablePath: candidate,
				args: ["acp"],
				version: parsed,
			};
		}
	}

	// 5. Read-only T3 Code fallback
	const t3Root = t3ExternalRuntimeRoot(homeDir, platform, arch);
	return readInstalledMarkerRuntime(
		t3Root,
		"t3-external",
		platform,
		isExecutable,
		fileExists,
		readFileText,
		statSize,
	);
}

/** Rejects absolute paths, drive letters, NUL bytes, `..` traversal, symlinks,
 *  and any path escaping `destDir`. */
export function assertSafeZipEntryPath(fileName: string, destDir: string): string {
	if (!fileName || fileName.includes("\0")) {
		throw new Error(`Unsafe zip entry name: ${JSON.stringify(fileName)}`);
	}
	if (fileName.startsWith("/") || fileName.startsWith("\\") || /^[a-zA-Z]:/.test(fileName)) {
		throw new Error(`Unsafe absolute zip entry path: ${fileName}`);
	}
	const segments = fileName.split(/[/\\]/);
	if (segments.some((seg) => seg === "..")) {
		throw new Error(`Unsafe zip-slip traversal entry: ${fileName}`);
	}
	const resolvedDest = path.resolve(destDir);
	const resolvedTarget = path.resolve(resolvedDest, fileName);
	if (resolvedTarget !== resolvedDest && !resolvedTarget.startsWith(resolvedDest + path.sep)) {
		throw new Error(`Zip entry escapes destination directory: ${fileName}`);
	}
	return resolvedTarget;
}

export async function extractZipSafely(zipPath: string, destDir: string): Promise<void> {
	fs.mkdirSync(destDir, { recursive: true });
	await new Promise<void>((resolve, reject) => {
		yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openErr, zipfile) => {
			if (openErr || !zipfile) {
				reject(openErr ?? new Error("Failed to open zip archive."));
				return;
			}
			let settled = false;
			const fail = (err: unknown) => {
				if (settled) return;
				settled = true;
				try {
					zipfile.close();
				} catch {
					// ignore close errors
				}
				reject(err instanceof Error ? err : new Error(String(err)));
			};
			const finish = () => {
				if (settled) return;
				settled = true;
				resolve();
			};

			zipfile.on("error", fail);
			zipfile.on("end", finish);
			zipfile.on("entry", (entry) => {
				try {
					const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
					if (unixType === 0o120000) {
						throw new Error(`Refusing symlink entry in archive: ${entry.fileName}`);
					}
					const targetPath = assertSafeZipEntryPath(entry.fileName, destDir);
					if (entry.fileName.endsWith("/") || entry.fileName.endsWith("\\")) {
						fs.mkdirSync(targetPath, { recursive: true });
						zipfile.readEntry();
						return;
					}
					fs.mkdirSync(path.dirname(targetPath), { recursive: true });
					zipfile.openReadStream(entry, (streamErr, readStream) => {
						if (streamErr || !readStream) {
							fail(streamErr ?? new Error(`Failed to read zip entry ${entry.fileName}`));
							return;
						}
						const writeStream = fs.createWriteStream(targetPath);
						readStream.on("error", fail);
						writeStream.on("error", fail);
						writeStream.on("finish", () => {
							zipfile.readEntry();
						});
						readStream.pipe(writeStream);
					});
				} catch (err) {
					fail(err);
				}
			});
			zipfile.readEntry();
		});
	});
}

export function buildProbeEnvironment(options: {
	baseEnv?: Record<string, string | undefined>;
	geminiHome: string;
	tempDir: string;
	harnessPath?: string;
	platform?: NodeJS.Platform;
	fileExists?: (filePath: string) => boolean;
}): NodeJS.ProcessEnv {
	return buildAntigravityEnvironment(options);
}

/** Appends `--gemini-dir <profileDir> --app-data-dir antigravity-acp` for
 *  `agy` / `antigravity` CLI runtimes, which ignore `GEMINI_HOME`. */
export function antigravityRuntimeArgs(
	runtime: Pick<ResolvedAntigravityRuntime, "kind" | "args">,
	profileDir?: string,
): string[] {
	const args = [...runtime.args];
	if (runtime.kind !== "cli" || !profileDir) {
		return args;
	}
	if (!args.some((arg) => arg === "--gemini-dir" || arg.startsWith("--gemini-dir="))) {
		args.push("--gemini-dir", profileDir);
	}
	if (!args.some((arg) => arg === "--app-data-dir" || arg.startsWith("--app-data-dir="))) {
		args.push("--app-data-dir", "antigravity-acp");
	}
	return args;
}

export async function probeAntigravityInitialize(
	runtime: ResolvedAntigravityRuntime,
	options: {
		timeoutMs?: number;
		spawnProcess?: typeof spawn;
		baseEnv?: Record<string, string | undefined>;
		platform?: NodeJS.Platform;
	} = {},
): Promise<{ version: string | null }> {
	const timeoutMs = options.timeoutMs ?? ANTIGRAVITY_INIT_PROBE_TIMEOUT_MS;
	const spawnProcess = options.spawnProcess ?? spawn;
	const platform = options.platform ?? process.platform;

	const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-init-"));
	const cwd = path.join(probeDir, "cwd");
	const geminiHome = path.join(probeDir, "gemini-home");
	const tempDir = path.join(probeDir, "tmp");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(geminiHome, { recursive: true, mode: 0o700 });
	fs.mkdirSync(tempDir, { recursive: true });
	if (runtime.kind === "cli") {
		touchAntigravityKeyringUnavailable(geminiHome, platform);
	}

	const env = buildProbeEnvironment({
		baseEnv: options.baseEnv,
		geminiHome,
		tempDir,
		harnessPath: runtime.harnessPath,
		platform,
	});

	try {
		return await new Promise<{ version: string | null }>((resolve, reject) => {
			const child = spawnProcess(runtime.executablePath, antigravityRuntimeArgs(runtime, geminiHome), {
				cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});

			let settled = false;
			let stderrText = "";
			const rl = child.stdout ? readline.createInterface({ input: child.stdout }) : null;

			const cleanupChild = () => {
				try {
					child.stdin?.end();
				} catch {
					// ignore
				}
				const killTimer = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) {
						try {
							child.kill("SIGKILL");
						} catch {
							// ignore
						}
					}
				}, 1_000);
				killTimer.unref();
			};

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				rl?.close();
				cleanupChild();
				reject(new Error(`Antigravity ACP initialize probe timed out after ${timeoutMs}ms.`));
			}, timeoutMs);
			timer.unref();

			const fail = (err: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				rl?.close();
				cleanupChild();
				reject(err);
			};

			const succeed = (version: string | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				rl?.close();
				cleanupChild();
				resolve({ version });
			};

			child.stderr?.on("data", (chunk: Buffer | string) => {
				if (stderrText.length < 4096) {
					stderrText += chunk.toString();
				}
			});

			child.on("error", (err) => {
				fail(new Error(`Failed to spawn Antigravity runtime: ${err.message}`));
			});

			child.on("close", (code) => {
				if (!settled) {
					const suffix = stderrText.trim() ? `: ${stderrText.trim().slice(0, 300)}` : "";
					fail(new Error(`Antigravity runtime exited before initialize response (code ${code ?? "null"})${suffix}`));
				}
			});

			rl?.on("line", (line) => {
				const trimmed = line.trim();
				if (!trimmed) return;
				let parsed: unknown;
				try {
					parsed = JSON.parse(trimmed);
				} catch {
					return;
				}
				if (!parsed || typeof parsed !== "object") return;
				const msg = parsed as {
					id?: unknown;
					error?: { message?: unknown };
					result?: {
						agentInfo?: { name?: unknown; version?: unknown };
					};
				};
				if (msg.id !== 1) return;
				if (msg.error) {
					const reason = typeof msg.error.message === "string" ? msg.error.message : "unknown ACP error";
					fail(new Error(`Antigravity initialize returned error: ${reason}`));
					return;
				}
				const agentName = msg.result?.agentInfo?.name;
				if (agentName !== "antigravity-acp" && agentName !== "Antigravity ACP Server") {
					fail(new Error(`Unexpected ACP agentInfo.name: ${String(agentName ?? "missing")}`));
					return;
				}
				const version = typeof msg.result?.agentInfo?.version === "string" ? msg.result.agentInfo.version : null;
				succeed(version);
			});

			const request = JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: 1,
					clientInfo: { name: "learnharness", version: packageMetadata.version },
					clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				},
			});
			child.stdin?.write(`${request}\n`, (err) => {
				if (err) fail(new Error(`Failed writing initialize request: ${err.message}`));
			});
		});
	} finally {
		fs.rmSync(probeDir, { recursive: true, force: true });
	}
}

export interface InstallManagedOptions {
	dataDir?: string;
	platform?: NodeJS.Platform;
	arch?: string;
	manifestEntry?: AntigravityReleaseManifestEntry;
	fetchFn?: typeof fetch;
	signal?: AbortSignal;
	validateRuntime?: ValidateAntigravityRuntime;
	onProgress?: (progress: AntigravityInstallProgress) => void;
	env?: Record<string, string | undefined>;
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
	fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: "utf8", mode: 0o644 });
	fs.renameSync(tmp, filePath);
}

export async function installManagedAntigravityRuntime(
	options: InstallManagedOptions = {},
): Promise<{ runtime: ResolvedAntigravityRuntime; version: string }> {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const env = options.env ?? process.env;
	const entry = options.manifestEntry ?? getAntigravityRelease(platform, arch);
	if (!entry) {
		throw new Error(`No managed Antigravity runtime release is available for ${platform}-${arch}.`);
	}

	const fetchFn = options.fetchFn ?? globalThis.fetch;
	const validateRuntime =
		options.validateRuntime ?? ((rt) => probeAntigravityInitialize(rt, { platform, baseEnv: env }));
	const root = managedRuntimeRoot(options.dataDir, platform, arch, env);
	const stagingDir = path.join(root, `staging-${randomUUID()}`);
	const zipPath = path.join(stagingDir, "archive.zip");
	const extractDir = path.join(stagingDir, "extracted");

	fs.mkdirSync(extractDir, { recursive: true });

	try {
		options.onProgress?.({ phase: "downloading", downloadedBytes: 0, totalBytes: entry.archiveBytes });

		const response = await fetchFn(entry.url, { signal: options.signal });
		if (!response.ok) {
			throw new Error(`Download failed with HTTP ${response.status}`);
		}

		const hash = createHash("sha256");
		let downloadedBytes = 0;

		if (response.body) {
			const writeStream = fs.createWriteStream(zipPath);
			const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
			nodeStream.on("data", (chunk: Buffer) => {
				downloadedBytes += chunk.byteLength;
				if (downloadedBytes > entry.archiveBytes) {
					nodeStream.destroy(
						new Error(`Downloaded archive exceeds expected size (${downloadedBytes} > ${entry.archiveBytes} bytes).`),
					);
					return;
				}
				hash.update(chunk);
				options.onProgress?.({
					phase: "downloading",
					downloadedBytes,
					totalBytes: entry.archiveBytes,
				});
			});
			await pipeline(nodeStream, writeStream);
		} else {
			const buf = Buffer.from(await response.arrayBuffer());
			downloadedBytes = buf.byteLength;
			if (downloadedBytes > entry.archiveBytes) {
				throw new Error(`Downloaded archive exceeds expected size (${downloadedBytes} > ${entry.archiveBytes} bytes).`);
			}
			hash.update(buf);
			fs.writeFileSync(zipPath, buf);
			options.onProgress?.({
				phase: "downloading",
				downloadedBytes,
				totalBytes: entry.archiveBytes,
			});
		}

		options.onProgress?.({
			phase: "verifying",
			downloadedBytes,
			totalBytes: entry.archiveBytes,
		});

		if (downloadedBytes !== entry.archiveBytes) {
			throw new Error(`Archive size mismatch: expected ${entry.archiveBytes} bytes, got ${downloadedBytes}.`);
		}

		const actualSha256 = hash.digest("hex");
		if (actualSha256 !== entry.sha256) {
			throw new Error(`Archive SHA-256 mismatch: expected ${entry.sha256}, got ${actualSha256}.`);
		}

		options.onProgress?.({ phase: "extracting" });
		await extractZipSafely(zipPath, extractDir);
		fs.rmSync(zipPath, { force: true });

		options.onProgress?.({ phase: "verifying" });
		const stagedExecPath = path.join(extractDir, entry.executable.name);
		const stagedHarnessPath = path.join(extractDir, entry.harness.name);

		const execStat = defaultStatSize(stagedExecPath);
		if (execStat === null) {
			throw new Error(`Extracted archive missing executable ${entry.executable.name}.`);
		}
		if (execStat !== entry.executable.bytes) {
			throw new Error(
				`Extracted executable size mismatch for ${entry.executable.name}: expected ${entry.executable.bytes} bytes, got ${execStat}.`,
			);
		}

		const harnessStat = defaultStatSize(stagedHarnessPath);
		if (harnessStat === null) {
			throw new Error(`Extracted archive missing harness ${entry.harness.name}.`);
		}
		if (harnessStat !== entry.harness.bytes) {
			throw new Error(
				`Extracted harness size mismatch for ${entry.harness.name}: expected ${entry.harness.bytes} bytes, got ${harnessStat}.`,
			);
		}

		if (platform !== "win32") {
			fs.chmodSync(stagedExecPath, 0o755);
			fs.chmodSync(stagedHarnessPath, 0o755);
		}

		const stagedRuntime: ResolvedAntigravityRuntime = {
			source: "managed",
			kind: "acp-server",
			executablePath: stagedExecPath,
			harnessPath: stagedHarnessPath,
			args: platform === "linux" ? ["--uid="] : [],
			version: entry.version,
		};

		options.onProgress?.({ phase: "validating" });
		const probeResult = await validateRuntime(stagedRuntime);
		const resolvedVersion = probeResult.version ?? entry.version;

		const versionsDir = path.join(root, "versions");
		const finalVersionDir = path.join(versionsDir, entry.releaseId);
		fs.mkdirSync(versionsDir, { recursive: true });
		if (fs.existsSync(finalVersionDir)) {
			fs.rmSync(finalVersionDir, { recursive: true, force: true });
		}
		fs.renameSync(extractDir, finalVersionDir);

		const finalExecPath = path.join(finalVersionDir, entry.executable.name);
		const finalHarnessPath = path.join(finalVersionDir, entry.harness.name);
		const marker: InstallCompleteMarker = {
			releaseId: entry.releaseId,
			version: resolvedVersion,
			executable: entry.executable,
			harness: entry.harness,
		};
		writeJsonAtomic(path.join(finalVersionDir, ".install-complete.json"), marker);
		writeJsonAtomic(path.join(root, "active.json"), { releaseId: entry.releaseId } satisfies ActiveMarker);

		const finalRuntime: ResolvedAntigravityRuntime = {
			source: "managed",
			kind: "acp-server",
			executablePath: finalExecPath,
			harnessPath: finalHarnessPath,
			args: platform === "linux" ? ["--uid="] : [],
			version: resolvedVersion,
		};
		options.onProgress?.({ phase: "installed" });
		return { runtime: finalRuntime, version: resolvedVersion };
	} finally {
		fs.rmSync(stagingDir, { recursive: true, force: true });
	}
}

/** Removes ONLY LearnHarness-managed runtime files under LH_DATA_DIR.
 *  Never touches T3 Code, system CLI, or custom binary paths. */
export function removeManagedAntigravityRuntime(
	options: {
		dataDir?: string;
		platform?: NodeJS.Platform;
		arch?: string;
		env?: Record<string, string | undefined>;
	} = {},
): { removed: boolean } {
	const root = managedRuntimeRoot(options.dataDir, options.platform, options.arch, options.env);
	if (!fs.existsSync(root)) return { removed: false };
	fs.rmSync(root, { recursive: true, force: true });
	return { removed: true };
}

export interface InstallerManagerDeps {
	resolveRuntime?: (binaryPath?: string) => Promise<AntigravityResolutionResult>;
	installManaged?: (onProgress: (p: AntigravityInstallProgress) => void, signal: AbortSignal) => Promise<void>;
	removeManaged?: () => { removed: boolean };
}

export function createAntigravityInstallerManager(deps: InstallerManagerDeps = {}) {
	const resolveRuntime = deps.resolveRuntime ?? ((binaryPath?: string) => resolveAntigravityRuntime({ binaryPath }));
	const installManaged =
		deps.installManaged ??
		(async (onProgress, signal) => {
			await installManagedAntigravityRuntime({ onProgress, signal });
		});
	const removeManaged = deps.removeManaged ?? (() => removeManagedAntigravityRuntime());

	let installProgress: AntigravityInstallProgress = { phase: "idle" };
	let activeController: AbortController | null = null;
	let activeInstall: Promise<void> | null = null;

	const isBusy = () => activeInstall !== null;

	const IDLE_AUTH: AntigravityAuthState = {
		signedIn: false,
		phase: "idle",
		attemptId: null,
		authUrl: null,
		error: null,
	};

	async function getStatus(options: {
		enabled: boolean;
		binaryPath?: string | null;
		auth?: AntigravityAuthState;
	}): Promise<AntigravityStatus> {
		const auth = options.auth ?? { ...IDLE_AUTH };
		if (!options.enabled) {
			return {
				enabled: false,
				binaryPath: options.binaryPath ?? null,
				state: "not-installed",
				source: null,
				version: null,
				minimumCliVersion: ANTIGRAVITY_MINIMUM_CLI_VERSION,
				managedInstalled: false,
				busy: false,
				install: { phase: "idle" },
				auth: { ...IDLE_AUTH },
				error: null,
			};
		}

		const resolution = await resolveRuntime(options.binaryPath ?? undefined);
		if (!isBusy() && installProgress.phase === "installed" && !resolution.managedInstalled) {
			installProgress = { phase: "idle" };
		}

		const error =
			installProgress.phase === "error"
				? (installProgress.error ?? resolution.error ?? "Installation failed.")
				: resolution.error;

		let state: AntigravityStatus["state"] = "not-installed";
		if (resolution.runtime) {
			state = "ready";
		} else if (resolution.error || installProgress.phase === "error") {
			state = "error";
		} else if (resolution.updateRequiredVersion) {
			state = "update-required";
		}

		return {
			enabled: true,
			binaryPath: options.binaryPath ?? null,
			state,
			source: resolution.runtime?.source ?? null,
			version: resolution.runtime?.version ?? resolution.updateRequiredVersion ?? null,
			minimumCliVersion: ANTIGRAVITY_MINIMUM_CLI_VERSION,
			managedInstalled: resolution.managedInstalled,
			busy: isBusy(),
			install: { ...installProgress },
			auth,
			error,
		};
	}

	function startInstall(): { started: boolean } {
		if (activeInstall) return { started: false };
		const controller = new AbortController();
		activeController = controller;
		installProgress = { phase: "downloading", downloadedBytes: 0 };

		activeInstall = (async () => {
			try {
				await installManaged((next) => {
					if (!controller.signal.aborted) {
						installProgress = { ...next };
					}
				}, controller.signal);
				if (!controller.signal.aborted) {
					installProgress = { phase: "installed" };
				}
			} catch (err) {
				if (controller.signal.aborted) {
					installProgress = { phase: "idle" };
				} else {
					const message = err instanceof Error ? err.message : "Installation failed.";
					installProgress = { phase: "error", error: message };
				}
			} finally {
				if (activeController === controller) {
					activeController = null;
					activeInstall = null;
				}
			}
		})();

		return { started: true };
	}

	function abortInstall(): void {
		activeController?.abort();
	}

	function remove(): { removed: boolean; conflict?: boolean } {
		if (isBusy()) return { removed: false, conflict: true };
		const result = removeManaged();
		installProgress = { phase: "idle" };
		return result;
	}

	async function waitForIdle(): Promise<void> {
		if (activeInstall) await activeInstall;
	}

	return {
		getStatus,
		startInstall,
		abortInstall,
		remove,
		waitForIdle,
		isBusy,
	};
}
