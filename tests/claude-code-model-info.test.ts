/**
 * Concrete model labels for Claude Code aliases: the CLI's `initialize`
 * response (src/agent/claude-code/model-info.ts), the server cache
 * (src/server/claude-code-models.ts) and the catalog DTO / picker label.
 *
 * initialize-models.json is trimmed from a real Claude Code 2.1.323
 * `initialize` control response.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, test } from "node:test";

import { createAssistantMessageEventStream, createModels } from "@earendil-works/pi-ai";

const testData = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-model-info-"));
process.env.LH_DATA_DIR = testData;
after(() => fs.rmSync(testData, { recursive: true, force: true }));

const { CLAUDE_CODE_PROVIDER } = await import("../src/agent/claude-code/constants.ts");
const { claudeCodeModel, createClaudeCodeProvider } = await import("../src/agent/claude-code/provider.ts");
const { parseInitializeModels, readClaudeModels } = await import("../src/agent/claude-code/model-info.ts");
const { claudeModelVersionLabel } = await import("../src/core/contracts/claude-code.ts");
const { claudeCodeExtraModels, claudeCodeModelInfo, refreshClaudeCodeModels, resetClaudeCodeModels } = await import("../src/server/claude-code-models.ts");
const { toModelDto } = await import("../src/server/model-catalog.ts");
const { modelLabel } = await import("../components/usage-format.ts");

const INITIALIZE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures/claude-code/initialize-models.json"), "utf8"));

function claudeModel(id: string) {
	const collection = createModels();
	collection.setProvider(createClaudeCodeProvider(() => createAssistantMessageEventStream()));
	const model = collection.getModels(CLAUDE_CODE_PROVIDER).find((m) => m.id === id);
	assert.ok(model);
	return model;
}

beforeEach(() => resetClaudeCodeModels());

test("parseInitializeModels keeps every alias the CLI resolves, with its own display name", () => {
	const rows = parseInitializeModels(INITIALIZE);
	const byAlias = new Map(rows.map((row) => [row.alias, row]));
	assert.deepEqual(byAlias.get("opus"), { alias: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" });
	assert.deepEqual(byAlias.get("sonnet"), { alias: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" });
	assert.deepEqual(byAlias.get("haiku"), { alias: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5" });
});

test("parseInitializeModels skips rows without a resolved ID and tolerates odd bodies", () => {
	assert.deepEqual(parseInitializeModels({ models: [{ value: "opus", displayName: "Opus" }, null, { resolvedModel: "x" }] }), []);
	assert.deepEqual(parseInitializeModels({}), []);
	assert.deepEqual(parseInitializeModels(null), []);
	assert.deepEqual(parseInitializeModels({ models: "nope" }), []);
});

test("claudeModelVersionLabel reads family and version from a canonical ID", () => {
	assert.equal(claudeModelVersionLabel("claude-opus-5-5"), "Opus 5.5");
	assert.equal(claudeModelVersionLabel("claude-sonnet-5"), "Sonnet 5");
	assert.equal(claudeModelVersionLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
	assert.equal(claudeModelVersionLabel("opus"), null);
	assert.equal(claudeModelVersionLabel("gpt-5"), null);
});

/** A stand-in CLI: answers initialize per FAKE_CLI_MODE and ignores the real flags. */
const FAKE_CLI = `
const mode = process.env.FAKE_CLI_MODE;
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const msg = JSON.parse(line);
	if (mode === "silent") return;
	if (mode === "wrong-id") msg.request_id = "other";
	process.stdout.write("not json\\n");
	process.stdout.write(JSON.stringify({ type: "control_response", response: { request_id: msg.request_id, subtype: mode === "error" ? "error" : "success", response: ${JSON.stringify(INITIALIZE)} } }) + "\\n");
});
setInterval(() => {}, 60000);
`;

function fakeSpawn(mode: string, seen?: { args?: string[]; stdin?: string }) {
	return ((_cmd: string, args: string[], options: object) => {
		if (seen) seen.args = args;
		const child = spawn(process.execPath, ["-e", FAKE_CLI], { ...options, env: { ...process.env, FAKE_CLI_MODE: mode } });
		if (seen) {
			const write = child.stdin.write.bind(child.stdin);
			child.stdin.write = ((chunk: string, ...rest: never[]) => { seen.stdin = (seen.stdin ?? "") + chunk; return write(chunk, ...rest); }) as typeof child.stdin.write;
		}
		return child;
	}) as never;
}

test("readClaudeModels sends only initialize and returns the CLI's model rows", async () => {
	const seen: { args?: string[]; stdin?: string } = {};
	const rows = await readClaudeModels("claude", { spawnProcess: fakeSpawn("ok", seen) });
	assert.equal(rows.find((row) => row.alias === "opus")?.resolvedModel, "claude-opus-5-5");
	assert.ok(seen.args?.includes("--no-session-persistence"));
	const sent = (seen.stdin ?? "").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, "control_request");
	assert.equal(sent[0].request.subtype, "initialize");
});

test("readClaudeModels returns [] on an error response, a foreign request id, or a timeout", async () => {
	assert.deepEqual(await readClaudeModels("claude", { spawnProcess: fakeSpawn("error") }), []);
	assert.deepEqual(await readClaudeModels("claude", { spawnProcess: fakeSpawn("wrong-id"), timeoutMs: 300 }), []);
	assert.deepEqual(await readClaudeModels("claude", { spawnProcess: fakeSpawn("silent"), timeoutMs: 300 }), []);
	assert.deepEqual(await readClaudeModels(path.join(testData, "missing-claude")), []);
});

test("refreshClaudeCodeModels caches per binary for ten minutes and shares one read", async () => {
	let reads = 0;
	let clock = 0;
	const read = async () => { reads++; return parseInitializeModels(INITIALIZE); };
	await Promise.all([
		refreshClaudeCodeModels(read, () => true, () => "/bin/claude", () => clock),
		refreshClaudeCodeModels(read, () => true, () => "/bin/claude", () => clock),
	]);
	assert.equal(reads, 1);
	assert.equal(claudeCodeModelInfo("sonnet")?.resolvedModel, "claude-sonnet-5-5");
	clock = 9 * 60_000;
	await refreshClaudeCodeModels(read, () => true, () => "/bin/claude", () => clock);
	assert.equal(reads, 1);
	clock = 11 * 60_000;
	await refreshClaudeCodeModels(read, () => true, () => "/bin/claude", () => clock);
	assert.equal(reads, 2);
	await refreshClaudeCodeModels(read, () => true, () => "/other/claude", () => clock);
	assert.equal(reads, 3);
});

test("refreshClaudeCodeModels does nothing while Claude Code is off or not installed", async () => {
	let reads = 0;
	const read = async () => { reads++; return []; };
	await refreshClaudeCodeModels(read, () => false, () => "/bin/claude");
	await refreshClaudeCodeModels(read, () => true, () => null);
	assert.equal(reads, 0);
});

test("toModelDto labels each alias with the version the CLI reported, and modelLabel shows it", async () => {
	await refreshClaudeCodeModels(async () => parseInitializeModels(INITIALIZE), () => true, () => "/bin/claude");
	for (const [alias, label, id] of [["opus", "Opus 5.5", "claude-opus-5-5"], ["sonnet", "Sonnet 5.5", "claude-sonnet-5-5"], ["haiku", "Haiku 5.5", "claude-haiku-5-5"]] as const) {
		const dto = toModelDto(claudeModel(alias));
		assert.equal(dto.id, alias, "the alias stays the selection key");
		assert.equal(dto.name, `Claude ${label}`);
		assert.equal(dto.resolvedModel, id);
		assert.equal(dto.resolvedLabel, label);
		assert.equal(modelLabel(alias, dto), label);
	}
});

test("without a CLI report the alias label is unchanged", () => {
	const dto = toModelDto(claudeModel("opus"));
	assert.equal(dto.name, "Claude Opus");
	assert.equal(dto.resolvedModel, undefined);
	assert.equal(dto.resolvedLabel, undefined);
	assert.equal(modelLabel("opus", dto), "opus");
	assert.equal(modelLabel("opus"), "opus");
});

test("a row without a display name falls back to the canonical ID's version", async () => {
	await refreshClaudeCodeModels(async () => [{ alias: "opus", resolvedModel: "claude-opus-6" }], () => true, () => "/bin/claude");
	assert.equal(toModelDto(claudeModel("opus")).resolvedLabel, "Opus 6");
});

test("claudeCodeModel keeps the listed aliases and synthesizes other CLI names", () => {
	assert.equal(claudeCodeModel("opus")?.name, "Claude Opus");
	const mythos = claudeCodeModel("claude-mythos-5-2", "Claude Mythos 5.2");
	assert.equal(mythos?.id, "claude-mythos-5-2");
	assert.equal(mythos?.provider, CLAUDE_CODE_PROVIDER);
	assert.equal(mythos?.name, "Claude Mythos 5.2");
	assert.equal(claudeCodeModel("fable")?.name, "fable");
	for (const bad of ["", "--dangerously-skip-permissions", "-p", "Opus", "claude mythos", "claude-x;rm", "../x"]) {
		assert.equal(claudeCodeModel(bad), undefined, bad);
	}
});

test("claudeCodeExtraModels lists what the CLI reported beyond the three aliases", async () => {
	assert.deepEqual(claudeCodeExtraModels(), [], "nothing before the CLI answers");
	await refreshClaudeCodeModels(async () => parseInitializeModels(INITIALIZE), () => true, () => "/bin/claude");
	const extras = claudeCodeExtraModels();
	assert.deepEqual(extras.map((m) => m.id), ["fable", "claude-haiku-4-5-20251001"], "other aliases first, no default, no duplicates of opus/sonnet/haiku");
	assert.deepEqual(extras.map((m) => m.name), ["Claude Fable 5.2", "Claude Haiku 4.5"]);
	const fable = toModelDto(extras[0]!);
	assert.equal(fable.resolvedModel, "claude-fable-5-2");
	assert.equal(fable.resolvedLabel, "Fable 5.2");
	const haiku45 = toModelDto(extras[1]!);
	assert.equal(haiku45.resolvedModel, undefined, "a full ID has no separate target");
	assert.equal(haiku45.resolvedLabel, "Haiku 4.5");
});
