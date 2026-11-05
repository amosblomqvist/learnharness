import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createCanvas } from "@napi-rs/canvas";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ChatStore, JobStore } from "../src/core/ports.ts";
import type { FileAccessPolicy } from "../src/agent/tools/file-access.ts";

(globalThis as Record<string, unknown>).React = React;
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lh-folder-access-")));
const home = path.join(root, "home");
const a = path.join(home, "StudyA");
const b = path.join(root, "mount", "StudyB");
const outside = path.join(home, "Outside");
const auth = path.join(root, "private", "keys.json");
const data = path.join(root, "private", "data");
const prior = Object.fromEntries(["HOME", "USERPROFILE", "LH_AUTH_FILE", "LH_DATA_DIR"].map((key) => [key, process.env[key]]));
Object.assign(process.env, { HOME: home, USERPROFILE: home, LH_AUTH_FILE: auth, LH_DATA_DIR: data });
async function write(file: string, text: string | Buffer): Promise<void> { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
const notesA = path.join(a, "notes.md");
const notesB = path.join(b, "notes.md");
await write(notesA, "shared course marker A\n");
await write(notesB, "shared course marker B\n");
await write(path.join(a, "nested", "more.md"), "shared course marker nested\n");
await write(path.join(a, "..notes", "literal.md"), "literal dot-prefix\n");
await write(path.join(outside, "secret.txt"), "OUTSIDE_ONLY_MARKER\n");
await write(path.join(home, "StudyA-old", "secret.txt"), "OUTSIDE_ONLY_MARKER\n");
await write(auth, "SYNTHETIC_CREDENTIAL_MARKER\n");
await write(path.join(home, ".ssh", "key"), "SYNTHETIC_CREDENTIAL_MARKER\n");
await write(path.join(a, ".env.example"), "SYNTHETIC_CREDENTIAL_MARKER\n");
await write(path.join(data, "chats", "session.json"), "ordinary learning record\n");
await write(path.join(root, "private", "logs", "main.log"), "ordinary application log\n");
const png = createCanvas(2, 2).toBuffer("image/png");
await write(path.join(a, "image.png"), png);
await write(path.join(outside, "image.png"), png);
await fs.copyFile(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf"), path.join(a, "sample.pdf"));
await fs.copyFile(path.join(a, "sample.pdf"), path.join(outside, "sample.pdf"));
const dirLink = async (target: string, alias: string) => fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
await dirLink(outside, path.join(a, "escape"));
await dirLink(a, path.join(root, "alias-a"));
await dirLink(b, path.join(a, "other-root"));

const { guardSourcePath, isWithin, resolvePolicy, setFileAccessPolicy } = await import("../src/agent/tools/file-access.ts");
const { resolveSourcePath, sourceSearchRoots, walkFiles, WALK_TIMEOUT_MS } = await import("../src/agent/tools/fs-shared.ts");
const { readTool, createReadTool } = await import("../src/agent/tools/read.ts");
const { lsTool } = await import("../src/agent/tools/ls.ts");
const { findTool } = await import("../src/agent/tools/find.ts");
const { grepTool } = await import("../src/agent/tools/grep.ts");
const { runPdfReaderAgent } = await import("../src/agent/subagents/pdf-reader.ts");
const { createShowImageTool } = await import("../src/agent/tools/show-image.ts");
const { loadLearnerImage } = await import("../src/agent/tools/learner-image.ts");
const { createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
const { practiceTools } = await import("../src/agent/tools/practice.ts");
const { parseAgentSettingsBody } = await import("../src/server/settings-body.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { expandFolder } = await import("../src/server/file-access.ts");
const { AgentSection, composeAddFolder, composeRemoveFolder, composeFileRestriction, isFolderEntry } = await import("../components/settings/agent-section.tsx");
let policy: FileAccessPolicy = { restricted: false, folders: [] };
beforeEach(() => { policy = { restricted: false, folders: [] }; setFileAccessPolicy(() => policy); });
after(async () => {
	setFileAccessPolicy(() => ({ restricted: false, folders: [] }));
	for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	await fs.rm(root, { recursive: true, force: true });
});
async function text(tool: AgentTool<any>, input: unknown): Promise<string> {
	const result = await tool.execute!("folder-test", input);
	assert.equal(result.content[0]?.type, "text");
	return (result.content[0] as { text: string }).text;
}
const boundary = /Access denied: .*allowed folders/;
const mandatory = /Access denied: .*protected location/;

describe("optional folder policy (finishing lickbot #157)", () => {
	it("OFF retains broad reads even with a saved folder list, and no whole app-data ban", async () => {
		policy = { restricted: false, folders: [a] };
		assert.match(await text(readTool, { path: path.join(outside, "secret.txt") }), /OUTSIDE_ONLY/);
		assert.match(await text(readTool, { path: path.join(data, "chats", "session.json") }), /ordinary learning/);
		assert.match(await text(readTool, { path: path.join(root, "private", "logs", "main.log") }), /ordinary application/);
		assert.equal(resolveSourcePath(), home);
		assert.match(await text(lsTool, {}), /StudyA\//);
	});
	it("ON+empty blocks every filesystem entry point, with no fallback", async () => {
		policy = { restricted: true, folders: [] };
		await assert.rejects(readTool.execute!("x", { path: notesA }), boundary);
		await assert.rejects(lsTool.execute!("x", {}), /no accessible allowed folders/);
		await assert.rejects(findTool.execute!("x", { pattern: "*" }), /no accessible allowed folders/);
		await assert.rejects(grepTool.execute!("x", { pattern: "course" }), /no accessible allowed folders/);
		await assert.rejects(walkFiles(a, () => assert.fail("must not walk")), boundary);
	});
	it("explicit relative and tilde paths remain HOME-relative, never first-folder-relative", async () => {
		policy = { restricted: true, folders: [a, b] };
		assert.equal(resolveSourcePath("StudyA/notes.md"), notesA);
		assert.equal(resolveSourcePath("~/StudyA/notes.md"), notesA);
		assert.equal(resolveSourcePath(path.join(a, "..notes", "literal.md")), path.join(a, "..notes", "literal.md"));
		assert.throws(() => resolveSourcePath("notes.md"), boundary);
		assert.throws(() => resolveSourcePath("StudyA/../Outside/secret.txt"), boundary);
		assert.throws(() => resolveSourcePath(path.join(home, "StudyA-old", "secret.txt")), boundary);
		assert.equal(await guardSourcePath(path.join(root, "alias-a", "notes.md")), notesA);
	});
	it("source symlinks cannot escape, but aliases INTO an allowed target work", async () => {
		policy = { restricted: true, folders: [a] };
		await assert.rejects(readTool.execute!("x", { path: path.join(a, "escape", "secret.txt") }), boundary);
		await assert.rejects(readTool.execute!("x", { path: path.join(a, "other-root", "notes.md") }), boundary);
		assert.match(await text(readTool, { path: path.join(root, "alias-a", "notes.md") }), /marker A/);
		assert.doesNotMatch(await text(lsTool, { path: a }), /escape|other-root/);
		assert.equal(await text(grepTool, { pattern: "OUTSIDE_ONLY_MARKER" }), "No matches found");
	});
	it("mandatory named/canonical denials win even when a parent is explicitly allowed", async () => {
		policy = { restricted: true, folders: [root] };
		for (const file of [auth, path.join(home, ".ssh", "key"), path.join(a, ".env.example")]) {
			await assert.rejects(readTool.execute!("x", { path: file }), mandatory);
			await assert.rejects(grepTool.execute!("x", { path: file, pattern: "x" }), mandatory);
		}
		assert.equal(await text(grepTool, { pattern: "SYNTHETIC_CREDENTIAL_MARKER" }), "No matches found");
		assert.match(await text(readTool, { path: path.join(data, "chats", "session.json") }), /ordinary learning/);
	});
	it("unknown/malformed provider data fails closed rather than becoming OFF", async () => {
		setFileAccessPolicy(() => ({ restricted: true, folders: [], error: "File-access configuration cannot be read reliably" }));
		await assert.rejects(readTool.execute!("x", { path: notesA }), /configuration cannot be read/);
		setFileAccessPolicy(() => ({ restricted: "yes", folders: [a] }) as unknown as FileAccessPolicy);
		await assert.rejects(lsTool.execute!("x", {}), /configuration error/);
	});
	it("isWithin is segment-aware, including ordinary ..prefix names", () => {
		assert.ok(isWithin(path.join(a, "nested", "notes"), a));
		assert.ok(isWithin(path.join(a, "..notes", "notes"), a));
		assert.ok(!isWithin(`${a}-old`, a));
		assert.ok(!isWithin(path.dirname(a), a));
	});
});

describe("default multi-root discovery", () => {
	it("searches ALL roots with absolute unambiguous results; explicit searches stay relative", async () => {
		policy = { restricted: true, folders: [a, b] };
		const found = await text(findTool, { pattern: "notes.md" });
		assert.deepEqual(new Set(found.split("\n")), new Set([notesA, notesB]));
		const matches = await text(grepTool, { pattern: "shared course marker", glob: "notes.md" });
		assert.ok(matches.includes(`${notesA}:1: shared course marker A`));
		assert.ok(matches.includes(`${notesB}:1: shared course marker B`));
		assert.equal(await text(findTool, { path: "StudyA", pattern: "notes.md" }), "notes.md");
		assert.equal(await text(grepTool, { path: a, pattern: "marker A" }), "notes.md:1: shared course marker A");
	});
	it("ls without a path lists ROOTS, not their contents", async () => {
		policy = { restricted: true, folders: [a, b] };
		const listed = await text(lsTool, {});
		assert.equal(listed, `Allowed folders:\n${a}\n${b}`);
		assert.doesNotMatch(listed, /notes\.md|image\.png/);
	});
	it("deduplicates aliases and overlapping roots without duplicating file hits", async () => {
		policy = { restricted: true, folders: [path.join(a, "nested"), b, a, path.join(root, "alias-a")] };
		const resolved = resolvePolicy();
		assert.deepEqual(new Set(resolved.folders), new Set([a, b]));
		const found = (await text(findTool, { pattern: "*.md" })).split("\n");
		assert.equal(found.filter((file) => file === path.join(a, "nested", "more.md")).length, 1);
		assert.equal(found.filter((file) => file === notesA).length, 1);
		assert.equal(found.filter((file) => file === notesB).length, 1);
	});
	it("shares find/grep result limits across roots", async () => {
		policy = { restricted: true, folders: [a, b] };
		const found = await text(findTool, { pattern: "notes.md", limit: 1 });
		assert.equal(found.split("\n").filter((line) => line.endsWith("notes.md")).length, 1);
		assert.match(found, /1 results limit/);
		const matched = await text(grepTool, { pattern: "shared", glob: "notes.md", limit: 1 });
		assert.equal(matched.split("\n").filter((line) => line.includes(":1:")).length, 1);
		assert.match(matched, /1 matches limit/);
	});
	it("retains unavailable roots with a notice, and never falls back if none are usable", async () => {
		const missing = path.join(root, "unmounted");
		policy = { restricted: true, folders: [missing, a] };
		assert.match(await text(findTool, { pattern: "notes.md" }), /Skipped 1 unavailable/);
		assert.match(await text(grepTool, { pattern: "nothing matches" }), /No matches found\n\n\[Skipped 1 unavailable/);
		assert.ok(policy.folders.includes(missing), "the preference is retained");
		policy = { restricted: true, folders: [missing] };
		await assert.rejects(findTool.execute!("x", { pattern: "*" }), /no accessible allowed folders/);
		await assert.rejects(lsTool.execute!("x", {}), /no accessible allowed folders/);
	});
	it("a protected selected root cannot override mandatory denials", async () => {
		policy = { restricted: true, folders: [path.join(home, ".ssh"), a] };
		assert.match(await text(findTool, { pattern: "notes.md" }), /Skipped 1 protected/);
		assert.equal(sourceSearchRoots().roots[0], a);
	});
	it("walkers accept one shared deadline across multiple roots", async (t) => {
		policy = { restricted: true, folders: [a, b] };
		const snapshot = resolvePolicy();
		let now = 100;
		t.mock.method(Date, "now", () => now);
		const deadline = now + WALK_TIMEOUT_MS;
		let first = 0;
		await walkFiles(a, () => { first++; now = deadline + 1; return false; }, undefined, { policy: snapshot, deadline });
		let second = 0;
		const result = await walkFiles(b, () => { second++; return false; }, undefined, { policy: snapshot, deadline });
		assert.equal(first, 1);
		assert.equal(second, 0);
		assert.equal(result.timedOut, true);
	});
});

describe("live policy and all learner-source surfaces", () => {
	it("existing tool instances honor subsequent changes, while a running walk can finish", async () => {
		policy = { restricted: true, folders: [a] };
		assert.match(await text(readTool, { path: notesA }), /marker A/);
		let visits = 0;
		await walkFiles(a, () => { visits++; policy = { restricted: true, folders: [b] }; return false; });
		assert.ok(visits > 1);
		await assert.rejects(readTool.execute!("x", { path: notesA }), boundary);
		assert.match(await text(readTool, { path: notesB }), /marker B/);
		policy = { restricted: false, folders: [b] };
		assert.match(await text(readTool, { path: notesA }), /marker A/);
	});
	it("prober, teacher, practice, model-bound read, PDF and images all share the gate", async () => {
		policy = { restricted: true, folders: [a] };
		let snapshots = 0;
		let jobs = 0;
		const ctx = { chatId: "synthetic", chatStore: { getChat: () => null, saveImageSnapshot: () => { snapshots++; } } as unknown as ChatStore,
			jobStore: { findJobByToolCallId: () => undefined, createJob: () => { jobs++; throw new Error("must not create a refused job"); } } as unknown as JobStore, spawn: () => {}, deliver: () => {} };
		for (const tools of [createProberTools(ctx), createTeacherTools(ctx), practiceTools({ ...ctx, jobs: ctx })]) {
			await assert.rejects(tools.read!.execute!("x", { path: path.join(outside, "secret.txt") }), boundary);
			await assert.rejects(tools.ls!.execute!("x", { path: outside }), boundary);
			await assert.rejects(tools.find!.execute!("x", { path: outside, pattern: "*" }), boundary);
			await assert.rejects(tools.grep!.execute!("x", { path: outside, pattern: "x" }), boundary);
			await assert.rejects(tools.pdf!.execute!("x", { path: path.join(outside, "sample.pdf"), question: "?" }), boundary);
			if (tools.show_image) await assert.rejects(tools.show_image.execute!("x", { path: path.join(outside, "image.png") }), boundary);
			if (tools.visual) await assert.rejects(tools.visual.execute!("x", { brief: "mark", image: path.join(outside, "image.png") }), boundary);
		}
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		await assert.rejects(createReadTool(faux.getModel()).execute!("x", { path: path.join(outside, "image.png") }), boundary);
		await assert.rejects(loadLearnerImage(path.join(outside, "image.png")), boundary);
		await assert.rejects(createShowImageTool(ctx).execute!("x", { path: path.join(outside, "image.png") }), boundary);
		let modelCalls = 0;
		const result = await runPdfReaderAgent({ path: path.join(outside, "sample.pdf"), question: "?" }, { engine: { model: faux.getModel(), streamFn: (() => { modelCalls++; throw new Error("must not call"); }) as typeof faux.streamSimple } });
		assert.match(result.brief, /^PDF failed: Access denied:/);
		assert.equal(modelCalls, 0);
		assert.equal(snapshots, 0);
		assert.equal(jobs, 0);
		assert.equal((await readTool.execute!("x", { path: path.join(a, "image.png") })).content[1]?.type, "image");
	});
	it("queued PDF/annotation starts use fresh permissions, preserving raw inputs and replay IDs", async () => {
		const { chatStore } = await import("../src/store/chats.ts");
		const { jobStore } = await import("../src/store/jobs.ts");
		const { jobTools } = await import("../src/agent/tools/jobs.ts");
		const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		let calls = 0;
		const engine = { model: faux.getModel(), streamFn: (() => { calls++; throw new Error("must not call model"); }) as typeof faux.streamSimple };
		for (const kind of ["pdf", "visual"] as const) {
			policy = { restricted: true, folders: [a] };
			const chat = chatStore.createChat(`synthetic queued ${kind}`);
			const input = kind === "pdf" ? { path: "StudyA/sample.pdf", question: "?" } : { image: "StudyA/image.png", brief: "mark" };
			let spawned = 0;
			let id = "";
			const tools = jobTools({ chatId: chat.id, jobStore, spawn: (job) => { id = job.id; spawned++; } });
			await tools[kind]!.execute!("queued-call", input);
			assert.equal(spawned, 1);
			assert.deepEqual(jobStore.getJob(id)?.input, input);
			policy = { restricted: true, folders: [b] };
			// Repeated call IDs acknowledge the original job, not a new read.
			await tools[kind]!.execute!("queued-call", input);
			assert.equal(spawned, 1);
			const runner = createJobRunner({ chatStore, jobStore, engineFor: () => engine, deliver: async () => {} });
			await runner.runJob(id);
			const job = jobStore.getJob(id)!;
			assert.match(JSON.stringify(job.result), /Access denied:.*allowed folders/);
			assert.deepEqual(job.input, input);
			assert.equal(chatStore.getChat(chat.id)?.imageSnapshots, undefined);
		}
		assert.equal(calls, 0);
	});
	it("the researcher's job-scoped PDF tools retain their own independent boundary", async () => {
		policy = { restricted: true, folders: [] };
		const { createPdfReadTools } = await import("../src/agent/tools/pdf-read.ts");
		const tools = createPdfReadTools(outside);
		assert.match(await text(tools.pdf_info!, { path: path.join(outside, "sample.pdf") }), /"page_count":\s*3/);
		assert.match(await text(tools.pdf_info!, { path: path.join(a, "sample.pdf") }), /path must stay inside this job/);
	});
});

describe("settings parsing and UI", () => {
	it("normalizes explicit mode/folders, preserves default OFF and rejects malformed policy", () => {
		const parsed = parseAgentSettingsBody({ fileAccess: { restricted: true, folders: [" ~/Study ", a, "~/Study"] } });
		assert.ok(parsed.ok);
		assert.deepEqual(parsed.settings.fileAccess, { restricted: true, folders: ["~/Study", a] });
		assert.deepEqual(parseAgentSettingsBody({ fileAccess: { folders: [a] } }), { ok: true, settings: { fileAccess: { restricted: false, folders: [a] } } });
		for (const bad of [null, [], "on", { restricted: "yes" }, { folders: "~/Study" }, { folders: ["Study"] }, { folders: [3] }, { restricted: true, folders: [a, "bad"] }, { restrictd: true }]) {
			assert.equal(parseAgentSettingsBody({ fileAccess: bad }).ok, false);
			assert.deepEqual(sanitizeUserSettings({ version: 1, agent: { fileAccess: bad } })?.agent?.fileAccess, { restricted: true, folders: [] });
		}
		assert.equal(expandFolder("~", home), home);
		assert.equal(expandFolder("~/StudyA", home), a);
		assert.throws(() => expandFolder("relative"), /Invalid file-access/);
	});
	it("UI composition preserves the switch, saved roots and unrelated agent preferences", () => {
		assert.ok(isFolderEntry("~/Study")); assert.ok(isFolderEntry("C:\\Users\\learner")); assert.ok(!isFolderEntry("relative"));
		const one = composeAddFolder({ tools: { pdf: false }, graphTools: { enabled: false } }, " ~/Study ");
		assert.deepEqual(one.fileAccess, { restricted: false, folders: ["~/Study"] });
		const on = composeFileRestriction(one, true);
		assert.deepEqual(composeAddFolder(on, "~/Study"), on);
		assert.deepEqual(composeAddFolder(on, "relative"), on);
		const empty = composeRemoveFolder(on, "~/Study");
		assert.deepEqual(empty.fileAccess, { restricted: true, folders: [] });
		assert.deepEqual(empty.tools, one.tools);
		assert.deepEqual(empty.graphTools, one.graphTools);
		assert.deepEqual(composeFileRestriction(on, false).fileAccess, { restricted: false, folders: ["~/Study"] });
	});
	it("SSR makes OFF, empty ON, editable folders and fail-closed errors explicit", () => {
		const render = (agent?: Parameters<typeof AgentSection>[0]["agent"], fileAccessError?: string) => renderToStaticMarkup(React.createElement(AgentSection, { agent, fileAccessError, models: undefined, graph: undefined, compaction: undefined, onSectionChange: () => {}, onModelsChange: () => {}, onCompactionChange: () => {} }));
		const off = render();
		assert.match(off, /Broad local source access/);
		assert.match(off, /aria-checked="false"[^>]*aria-label="Restrict to listed folders"/);
		const empty = render({ fileAccess: { restricted: true, folders: [] } });
		assert.match(empty, /Restricted: no folders allowed/);
		assert.match(empty, /aria-checked="true"[^>]*aria-label="Restrict to listed folders"/);
		const populated = render({ fileAccess: { restricted: true, folders: [a] } });
		assert.match(populated, />Only listed folders and subfolders\.<\/span>/);
		assert.doesNotMatch(populated, /Protected locations remain blocked/);
		assert.match(populated, /aria-checked="true"[^>]*aria-label="Restrict to listed folders"/);
		assert.match(render({ fileAccess: { restricted: false, folders: [a] } }), /file-access-remove/);
		const failed = render(undefined, "File-access configuration error: blocked");
		assert.match(failed, /file-access-config-error/);
		assert.match(failed, /aria-checked="true"[^>]*aria-label="Restrict to listed folders"/);
	});
});
