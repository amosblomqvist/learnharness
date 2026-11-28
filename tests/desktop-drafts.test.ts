import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createDraftStore } = require("../electron/drafts.cjs");

test("desktop batches edits, restores separate drafts after restart and flushes on quit", t => {
	const root = mkdtempSync(join(tmpdir(), "lh-drafts-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const directory = join(root, "drafts");
	const open = () => createDraftStore(directory, (error: unknown) => { throw error; });
	const first = open();
	first.write("chat:a:composer", "Half");
	t.mock.timers.tick(400);
	first.write("chat:a:composer", "Half a thought\n— still writing");
	first.write("chat:b:question:1", "Separate answer");
	assert.equal(first.read("chat:a:composer"), "Half a thought\n— still writing");
	assert.equal(first.read("chat:b:question:1"), "Separate answer");
	t.mock.timers.tick(799);
	assert.equal(existsSync(directory), false);
	t.mock.timers.tick(1);
	assert.equal(readdirSync(directory).length, 2);
	const resumed = open();
	assert.equal(resumed.read("chat:a:composer"), "Half a thought\n— still writing");
	assert.equal(resumed.read("chat:b:question:1"), "Separate answer");
	resumed.write("chat:a:composer", "");
	resumed.write("home:composer", "Just typed before quit");
	resumed.flush();
	const restarted = open();
	assert.equal(restarted.read("chat:a:composer"), "");
	assert.equal(restarted.read("chat:b:question:1"), "Separate answer");
	assert.equal(restarted.read("home:composer"), "Just typed before quit");
});
