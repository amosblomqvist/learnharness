/**
 * Claude Code turn files left behind. Each turn writes the system prompt and
 * an MCP config, with the loopback bridge's bearer token, into two temp
 * folders and removes them when the turn closes. A turn the app never
 * finishes (stopped mid-turn) leaves them for good. The first turn a process
 * starts removes turn folders more than a day old.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, describe, it } from "node:test";

// Every turn folder this file makes lands here, not in the real temp folder:
// os.tmpdir() reads TMPDIR on Unix and TEMP or TMP on Windows, per call.
const temp = mkdtempSync(join(tmpdir(), "lh-turn-sweep-"));
for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = temp;
after(() => rmSync(temp, { recursive: true, force: true }));

const { normalizeContext } = await import("@earendil-works/pi-ai/utils/transcript");
const { CLAUDE_CODE_MODELS } = await import("../src/agent/claude-code/provider.ts");
const { createClaudeCodeStreamFunction } = await import("../src/agent/claude-code/stream.ts");
const { STALE_TURN_MS, sweepStaleTurnFiles, sweepStaleTurnFilesOnce } = await import("../src/agent/claude-code/turn-files.ts");

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 16, 12);

/** A turn folder (or any folder) with one file, last modified `ageMs` before NOW. */
function folder(parent: string, name: string, ageMs: number): string {
	const dir = join(parent, name);
	mkdirSync(dir);
	writeFileSync(join(dir, "mcp.json"), '{"fixture":true}\n');
	const when = new Date(NOW - ageMs);
	utimesSync(dir, when, when);
	return dir;
}

function scratch(): string {
	return mkdtempSync(join(temp, "case-"));
}

describe("sweeping stale Claude Code turn files", () => {
	it("Given both turn folders from a turn stopped two days ago, When swept, Then both are removed with their files", async () => {
		const dir = scratch();
		folder(dir, "claude-code-cwd-8WQjvh", 2 * DAY);
		folder(dir, "claude-code-private-5Qu8v0", 2 * DAY);

		const removed = await sweepStaleTurnFiles(dir, NOW);

		assert.deepEqual(removed.sort(), ["claude-code-cwd-8WQjvh", "claude-code-private-5Qu8v0"]);
		assert.deepEqual(readdirSync(dir), []);
	});

	it("Given a turn folder younger than a day (a turn still running, perhaps in another instance), When swept, Then it stays", async () => {
		const dir = scratch();
		folder(dir, "claude-code-private-wJAQ0A", STALE_TURN_MS - 60_000);

		assert.deepEqual(await sweepStaleTurnFiles(dir, NOW), []);
		assert.deepEqual(readdirSync(dir), ["claude-code-private-wJAQ0A"]);
	});

	it("Given old entries that are not turn folders, When swept, Then none of them is touched", async () => {
		const dir = scratch();
		folder(dir, "claude-code-cache", 2 * DAY); // no mkdtemp suffix
		folder(dir, "claude-code-private-toolong1", 2 * DAY); // suffix is not mkdtemp's six characters
		folder(dir, "other-claude-code-cwd-abcdef", 2 * DAY);
		const file = join(dir, "claude-code-cwd-file01");
		writeFileSync(file, "a file, not a folder");
		utimesSync(file, new Date(NOW - 2 * DAY), new Date(NOW - 2 * DAY));
		const target = folder(dir, "kept-target", 2 * DAY);
		symlinkSync(target, join(dir, "claude-code-cwd-link01"), "junction");

		assert.deepEqual(await sweepStaleTurnFiles(dir, NOW), []);
		assert.ok(existsSync(join(target, "mcp.json")), "a link's target is never followed");
		assert.equal(readdirSync(dir).length, 6);
	});

	it("Given a temp folder that cannot be read, When swept, Then nothing is removed and nothing is thrown", async () => {
		assert.deepEqual(await sweepStaleTurnFiles(join(temp, "missing"), NOW), []);
	});

	it("Given stale turn folders in the temp folder, When the process starts its first turn, Then they are gone", async () => {
		const stale = folder(temp, "claude-code-private-AbC123", 2 * DAY + (Date.now() - NOW));
		const model = CLAUDE_CODE_MODELS[0]!;
		const context = normalizeContext({ systemPrompt: "You are a tutor.", messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [] });
		const refuse = () => { throw new Error("no CLI in this test"); };

		for await (const event of createClaudeCodeStreamFunction(refuse)(model, context, {})) void event;
		for (let waited = 0; existsSync(stale) && waited < 5000; waited += 50) await sleep(50); // the turn does not wait for the sweep

		assert.equal(existsSync(stale), false, "the turn swept the temp folder");
		assert.ok((await sweepStaleTurnFilesOnce()).includes("claude-code-private-AbC123"));
		assert.equal(sweepStaleTurnFilesOnce(), sweepStaleTurnFilesOnce(), "one sweep per process");
	});
});
