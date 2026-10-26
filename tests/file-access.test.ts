import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { guardSourcePath, isWithin, setFileAccessPolicy, sourceAnchor } from "../src/agent/tools/file-access.ts";
import { resolveSourcePath } from "../src/agent/tools/fs-shared.ts";
import { findTool } from "../src/agent/tools/find.ts";
import { grepTool } from "../src/agent/tools/grep.ts";
import { lsTool } from "../src/agent/tools/ls.ts";
import { readTool } from "../src/agent/tools/read.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { runPdfReaderAgent } from "../src/agent/subagents/pdf-reader.ts";
import { expandFolder, privatePaths } from "../src/server/file-access.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { AUTH_FILE, PATHS } from "../config.ts";
import { composeAddFolder, composeRemoveFolder, isFolderEntry } from "../components/settings/agent-section.tsx";

/**
 * The learner-filesystem access policy (file-access wave): allowed folders
 * restrict every learner-file tool, the app's private paths are refused
 * always, and both rules apply to the REAL path (symlinks resolved).
 *
 * Fixture tree (tmpdir):
 *   study/notes.md            "eigenvector notes"
 *   study/escape -> ../outside   (symlink out of the allowed folder)
 *   outside/secret.txt        "eigenvector secret"
 *   appdata/auth.json         {"OPENROUTER_API_KEY": "sk-or-…"} (denied)
 */

let ROOT: string;

async function runText(tool: AgentTool<any>, params: unknown): Promise<string> {
	const result = await tool.execute!("c", params);
	const first = result.content[0];
	assert.ok(first !== undefined && first.type === "text");
	return (first as { type: "text"; text: string }).text;
}

/** The tool's error, as the model would see it (serverExecute rethrows). */
async function runError(tool: AgentTool<any>, params: unknown): Promise<string> {
	try {
		await tool.execute!("c", params);
	} catch (err) {
		return (err as Error).message;
	}
	assert.fail("expected the tool call to be refused");
}

before(async () => {
	ROOT = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lh-access-")));
	await fs.mkdir(path.join(ROOT, "study"), { recursive: true });
	await fs.mkdir(path.join(ROOT, "outside"), { recursive: true });
	await fs.mkdir(path.join(ROOT, "appdata"), { recursive: true });
	await fs.writeFile(path.join(ROOT, "study", "notes.md"), "eigenvector notes\n");
	await fs.writeFile(path.join(ROOT, "outside", "secret.txt"), "eigenvector secret\n");
	await fs.writeFile(path.join(ROOT, "appdata", "auth.json"), '{"OPENROUTER_API_KEY":"sk-or-v1-eigenvector"}\n');
	await fs.symlink(path.join(ROOT, "outside"), path.join(ROOT, "study", "escape"));
});

after(async () => {
	setFileAccessPolicy(() => ({ folders: [], denied: [] }));
	await fs.rm(ROOT, { recursive: true, force: true });
});

beforeEach(() => setFileAccessPolicy(() => ({ folders: [], denied: [] })));

const denyAppdata = () => ({ folders: [], denied: [path.join(ROOT, "appdata")] });
const onlyStudy = () => ({ folders: [path.join(ROOT, "study")], denied: [path.join(ROOT, "appdata")] });

describe("guardSourcePath", () => {
	it("the open policy allows any existing path and returns its real path", async () => {
		assert.equal(await guardSourcePath(path.join(ROOT, "outside", "secret.txt")), path.join(ROOT, "outside", "secret.txt"));
	});

	it("missing paths keep the tools' 'Path not found' wording", async () => {
		await assert.rejects(guardSourcePath(path.join(ROOT, "nope.md")), /Path not found/);
	});

	it("denied paths are refused, including anything beneath a denied folder", async () => {
		setFileAccessPolicy(denyAppdata);
		await assert.rejects(guardSourcePath(path.join(ROOT, "appdata", "auth.json")), /private app data/);
		await assert.rejects(guardSourcePath(path.join(ROOT, "appdata")), /private app data/);
	});

	it("allowed folders restrict reads to their subtrees", async () => {
		setFileAccessPolicy(onlyStudy);
		assert.ok(await guardSourcePath(path.join(ROOT, "study", "notes.md")));
		await assert.rejects(guardSourcePath(path.join(ROOT, "outside", "secret.txt")), /outside the folders/);
	});

	it("a symlink inside an allowed folder cannot reach outside it", async () => {
		setFileAccessPolicy(onlyStudy);
		await assert.rejects(guardSourcePath(path.join(ROOT, "study", "escape", "secret.txt")), /outside the folders/);
	});

	it("denied wins over an allowed folder that contains it", async () => {
		setFileAccessPolicy(() => ({ folders: [ROOT], denied: [path.join(ROOT, "appdata", "auth.json")] }));
		await assert.rejects(guardSourcePath(path.join(ROOT, "appdata", "auth.json")), /private app data/);
	});

	it("relative paths anchor at the first allowed folder when restricted, home otherwise", () => {
		assert.equal(sourceAnchor(), os.homedir());
		setFileAccessPolicy(onlyStudy);
		assert.equal(resolveSourcePath("notes.md"), path.join(ROOT, "study", "notes.md"));
		assert.equal(resolveSourcePath(), path.join(ROOT, "study"));
	});

	it("isWithin is a path-segment test, not a string prefix", () => {
		assert.equal(isWithin("/a/study", "/a/study"), true);
		assert.equal(isWithin("/a/study/x", "/a/study"), true);
		assert.equal(isWithin("/a/study-old/x", "/a/study"), false);
	});
});

describe("the learner-file tools honor the policy", () => {
	it("read refuses the key file and files outside the allowed folders", async () => {
		setFileAccessPolicy(onlyStudy);
		assert.match(await runText(readTool, { path: path.join(ROOT, "study", "notes.md") }), /eigenvector notes/);
		assert.match(await runError(readTool, { path: path.join(ROOT, "appdata", "auth.json") }), /private app data/);
		assert.match(await runError(readTool, { path: path.join(ROOT, "outside", "secret.txt") }), /outside the folders/);
	});

	it("grep and find walks skip denied paths; ls hides them", async () => {
		setFileAccessPolicy(denyAppdata);
		const grep = await runText(grepTool, { pattern: "eigenvector", path: ROOT });
		assert.match(grep, /notes\.md/);
		assert.ok(!grep.includes("sk-or"), "the key never appears in grep output");
		const find = await runText(findTool, { pattern: "*.json", path: ROOT });
		assert.ok(!find.includes("auth.json"));
		const ls = await runText(lsTool, { path: ROOT });
		assert.ok(!ls.includes("appdata"));
		assert.match(ls, /study\//);
	});

	it("grep/find/ls refuse a starting folder outside the allowed folders", async () => {
		setFileAccessPolicy(onlyStudy);
		assert.match(await runError(grepTool, { pattern: "x", path: path.join(ROOT, "outside") }), /outside the folders/);
		assert.match(await runError(findTool, { pattern: "*", path: ROOT }), /outside the folders/);
		assert.match(await runError(lsTool, { path: path.join(ROOT, "appdata") }), /private app data/);
	});

	it("the pdf job fails upfront on a refused path, before any model call", async () => {
		setFileAccessPolicy(onlyStudy);
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		faux.setResponses([fauxAssistantMessage([fauxText("never reached")])]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const result = await runPdfReaderAgent({ path: path.join(ROOT, "outside", "secret.txt"), question: "?" }, { engine });
		assert.match(result.brief, /^PDF failed: Access denied/);
		assert.equal(result.path, path.join(ROOT, "outside", "secret.txt"));
	});
});

describe("server policy provider", () => {
	it("expandFolder expands ~ and resolves the rest", () => {
		assert.equal(expandFolder("~", "/home/l"), "/home/l");
		assert.equal(expandFolder("~/Study", "/home/l"), path.join("/home/l", "Study"));
		assert.equal(expandFolder("/srv/notes/../study"), path.resolve("/srv/study"));
	});

	it("the private paths cover the key store and data dir, plus userData in the desktop app", () => {
		const web = privatePaths({});
		assert.ok(web.includes(AUTH_FILE));
		assert.ok(web.includes(PATHS.data));
		assert.ok(!web.includes(path.dirname(AUTH_FILE)));
		assert.ok(privatePaths({ LH_DESKTOP_SERVER: "1" }).includes(path.dirname(AUTH_FILE)));
	});
});

describe("fileAccess settings", () => {
	it("the write parser accepts absolute and ~/ folders, trims and de-duplicates", () => {
		const parsed = parseAgentSettingsBody({ fileAccess: { folders: [" ~/Study ", "/Users/l/notes", "~/Study"] } });
		assert.ok(parsed.ok);
		assert.deepEqual(parsed.settings.fileAccess, { folders: ["~/Study", "/Users/l/notes"] });
	});

	it("the write parser rejects relative paths and bad shapes", () => {
		assert.equal(parseAgentSettingsBody({ fileAccess: { folders: ["Study"] } }).ok, false);
		assert.equal(parseAgentSettingsBody({ fileAccess: { folders: "~/Study" } }).ok, false);
		assert.equal(parseAgentSettingsBody({ fileAccess: [] }).ok, false);
	});

	it("the read side keeps string folders and drops junk", () => {
		const record = sanitizeUserSettings({ version: 1, agent: { fileAccess: { folders: ["~/Study", 3, ""] } } });
		assert.deepEqual(record?.agent?.fileAccess, { folders: ["~/Study"] });
	});

	it("the settings-page composers add valid folders once and remove them", () => {
		assert.equal(isFolderEntry("~/Study"), true);
		assert.equal(isFolderEntry("C:\\Users\\l"), true);
		assert.equal(isFolderEntry("Study"), false);
		const one = composeAddFolder(undefined, " ~/Study ");
		assert.deepEqual(one.fileAccess, { folders: ["~/Study"] });
		assert.deepEqual(composeAddFolder(one, "~/Study").fileAccess, { folders: ["~/Study"] });
		assert.deepEqual(composeAddFolder(one, "relative").fileAccess, { folders: ["~/Study"] });
		assert.deepEqual(composeRemoveFolder(one, "~/Study").fileAccess, { folders: [] });
	});
});
