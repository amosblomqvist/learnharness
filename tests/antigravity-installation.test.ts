import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
	antigravityRuntimeArgs,
	assertSafeZipEntryPath,
	buildProbeEnvironment,
	compareSemver,
	extractZipSafely,
	installManagedAntigravityRuntime,
	managedRuntimeRoot,
	parseAntigravityCliVersion,
	probeAntigravityInitialize,
	removeManagedAntigravityRuntime,
	resolveAntigravityRuntime,
	resolveAntigravityRuntimeSync,
	t3ExternalRuntimeRoot,
} from "../src/agent/antigravity/installation.ts";
import { getAntigravityRelease, type AntigravityReleaseManifestEntry } from "../src/agent/antigravity/release.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(__dirname, "fixtures", "antigravity", "fake-acp.mjs");

function makeTempDir(t: TestContext, prefix = "lh-agy-inst-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function makeExecutable(filePath: string, content = "#!/bin/sh\nexit 0\n"): string {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content, { mode: 0o755 });
	chmodSync(filePath, 0o755);
	return filePath;
}

function writeManagedOrT3Fixture(root: string, opts: { execName?: string; harnessName?: string; version?: string; bytes?: number } = {}) {
	const releaseId = "rel-145";
	const execName = opts.execName ?? "agy_acp_server.par";
	const harnessName = opts.harnessName ?? "localharness_external";
	const versionDir = join(root, "versions", releaseId);
	const execPath = makeExecutable(join(versionDir, execName), "#!/bin/sh\necho exec\n");
	const harnessPath = makeExecutable(join(versionDir, harnessName), "#!/bin/sh\necho harness\n");
	const execBytes = opts.bytes ?? readFileSync(execPath).byteLength;
	const harnessBytes = readFileSync(harnessPath).byteLength;
	writeFileSync(
		join(versionDir, ".install-complete.json"),
		JSON.stringify({
			releaseId,
			version: opts.version ?? "1.4.5",
			executable: { name: execName, bytes: execBytes },
			harness: { name: harnessName, bytes: harnessBytes },
		}),
	);
	writeFileSync(join(root, "active.json"), JSON.stringify({ releaseId }));
	return { execPath, harnessPath, versionDir };
}

/** Minimal stored-entry (method 0) PKZIP builder for deterministic security & integrity tests. */
function crc32(buf: Buffer): number {
	let crc = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		crc ^= buf[i]!;
		for (let j = 0; j < 8; j++) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function buildZipBuffer(
	entries: Array<{ name: string; content?: Buffer | string; externalFileAttributes?: number }>,
): Buffer {
	const localChunks: Buffer[] = [];
	const centralChunks: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, "utf8");
		const data =
			entry.content === undefined
				? Buffer.alloc(0)
				: typeof entry.content === "string"
					? Buffer.from(entry.content, "utf8")
					: entry.content;
		const crc = crc32(data);

		const local = Buffer.alloc(30 + nameBuf.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0x0800, 6); // UTF-8 flag
		local.writeUInt16LE(0, 8); // stored
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		nameBuf.copy(local, 30);

		localChunks.push(local, data);

		const central = Buffer.alloc(46 + nameBuf.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(0x031e, 4); // UNIX + version 3.0
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(0, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE((entry.externalFileAttributes ?? (0o100755 << 16)) >>> 0, 38);
		central.writeUInt32LE(offset, 42);
		nameBuf.copy(central, 46);

		centralChunks.push(central);
		offset += local.length + data.length;
	}

	const centralDir = Buffer.concat(centralChunks);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralDir.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...localChunks, centralDir, eocd]);
}

function sha256Hex(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

function makeFakeManifest(zipBuf: Buffer, execBuf: Buffer, harnessBuf: Buffer): AntigravityReleaseManifestEntry {
	const sha = sha256Hex(zipBuf);
	return {
		platformArch: "linux-x64",
		version: "1.4.5",
		releaseId: sha,
		url: "https://example.invalid/agy-acp-server.zip",
		sha256: sha,
		archiveBytes: zipBuf.byteLength,
		executable: { name: "agy_acp_server.par", bytes: execBuf.byteLength },
		harness: { name: "localharness_external", bytes: harnessBuf.byteLength },
	};
}

test("release manifest covers supported platforms and version parsing/comparison handles semver cleanly", () => {
	for (const [platform, arch] of [
		["linux", "x64"],
		["linux", "arm64"],
		["darwin", "arm64"],
		["darwin", "x64"],
		["win32", "x64"],
		["win32", "arm64"],
	] as const) {
		const entry = getAntigravityRelease(platform, arch);
		assert(entry, `missing release entry for ${platform}-${arch}`);
		assert.equal(entry.version, "1.4.5");
		assert.equal(entry.releaseId, entry.sha256);
	}
	assert.equal(getAntigravityRelease("freebsd", "x64"), null);

	assert.equal(parseAntigravityCliVersion("1.5.0"), "1.5.0");
	assert.equal(parseAntigravityCliVersion("agy 1.5.2 (abcdef)"), "1.5.2");
	assert.equal(parseAntigravityCliVersion("antigravity v1.6.0-beta.1\nextra"), "1.6.0");
	assert.equal(parseAntigravityCliVersion("invalid version output"), null);

	assert.equal(compareSemver("1.5.0", "1.5.0"), 0);
	assert.equal(compareSemver("1.5.1", "1.5.0"), 1);
	assert.equal(compareSemver("1.4.9", "1.5.0"), -1);
	assert.equal(compareSemver("2.0.0", "1.9.9"), 1);
});

test("runtime resolution strictly follows LH_ANTIGRAVITY_BIN > binaryPath > managed > CLI >= 1.5.0 > T3 fallback", async (t) => {
	const root = makeTempDir(t);
	const dataDir = join(root, "data");
	const homeDir = join(root, "home");
	const binDir = join(root, "path-bin");

	const envBin = makeExecutable(join(root, "env-agy_acp_server"));
	const customBin = makeExecutable(join(root, "custom-agy_acp_server"));
	const cliBin = makeExecutable(join(binDir, "agy"));
	const managedRoot = managedRuntimeRoot(dataDir, "linux", "x64");
	const managed = writeManagedOrT3Fixture(managedRoot, { version: "1.4.5" });
	const t3Root = t3ExternalRuntimeRoot(homeDir, "linux", "x64");
	const t3 = writeManagedOrT3Fixture(t3Root, { version: "1.4.5" });

	const baseOpts = {
		platform: "linux" as const,
		arch: "x64",
		dataDir,
		homeDir,
		cwd: root,
		readVersion: async () => "1.5.2",
	};

	// 1. LH_ANTIGRAVITY_BIN wins over everything
	const r1 = await resolveAntigravityRuntime({
		...baseOpts,
		binaryPath: customBin,
		env: { LH_ANTIGRAVITY_BIN: envBin, PATH: binDir },
	});
	assert.equal(r1.runtime?.source, "env");
	assert.equal(r1.runtime?.executablePath, envBin);
	assert.equal(r1.managedInstalled, true);

	// 2. Settings binaryPath wins over managed, CLI, T3
	const r2 = await resolveAntigravityRuntime({
		...baseOpts,
		binaryPath: customBin,
		env: { PATH: binDir },
	});
	assert.equal(r2.runtime?.source, "custom");
	assert.equal(r2.runtime?.executablePath, customBin);

	// 3. LearnHarness-managed wins over CLI and T3
	const r3 = await resolveAntigravityRuntime({
		...baseOpts,
		env: { PATH: binDir },
	});
	assert.equal(r3.runtime?.source, "managed");
	assert.equal(r3.runtime?.executablePath, managed.execPath);
	assert.equal(r3.runtime?.harnessPath, managed.harnessPath);
	assert.deepEqual(r3.runtime?.args, ["--uid="]);

	// Remove managed -> 4. System CLI >= 1.5.0 wins over T3
	removeManagedAntigravityRuntime({ dataDir, platform: "linux", arch: "x64" });
	const r4 = await resolveAntigravityRuntime({
		...baseOpts,
		env: { PATH: binDir },
	});
	assert.equal(r4.runtime?.source, "cli");
	assert.equal(r4.runtime?.kind, "cli");
	assert.equal(r4.runtime?.executablePath, cliBin);
	assert.deepEqual(r4.runtime?.args, ["acp"]);
	assert.equal(r4.runtime?.version, "1.5.2");
	assert.equal(r4.managedInstalled, false);

	// Outdated CLI (< 1.5.0) falls through to 5. T3 read-only fallback
	const r5 = await resolveAntigravityRuntime({
		...baseOpts,
		env: { PATH: binDir },
		readVersion: async () => "1.4.9",
	});
	assert.equal(r5.runtime?.source, "t3-external");
	assert.equal(r5.runtime?.executablePath, t3.execPath);
	assert.equal(r5.managedInstalled, false);

	// Remove T3 fixture -> outdated CLI reports updateRequiredVersion
	rmSync(t3Root, { recursive: true, force: true });
	const r6 = await resolveAntigravityRuntime({
		...baseOpts,
		env: { PATH: binDir },
		readVersion: async () => "1.4.9",
	});
	assert.equal(r6.runtime, null);
	assert.equal(r6.updateRequiredVersion, "1.4.9");
});

test("invalid LH_ANTIGRAVITY_BIN or custom binaryPath returns an explicit error instead of silently falling back", async (t) => {
	const root = makeTempDir(t);
	const dataDir = join(root, "data");
	const managedRoot = managedRuntimeRoot(dataDir, "linux", "x64");
	writeManagedOrT3Fixture(managedRoot);

	const envErr = await resolveAntigravityRuntime({
		platform: "linux",
		arch: "x64",
		dataDir,
		homeDir: root,
		env: { LH_ANTIGRAVITY_BIN: join(root, "does-not-exist"), PATH: "" },
	});
	assert.equal(envErr.runtime, null);
	assert.equal(envErr.managedInstalled, true);
	assert.match(envErr.error ?? "", /LH_ANTIGRAVITY_BIN/);

	const customErr = await resolveAntigravityRuntime({
		platform: "linux",
		arch: "x64",
		dataDir,
		homeDir: root,
		binaryPath: join(root, "missing-custom-bin"),
		env: { PATH: "" },
	});
	assert.equal(customErr.runtime, null);
	assert.equal(customErr.managedInstalled, true);
	assert.match(customErr.error ?? "", /custom binary path/);
});

test("extractZipSafely rejects zip-slip traversal, absolute paths, drive prefixes, and symlinks", async (t) => {
	const root = makeTempDir(t);
	const evilNames = ["../evil.txt", "sub/../../evil.txt", "sub\\..\\..\\evil.txt", "/etc/passwd", "C:\\evil.exe"];

	for (const name of evilNames) {
		assert.throws(() => assertSafeZipEntryPath(name, join(root, "dest")), /Unsafe|escapes/);
		const zipPath = join(root, `evil-${Math.random().toString(16).slice(2)}.zip`);
		const destDir = join(root, `dest-${Math.random().toString(16).slice(2)}`);
		writeFileSync(zipPath, buildZipBuffer([{ name, content: "pwned" }]));
		await assert.rejects(
			extractZipSafely(zipPath, destDir),
			/Unsafe|escapes|invalid relative path|absolute path/i,
		);
		assert.equal(existsSync(join(root, "evil.txt")), false);
	}

	// Symlink unix mode (0120000 << 16)
	const symlinkZip = join(root, "symlink.zip");
	writeFileSync(
		symlinkZip,
		buildZipBuffer([{ name: "link", content: "/etc/passwd", externalFileAttributes: 0o120777 << 16 }]),
	);
	await assert.rejects(extractZipSafely(symlinkZip, join(root, "dest-symlink")), /symlink/);
});

test("buildProbeEnvironment strips ambient Google/Gemini keys and sets isolated GEMINI_HOME & harness env", () => {
	const env = buildProbeEnvironment({
		baseEnv: {
			PATH: "/usr/bin",
			GEMINI_API_KEY: "secret-gemini",
			GOOGLE_API_KEY: "secret-google",
			GOOGLE_APPLICATION_CREDENTIALS: "/tmp/creds.json",
			GOOGLE_CLOUD_PROJECT: "my-proj",
			GOOGLE_GENAI_USE_VERTEXAI: "true",
		},
		geminiHome: "/tmp/lh-gemini-home",
		tempDir: "/tmp/lh-tmp",
		harnessPath: "/opt/harness/localharness_external",
	});
	assert.equal(env.GEMINI_API_KEY, undefined);
	assert.equal(env.GOOGLE_API_KEY, undefined);
	assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
	assert.equal(env.GOOGLE_CLOUD_PROJECT, undefined);
	assert.equal(env.GOOGLE_GENAI_USE_VERTEXAI, undefined);
	assert.equal(env.GEMINI_HOME, "/tmp/lh-gemini-home");
	assert.equal(env.TMPDIR, "/tmp/lh-tmp");
	assert.equal(env.AGY_ACP_FORCE_FILE_STORAGE, "1");
	assert.equal(env.ANTIGRAVITY_HARNESS_PATH, "/opt/harness/localharness_external");
});

test("probeAntigravityInitialize validates fake ACP server and rejects wrong agent, errors, immediate exit, and timeout", async () => {
	const baseRuntime = {
		source: "custom" as const,
		kind: "acp-server" as const,
		executablePath: FAKE_ACP,
		args: [],
		version: null,
	};

	// Happy path + scrubbed env verification
	const ok = await probeAntigravityInitialize(baseRuntime, {
		baseEnv: {
			PATH: process.env.PATH,
			FAKE_ACP_MODE: "require-scrubbed-env",
			FAKE_ACP_VERSION: "1.4.5",
			GEMINI_API_KEY: "should-be-stripped",
			GOOGLE_API_KEY: "should-be-stripped",
			GOOGLE_CLOUD_PROJECT: "should-be-stripped",
		},
	});
	assert.equal(ok.version, "1.4.5");

	await assert.rejects(
		probeAntigravityInitialize(baseRuntime, { baseEnv: { PATH: process.env.PATH, FAKE_ACP_MODE: "wrong-agent" } }),
		/Unexpected ACP agentInfo\.name/,
	);
	await assert.rejects(
		probeAntigravityInitialize(baseRuntime, { baseEnv: { PATH: process.env.PATH, FAKE_ACP_MODE: "error" } }),
		/synthetic initialize error/,
	);
	await assert.rejects(
		probeAntigravityInitialize(baseRuntime, { baseEnv: { PATH: process.env.PATH, FAKE_ACP_MODE: "immediate-exit" } }),
		/exited before initialize response/,
	);
	await assert.rejects(
		probeAntigravityInitialize(baseRuntime, {
			timeoutMs: 80,
			baseEnv: { PATH: process.env.PATH, FAKE_ACP_MODE: "hang" },
		}),
		/timed out/,
	);
});

test("managed installer downloads, verifies SHA-256 & sizes, validates via ACP initialize, writes markers, and removes only managed files", async (t) => {
	const root = makeTempDir(t);
	const dataDir = join(root, "data");
	const homeDir = join(root, "home");
	const externalT3Root = t3ExternalRuntimeRoot(homeDir, "linux", "x64");
	const t3 = writeManagedOrT3Fixture(externalT3Root);

	const execBuf = Buffer.from(`#!/bin/sh\nexec "${process.execPath}" "${FAKE_ACP}" "$@"\n`);
	const harnessBuf = Buffer.from("#!/bin/sh\nexit 0\n");
	const zipBuf = buildZipBuffer([
		{ name: "agy_acp_server.par", content: execBuf },
		{ name: "localharness_external", content: harnessBuf },
	]);
	const manifest = makeFakeManifest(zipBuf, execBuf, harnessBuf);

	const phases: string[] = [];
	const installed = await installManagedAntigravityRuntime({
		dataDir,
		platform: "linux",
		arch: "x64",
		manifestEntry: manifest,
		fetchFn: async () => new Response(new Uint8Array(zipBuf), { status: 200 }),
		validateRuntime: (rt) =>
			probeAntigravityInitialize(
				{ ...rt, executablePath: rt.executablePath, args: [] },
				{ baseEnv: { PATH: process.env.PATH } },
			),
		onProgress: (p) => {
			if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
		},
	});

	assert.deepEqual(phases, ["downloading", "verifying", "extracting", "verifying", "validating", "installed"]);
	assert.equal(installed.version, "1.4.5");
	assert.equal(installed.runtime.source, "managed");

	const resolved = await resolveAntigravityRuntime({
		dataDir,
		homeDir,
		platform: "linux",
		arch: "x64",
		env: { PATH: "" },
	});
	assert.equal(resolved.runtime?.source, "managed");
	assert.equal(resolved.managedInstalled, true);

	// Remove deletes managed runtime only, never T3 external files
	const removed = removeManagedAntigravityRuntime({ dataDir, platform: "linux", arch: "x64" });
	assert.equal(removed.removed, true);
	assert.equal(existsSync(managedRuntimeRoot(dataDir, "linux", "x64")), false);
	assert.equal(existsSync(t3.execPath), true);

	const resolvedAfterRemove = await resolveAntigravityRuntime({
		dataDir,
		homeDir,
		platform: "linux",
		arch: "x64",
		env: { PATH: "" },
	});
	assert.equal(resolvedAfterRemove.runtime?.source, "t3-external");
	assert.equal(resolvedAfterRemove.managedInstalled, false);
});

test("managed installer rejects SHA-256 mismatch, truncated/oversized archives, and extracted binary size mismatch", async (t) => {
	const root = makeTempDir(t);
	const dataDir = join(root, "data");
	const execBuf = Buffer.from("#!/bin/sh\necho ok\n");
	const harnessBuf = Buffer.from("#!/bin/sh\nexit 0\n");
	const zipBuf = buildZipBuffer([
		{ name: "agy_acp_server.par", content: execBuf },
		{ name: "localharness_external", content: harnessBuf },
	]);
	const manifest = makeFakeManifest(zipBuf, execBuf, harnessBuf);

	// 1. SHA-256 mismatch
	await assert.rejects(
		installManagedAntigravityRuntime({
			dataDir,
			platform: "linux",
			arch: "x64",
			manifestEntry: { ...manifest, sha256: "0".repeat(64) },
			fetchFn: async () => new Response(new Uint8Array(zipBuf), { status: 200 }),
		}),
		/SHA-256 mismatch/,
	);
	assert.equal(existsSync(join(managedRuntimeRoot(dataDir, "linux", "x64"), "active.json")), false);

	// 2. Truncated archive size mismatch
	await assert.rejects(
		installManagedAntigravityRuntime({
			dataDir,
			platform: "linux",
			arch: "x64",
			manifestEntry: manifest,
			fetchFn: async () => new Response(new Uint8Array(zipBuf.subarray(0, zipBuf.length - 5)), { status: 200 }),
		}),
		/Archive size mismatch/,
	);

	// 3. Oversized archive rejected while streaming
	await assert.rejects(
		installManagedAntigravityRuntime({
			dataDir,
			platform: "linux",
			arch: "x64",
			manifestEntry: manifest,
			fetchFn: async () =>
				new Response(new Uint8Array(Buffer.concat([zipBuf, Buffer.from("extra-bytes")])), { status: 200 }),
		}),
		/exceeds expected size/,
	);

	// 4. Extracted executable size mismatch
	await assert.rejects(
		installManagedAntigravityRuntime({
			dataDir,
			platform: "linux",
			arch: "x64",
			manifestEntry: { ...manifest, executable: { name: "agy_acp_server.par", bytes: execBuf.byteLength + 10 } },
			fetchFn: async () => new Response(new Uint8Array(zipBuf), { status: 200 }),
		}),
		/Extracted executable size mismatch/,
	);
	assert.equal(existsSync(join(managedRuntimeRoot(dataDir, "linux", "x64"), "active.json")), false);

	// 5. Validation probe failure prevents activation
	const tempScript = join(root, "script.mjs");
	copyFileSync(FAKE_ACP, tempScript);
	await assert.rejects(
		installManagedAntigravityRuntime({
			dataDir,
			platform: "linux",
			arch: "x64",
			manifestEntry: manifest,
			fetchFn: async () => new Response(new Uint8Array(zipBuf), { status: 200 }),
			validateRuntime: async () => {
				throw new Error("initialize rejected");
			},
		}),
		/initialize rejected/,
	);
	assert.equal(existsSync(join(managedRuntimeRoot(dataDir, "linux", "x64"), "active.json")), false);
});

test("resolveAntigravityRuntime and Sync probe version for custom/env agy CLI paths and tolerate missing version", async (t) => {
	const root = makeTempDir(t);
	const dataDir = join(root, "data");
	const envCli = makeExecutable(
		join(root, "env-bin", "agy"),
		"#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"agy 1.5.4\"; exit 0; fi\nexit 0\n",
	);
	const customCli = makeExecutable(
		join(root, "custom-bin", "antigravity"),
		"#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"antigravity 1.6.0\"; exit 0; fi\nexit 0\n",
	);
	const silentCli = makeExecutable(join(root, "silent-bin", "agy"), "#!/bin/sh\nexit 1\n");

	const envResolved = await resolveAntigravityRuntime({
		platform: "linux",
		arch: "x64",
		dataDir,
		homeDir: root,
		env: { LH_ANTIGRAVITY_BIN: envCli, PATH: "" },
	});
	assert.equal(envResolved.runtime?.source, "env");
	assert.equal(envResolved.runtime?.kind, "cli");
	assert.equal(envResolved.runtime?.version, "1.5.4");
	assert.equal(
		resolveAntigravityRuntimeSync({
			platform: "linux",
			arch: "x64",
			dataDir,
			homeDir: root,
			env: { LH_ANTIGRAVITY_BIN: envCli, PATH: "" },
		})?.version,
		"1.5.4",
	);

	const customResolved = await resolveAntigravityRuntime({
		platform: "linux",
		arch: "x64",
		dataDir,
		homeDir: root,
		binaryPath: customCli,
		env: { PATH: "" },
	});
	assert.equal(customResolved.runtime?.source, "custom");
	assert.equal(customResolved.runtime?.kind, "cli");
	assert.equal(customResolved.runtime?.version, "1.6.0");
	assert.equal(
		resolveAntigravityRuntimeSync({
			platform: "linux",
			arch: "x64",
			dataDir,
			homeDir: root,
			binaryPath: customCli,
			env: { PATH: "" },
		})?.version,
		"1.6.0",
	);

	const silentResolved = await resolveAntigravityRuntime({
		platform: "linux",
		arch: "x64",
		dataDir,
		homeDir: root,
		binaryPath: silentCli,
		env: { PATH: "" },
	});
	assert.equal(silentResolved.runtime?.kind, "cli");
	assert.equal(silentResolved.runtime?.version, null);
});

test("installManagedAntigravityRuntime forwards options.env to default ACP initialize validation", async (t) => {
	const root = makeTempDir(t);
	const dataDir = join(root, "data");
	const execBuf = Buffer.from(`#!/bin/sh\nexec "${process.execPath}" "${FAKE_ACP}" "$@"\n`);
	const harnessBuf = Buffer.from("#!/bin/sh\nexit 0\n");
	const zipBuf = buildZipBuffer([
		{ name: "agy_acp_server.par", content: execBuf },
		{ name: "localharness_external", content: harnessBuf },
	]);
	const manifest = makeFakeManifest(zipBuf, execBuf, harnessBuf);

	const installed = await installManagedAntigravityRuntime({
		dataDir,
		platform: "linux",
		arch: "x64",
		manifestEntry: manifest,
		fetchFn: async () => new Response(new Uint8Array(zipBuf), { status: 200 }),
		env: {
			PATH: process.env.PATH,
			FAKE_ACP_MODE: "require-scrubbed-env",
			FAKE_ACP_VERSION: "1.4.5",
			GEMINI_API_KEY: "should-be-scrubbed",
		},
	});
	assert.equal(installed.version, "1.4.5");
	assert.equal(installed.runtime.source, "managed");
});

test("antigravityRuntimeArgs adds --gemini-dir and --app-data-dir only for cli runtimes without duplicating flags", () => {
	assert.deepEqual(
		antigravityRuntimeArgs({ kind: "acp-server", args: ["--uid="] }, "/tmp/profile"),
		["--uid="],
	);
	assert.deepEqual(
		antigravityRuntimeArgs({ kind: "cli", args: ["acp"] }, "/tmp/profile"),
		["acp", "--gemini-dir", "/tmp/profile", "--app-data-dir", "antigravity-acp"],
	);
	assert.deepEqual(
		antigravityRuntimeArgs(
			{ kind: "cli", args: ["acp", "--gemini-dir=/already", "--app-data-dir", "custom"] },
			"/tmp/profile",
		),
		["acp", "--gemini-dir=/already", "--app-data-dir", "custom"],
	);
});

test("probeAntigravityInitialize supports agy 1.5.x agentInfo.name and CLI isolation flags", async () => {
	const ok = await probeAntigravityInitialize(
		{
			source: "cli",
			kind: "cli",
			executablePath: FAKE_ACP,
			args: ["acp"],
			version: "1.5.10",
		},
		{
			baseEnv: {
				PATH: process.env.PATH,
				FAKE_ACP_MODE: "cli-1510",
				FAKE_ACP_VERSION: "1.5.10",
			},
		},
	);
	assert.equal(ok.version, "1.5.10");
});
