import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ChatStore, JobStore } from "../src/core/ports.ts";

// Set this test process's locations BEFORE importing config/agent modules.
// Never read or modify the developer's actual home, keys or learning data.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lh-source-access-")));
const home = path.join(root, "home");
const auth = path.join(root, "private", "custom-keys.json");
const data = path.join(root, "private", "data");
const previous = Object.fromEntries(["HOME", "USERPROFILE", "LH_AUTH_FILE", "LH_DATA_DIR"].map((key) => [key, process.env[key]]));
Object.assign(process.env, { HOME: home, USERPROFILE: home, LH_AUTH_FILE: auth, LH_DATA_DIR: data });
after(async () => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	await fs.rm(root, { recursive: true, force: true });
});

async function write(relative: string, body = "LH_SYNTHETIC_SECRET_MARKER\n"): Promise<string> {
	const file = path.join(root, relative);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, body);
	return file;
}
async function link(target: string, alias: string, directory = false): Promise<void> {
	await fs.symlink(target, alias, directory ? (process.platform === "win32" ? "junction" : "dir") : "file");
}

await write("home/notes/topic.md", "ordinary study notes\n");
await write("home/..notes/also.md", "ordinary dot-prefixed notes\n");
await write("home/.claudette/ok.md", "ordinary lookalike notes\n");
await write("home/.ssh/id_ed25519");
await write("transcripts/projects/session.jsonl");
await write("keyfiles/chatgpt-credentials.json");
await write("keyfiles/github-copilot-credentials.json");
await write("keyfiles/xai-credentials.json");
await write("keyfiles/.auth.json.tmp-123");
const uuid = "12345678-1234-4123-8123-123456789abc";
for (const name of ["chatgpt", "github-copilot", "xai"]) await write(`keyfiles/${name}-credentials.json.${uuid}.tmp`);
const targetKey = await write("relocated-token");
await link(path.join(root, "keyfiles"), path.join(root, "private"), true);
await link(targetKey, auth);
await link(path.join(root, "transcripts"), path.join(home, ".claude"), true);
await link(path.join(home, ".ssh"), path.join(home, "notes", "keys"), true);
await link(targetKey, path.join(home, "notes", "key-alias"));
await link(home, path.join(root, "home-alias"), true);
await link(home, path.join(root, "home-alias-2"), true);
await write("keyfiles/data/chats/session.json", "synthetic learning conversation\n");
await write("keyfiles/logs/main.log", "ordinary synthetic app log\n");
await write("keyfiles/custom-keys.json.backup-not-managed", "ordinary file\n");
await write("unrelated/.ssh/notes.md", "ordinary outside-home directory\n");
for (const name of [".env", ".env.example", ".env.template", ".ENV.production"]) await write(`elsewhere/${name}`);

const { isSensitivePath, resolveSourcePath, sensitiveHomeLocations, walkFiles } = await import("../src/agent/tools/fs-shared.ts");
const { readTool, createReadTool } = await import("../src/agent/tools/read.ts");
const { lsTool } = await import("../src/agent/tools/ls.ts");
const { findTool } = await import("../src/agent/tools/find.ts");
const { grepTool } = await import("../src/agent/tools/grep.ts");
const { runPdfReaderAgent } = await import("../src/agent/subagents/pdf-reader.ts");
const { createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
const { practiceTools } = await import("../src/agent/tools/practice.ts");

async function text(tool: AgentTool<any>, args: unknown): Promise<string> {
	const result = await tool.execute!("synthetic", args);
	assert.equal(result.content[0]?.type, "text");
	return (result.content[0] as { text: string }).text;
}
const denied = /Access denied: .* is a protected location/;

describe("source access: configured credentials only", () => {
	const protectedFiles = [
		auth, targetKey, path.join(home, "notes", "key-alias"),
		...(["chatgpt", "github-copilot", "xai"].flatMap((name) => [
			path.join(root, "private", `${name}-credentials.json`),
			path.join(root, "keyfiles", `${name}-credentials.json`),
			path.join(root, "private", `${name}-credentials.json.${uuid}.tmp`),
			path.join(root, "keyfiles", `${name}-credentials.json.${uuid}.tmp`),
		])),
		path.join(root, "private", ".auth.json.tmp-123"), path.join(root, "keyfiles", ".auth.json.tmp-123"),
	];
	for (const file of protectedFiles) {
		it(`refuses read and direct grep of ${path.relative(root, file)}`, async () => {
			await assert.rejects(readTool.execute!("s", { path: file }), denied);
			await assert.rejects(grepTool.execute!("s", { path: file, pattern: "LH_SYNTHETIC_SECRET_MARKER" }), denied);
		});
	}

	it("still reads app learning records, ordinary files and non-managed lookalikes", async () => {
		assert.match(await text(readTool, { path: path.join(data, "chats", "session.json") }), /synthetic learning conversation/);
		for (const file of ["home/notes/topic.md", "home/..notes/also.md", "home/.claudette/ok.md", "unrelated/.ssh/notes.md", "keyfiles/custom-keys.json.backup-not-managed", "private/logs/main.log"]) {
			assert.match(await text(readTool, { path: path.join(root, file) }), /ordinary/);
		}
		assert.match(await text(lsTool, { path: path.dirname(auth) }), /chatgpt-credentials\.json/);
		assert.match(await text(lsTool, { path: home }), /\.ssh\//);
	});

	it("root-wide discovery omits credential targets, temp files, transcripts and dotenv contents", async () => {
		assert.equal(await text(grepTool, { path: root, pattern: "LH_SYNTHETIC_SECRET_MARKER" }), "No matches found");
		const found = await text(findTool, { path: root, pattern: "*" });
		assert.match(found, /data\/chats\/session\.json/);
		assert.doesNotMatch(found, /relocated-token|credentials\.json|\.auth\.json\.tmp|transcripts\/|id_ed25519|elsewhere\/\.env/i);
	});

	it("does not confuse an allowed credential-directory sibling with the credential directory", () => {
		assert.equal(isSensitivePath(path.join(root, "private-sibling", "chatgpt-credentials.json")), false);
		assert.equal(isSensitivePath(path.join(root, "..ordinary", "notes.md")), false);
	});
});

describe("source access: canonical roots and all tool paths", () => {
	for (const alias of [home, path.join(root, "home-alias"), path.join(root, "home-alias-2")]) {
		it(`find/grep/walk cannot bypass denials through ${path.basename(alias)}`, async () => {
			const found = await text(findTool, { path: alias, pattern: "*" });
			assert.match(found, /notes\/topic\.md/);
			assert.doesNotMatch(found, /id_ed25519|session\.jsonl/);
			assert.equal(await text(grepTool, { path: alias, pattern: "LH_SYNTHETIC_SECRET_MARKER" }), "No matches found");
			const files: string[] = [];
			await walkFiles(alias, (file) => { files.push(file); return false; });
			assert.ok(files.every((file) => file.startsWith(home + path.sep)), "walk uses checked canonical paths");
			assert.ok(!files.some((file) => /^(?:\.ssh|\.claude)(?:\/|$)/.test(path.relative(home, file).split(path.sep).join("/"))));
		});
	}

	it("denies a sensitive directory's real target outside home, not only its symlink name", async () => {
		for (const folder of [path.join(home, ".claude"), path.join(root, "transcripts"), path.join(home, "notes", "keys")]) {
			await assert.rejects(lsTool.execute!("s", { path: folder }), denied);
			await assert.rejects(findTool.execute!("s", { path: folder, pattern: "*" }), denied);
			await assert.rejects(grepTool.execute!("s", { path: folder, pattern: "x" }), denied);
			await assert.rejects(walkFiles(folder, () => assert.fail("must not visit")), denied);
		}
		await assert.rejects(readTool.execute!("s", { path: path.join(root, "transcripts", "projects", "session.jsonl") }), denied);
	});

	it("canonicalizes an aliased HOME, including default and relative paths", async () => {
		process.env.HOME = process.env.USERPROFILE = path.join(root, "home-alias");
		try {
			assert.equal(resolveSourcePath(), home);
			assert.equal(resolveSourcePath("~"), home);
			assert.equal(resolveSourcePath("~/notes/topic.md"), path.join(home, "notes", "topic.md"));
			assert.match(await text(readTool, { path: "notes/topic.md" }), /ordinary study notes/);
			assert.equal(await text(grepTool, { pattern: "LH_SYNTHETIC_SECRET_MARKER" }), "No matches found");
		} finally { process.env.HOME = process.env.USERPROFILE = home; }
	});

	it("a broken protected root does not disable ordinary reads, while source loops are never opened unchecked", async () => {
		const protectedLoop = path.join(home, ".gemini");
		const ordinaryLoop = path.join(home, "notes", "loop");
		await link(protectedLoop, protectedLoop, true);
		await link(ordinaryLoop, ordinaryLoop, true);
		try {
			assert.match(await text(readTool, { path: "notes/topic.md" }), /ordinary study notes/);
			await assert.rejects(readTool.execute!("s", { path: protectedLoop }), denied);
			await assert.rejects(readTool.execute!("s", { path: ordinaryLoop }), /ELOOP/);
		} finally {
			await fs.unlink(protectedLoop);
			await fs.unlink(ordinaryLoop);
		}
	});

	it("uses the checked target for an ordinary file alias, and preserves missing-file errors", async () => {
		const alias = path.join(home, "notes", "topic-alias");
		await link(path.join(home, "notes", "topic.md"), alias);
		assert.equal(resolveSourcePath(alias), path.join(home, "notes", "topic.md"));
		assert.match(await text(readTool, { path: alias }), /ordinary study notes/);
		await assert.rejects(readTool.execute!("s", { path: "notes/absent" }), /ENOENT/);
		await assert.rejects(readTool.execute!("s", { path: "notes/keys/absent" }), denied);
	});

	for (const name of [".env", ".env.example", ".env.template", ".ENV.production"]) {
		it(`denies ${name} outside home, including through a differently named alias`, async () => {
			const file = path.join(root, "elsewhere", name);
			const alias = path.join(home, "notes", `alias-${name}`);
			await link(file, alias);
			await assert.rejects(readTool.execute!("s", { path: file }), denied);
			await assert.rejects(readTool.execute!("s", { path: alias }), denied);
		});
	}

	it("applies unchanged to prober, teacher and practice registrations and model-bound reads", async () => {
		const ctx = { chatId: "synthetic", chatStore: { getChat: () => null } as unknown as ChatStore, jobStore: {} as JobStore, spawn: () => {}, deliver: () => {} };
		for (const tools of [createProberTools(ctx), createTeacherTools(ctx), practiceTools(ctx)]) {
			await assert.rejects(tools.read!.execute!("s", { path: auth }), denied);
			await assert.rejects(tools.ls!.execute!("s", { path: "~/.ssh" }), denied);
			await assert.rejects(tools.find!.execute!("s", { path: "~/.ssh", pattern: "*" }), denied);
			await assert.rejects(tools.grep!.execute!("s", { path: auth, pattern: "x" }), denied);
		}
		const model = createFauxCore({ tokenSize: { min: 64, max: 64 } }).getModel();
		await assert.rejects(createReadTool(model).execute!("s", { path: auth }), denied);
	});

	it("normal image reading still works; protected image reads fail at the shared gate", async () => {
		const canvas = createCanvas(1, 1);
		const ordinary = path.join(home, "notes", "image.png");
		const protectedImage = path.join(home, ".ssh", "image.png");
		await fs.writeFile(ordinary, canvas.toBuffer("image/png"));
		await fs.copyFile(ordinary, protectedImage);
		assert.equal((await readTool.execute!("s", { path: ordinary })).content[1]?.type, "image");
		await assert.rejects(readTool.execute!("s", { path: protectedImage }), denied);
	});

	it("PDF denial is a structured upfront failure before parsing, rendering or model calls", async () => {
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		let modelCalls = 0;
		const engine = { model: faux.getModel(), streamFn: (() => { modelCalls++; throw new Error("must not call model"); }) as typeof faux.streamSimple };
		for (const file of [auth, path.join(home, ".ssh", "id_ed25519"), path.join(root, "transcripts", "projects", "session.jsonl")]) {
			const result = await runPdfReaderAgent({ path: file, question: "synthetic" }, { engine });
			assert.match(result.brief, /^PDF failed: Access denied:/);
			assert.match(result.brief, /Do not paste credentials or private transcripts/);
			assert.doesNotMatch(result.brief, /LH_SYNTHETIC_SECRET_MARKER/);
			assert.deepEqual(result.pagesRead, []);
			assert.deepEqual(result.pagesConsulted, []);
		}
		assert.equal(modelCalls, 0);
	});
});

describe("source access: case-sensitive home-location variants", () => {
	it("expands every matching spelling at every segment, including coexisting case variants", () => {
		const listings = new Map([
			[home, [".ssh", ".SSH", ".config", ".CONFIG", ".claudette"]],
			[path.join(home, ".config"), ["gcloud"]],
			[path.join(home, ".CONFIG"), ["gcloud", "GCLOUD"]],
		]);
		const reads = new Map<string, number>();
		const roots = sensitiveHomeLocations(home, (directory) => {
			reads.set(directory, (reads.get(directory) ?? 0) + 1);
			return listings.get(directory) ?? [];
		});
		for (const relative of [".ssh", ".SSH", ".config/gcloud", ".CONFIG/gcloud", ".CONFIG/GCLOUD"]) {
			assert.ok(roots.includes(path.join(home, relative)), relative);
		}
		assert.ok(!roots.includes(path.join(home, ".claudette")));
		assert.ok([...reads.values()].every((count) => count === 1), "parent listings are cached per policy snapshot");
	});

	it("modeled case-sensitive lookup denies canonical targets of case-variant single/multi-segment roots", async (t) => {
		const ssh = path.join(home, ".ssh");
		const saved = path.join(root, "saved-ssh");
		const upperSsh = path.join(home, ".SSH");
		const upperConfig = path.join(home, ".CONFIG");
		const vault = path.join(root, "variant-vault");
		const cloudVault = path.join(root, "variant-cloud-vault");
		await write("variant-vault/key", "CASE_VARIANT_SECRET\n");
		await write("variant-cloud-vault/key", "CASE_VARIANT_SECRET\n");
		await fs.rename(ssh, saved);
		await link(vault, upperSsh, true);
		await fs.mkdir(upperConfig);
		await link(cloudVault, path.join(upperConfig, "GCLOUD"), true);
		const native = realpathSync.native;
		// Make the missing lowercase spellings genuinely miss even on the
		// host's case-insensitive volume. All other IO uses the real synthetic
		// files. This models Linux lookup, not a claimed native Linux run.
		t.mock.method(realpathSync, "native", (file: string) => {
			if ([ssh, path.join(home, ".config")].some((prefix) => file === prefix || file.startsWith(prefix + path.sep))) {
				throw Object.assign(new Error("synthetic case-sensitive ENOENT"), { code: "ENOENT" });
			}
			return native(file);
		});
		try {
			for (const folder of [upperSsh, path.join(upperConfig, "GCLOUD"), vault, cloudVault]) {
				await assert.rejects(readTool.execute!("case-root", { path: path.join(folder, "key") }), denied);
				await assert.rejects(lsTool.execute!("case-root", { path: folder }), denied);
				await assert.rejects(findTool.execute!("case-root", { path: folder, pattern: "*" }), denied);
				await assert.rejects(grepTool.execute!("case-root", { path: folder, pattern: "CASE_VARIANT_SECRET" }), denied);
				await assert.rejects(walkFiles(folder, () => assert.fail("protected target must not be visited")), denied);
				const pdf = await runPdfReaderAgent({ path: path.join(folder, "key"), question: "synthetic" });
				assert.match(pdf.brief, /^PDF failed: Access denied:/);
			}
			assert.equal(await text(grepTool, { path: root, pattern: "CASE_VARIANT_SECRET" }), "No matches found");
			assert.match(await text(readTool, { path: "notes/topic.md" }), /ordinary study notes/);
		} finally {
			t.mock.restoreAll();
			await fs.unlink(upperSsh);
			await fs.rm(upperConfig, { recursive: true });
			await fs.rename(saved, ssh);
			await fs.rm(vault, { recursive: true });
			await fs.rm(cloudVault, { recursive: true });
		}
	});
});

describe("source access: credential case aliases on the fixture filesystem", () => {
	async function caseAliasesAvailable(): Promise<boolean> {
		try {
			const [named, alias] = await Promise.all([fs.stat(path.join(root, "keyfiles")), fs.stat(path.join(root, "KEYFILES"))]);
			return named.dev === alias.dev && named.ino === alias.ino;
		} catch { return false; }
	}

	it("refuses differently cased credential filenames, directories, real targets and temporary files", async (t) => {
		if (!await caseAliasesAvailable()) return t.skip("fixture filesystem is case-sensitive");
		const aliases = [
			path.join(root, "keyfiles", "CHATGPT-CREDENTIALS.JSON"),
			path.join(root, "KEYFILES", "github-copilot-credentials.json"),
			path.join(root, "KEYFILES", "XAI-CREDENTIALS.JSON"),
			path.join(root, "RELOCATED-TOKEN"),
			path.join(root, "KEYFILES", ".auth.json.tmp-123"),
			path.join(root, "KEYFILES", `chatgpt-credentials.json.${uuid}.tmp`),
		];
		for (const alias of aliases) {
			if (process.platform === "darwin") {
				const original = path.join(root, path.relative(root, alias).toLowerCase());
				assert.equal(realpathSync.native(alias), realpathSync.native(original), "native realpath canonicalizes these synthetic case aliases on this Mac");
			}
			await assert.rejects(readTool.execute!("case-alias", { path: alias }), denied);
			await assert.rejects(grepTool.execute!("case-alias", { path: alias, pattern: "LH_SYNTHETIC_SECRET_MARKER" }), denied);
			const pdf = await runPdfReaderAgent({ path: alias, question: "synthetic" });
			assert.match(pdf.brief, /^PDF failed: Access denied:/);
		}
		assert.equal(await text(grepTool, { path: path.join(root, "KEYFILES"), pattern: "LH_SYNTHETIC_SECRET_MARKER" }), "No matches found");
		const found = await text(findTool, { path: path.join(root, "KEYFILES"), pattern: "*" });
		assert.doesNotMatch(found, /credentials\.json|\.auth\.json\.tmp/);
		assert.match(found, /data\/chats\/session\.json/);
	});

	it("protects a non-symlink configured AUTH_FILE regardless of filename or parent-directory case", async (t) => {
		if (!await caseAliasesAvailable()) return t.skip("fixture filesystem is case-sensitive");
		await fs.unlink(auth);
		await fs.writeFile(auth, "LH_SYNTHETIC_SECRET_MARKER\n");
		try {
			for (const alias of [path.join(root, "keyfiles", "CUSTOM-KEYS.JSON"), path.join(root, "KEYFILES", "custom-keys.json")]) {
				await assert.rejects(readTool.execute!("case-auth", { path: alias }), denied);
				await assert.rejects(grepTool.execute!("case-auth", { path: alias, pattern: "LH_SYNTHETIC_SECRET_MARKER" }), denied);
				const pdf = await runPdfReaderAgent({ path: alias, question: "synthetic" });
				assert.match(pdf.brief, /^PDF failed: Access denied:/);
			}
		} finally {
			await fs.unlink(auth);
			await link(targetKey, auth);
		}
	});
});

describe("source access: path spelling", () => {
	it("covers all donor home locations, case-insensitively and with segment boundaries", () => {
		const locations = [".claude", ".codex", ".cursor", ".gemini", ".ssh", ".gnupg", ".aws", ".azure", ".config/gcloud", ".kube", ".docker", ".netrc", ".npmrc", ".pypirc", ".git-credentials", "Library/Keychains", "Library/Cookies", "Library/Safari", "Library/Application Support/Google/Chrome", "Library/Application Support/BraveSoftware", "Library/Application Support/Microsoft Edge", "Library/Application Support/Firefox", ".mozilla", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".config/microsoft-edge", "AppData/Local/Google/Chrome", "AppData/Local/BraveSoftware", "AppData/Local/Microsoft/Edge", "AppData/Roaming/Mozilla"];
		for (const location of locations) {
			assert.equal(isSensitivePath(path.join(home, location)), true, location);
			assert.equal(isSensitivePath(path.join(home, location.toUpperCase(), "child")), true, location);
			assert.equal(isSensitivePath(path.join(home, `${location}-lookalike`, "child")), false, location);
		}
	});

	it("Windows drive/UNC namespaces and credential/dotenv streams cannot bypass matching", { skip: process.platform !== "win32" }, () => {
		for (const winHome of ["C:\\Users\\Learner", "\\\\server\\share\\Learner"]) {
			const winAuth = path.join(winHome, "app", "auth.json");
			const prefix = winHome.startsWith("\\\\") ? `\\\\?\\UNC\\${winHome.slice(2)}` : `\\\\?\\${winHome}`;
			assert.equal(isSensitivePath(path.join(prefix, ".ssh", "key"), winHome, winAuth), true);
			assert.equal(isSensitivePath(`${winAuth}:stream`, winHome, winAuth), true);
			assert.equal(isSensitivePath(path.join(winHome, "notes", ".env:stream"), winHome, winAuth), true);
			assert.equal(isSensitivePath(path.join(winHome, ".sship", "key"), winHome, winAuth), false);
		}
	});
});
