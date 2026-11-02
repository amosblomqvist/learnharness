/**
 * Every store save is all-or-nothing (#403). For each store, the save is
 * made to fail at the rename, the step where new bytes replace old ones:
 * the save must throw and the file on disk must be exactly what it was,
 * with no temp file left. Stores that write in place would never reach
 * the rename, so their saves would succeed and this test would fail. Runs
 * under its own isolated LH_DATA_DIR (set before any config-loading import).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it, type TestContext } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-store-writes-atomic-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");

const config = await import("../config.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { writeRenderSettings } = await import("../src/store/render-settings.ts");
const { ensureGraphFormat } = await import("../src/store/graph-format.ts");
const { promptOverrides } = await import("../src/store/prompt-overrides.ts");
const { authStore } = await import("../src/store/auth.ts");
const { sourceOrganizationStore } = await import("../src/store/source-organization.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const snapshot = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null);

/** Seed `file` with one good save, then make the next save's rename fail. */
function assertAllOrNothing(t: TestContext, file: string, seed: () => void, save: () => void): void {
	seed();
	const before = snapshot(file);
	t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("fixture I/O failure"), { code: "EIO" }); });
	assert.throws(save, { code: "EIO" });
	t.mock.restoreAll();
	assert.equal(snapshot(file), before, "the old file is untouched");
	assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp-")), [], "no temp file left");
}

describe("failed saves leave the old file whole", () => {
	it("chat", (t) => {
		const { id } = chatStore.createChat("atomic");
		assertAllOrNothing(t, path.join(config.PATHS.chats, `${id}.json`),
			() => chatStore.saveMessages(id, [{ role: "user", content: "old", timestamp: 1 }] as never),
			() => chatStore.saveMessages(id, [{ role: "user", content: "new", timestamp: 2 }] as never));
	});

	it("job", (t) => {
		assertAllOrNothing(t, path.join(config.PATHS.data, "jobs", "unborn.json"), () => {},
			() => jobStore.createJob({ kind: "research", chatId: "chat_atomic", toolCallId: "tc_unborn" }));
		const job = jobStore.createJob({ kind: "research", chatId: "chat_atomic", toolCallId: "tc_atomic" });
		assertAllOrNothing(t, path.join(config.PATHS.data, "jobs", `${job.id}.json`), () => {}, () => jobStore.updateJob(job.id, { status: "done" }));
	});

	it("settings", (t) => {
		assertAllOrNothing(t, config.SETTINGS_FILE,
			() => writeSettings({ version: 1, appearance: { mode: "light" } }),
			() => writeSettings({ version: 1, appearance: { mode: "dark" } }));
	});

	it("notes sources: import and delete", (t) => {
		const source = (id: string) => ({ id, filePath: `/notes/${id}.md`, importedAt: "2026-10-31T00:00:00.000Z" });
		assertAllOrNothing(t, config.SOURCES_FILE, () => graphStore.upsertSource(source("src_a")), () => graphStore.upsertSource(source("src_b")));
		assertAllOrNothing(t, config.SOURCES_FILE, () => {}, () => graphStore.deleteSources(new Set(["src_a"])));
	});

	it("graph render settings", (t) => {
		assertAllOrNothing(t, config.RENDER_SETTINGS_FILE, () => writeRenderSettings({}), () => writeRenderSettings({ linkDistance: 80 }));
	});

	it("graph format stamp", (t) => {
		fs.rmSync(config.GRAPH_FORMAT_FILE, { force: true });
		assertAllOrNothing(t, config.GRAPH_FORMAT_FILE, () => {}, () => ensureGraphFormat());
	});

	it("graph positions and ledgers", (t) => {
		assertAllOrNothing(t, config.POSITIONS_FILE, () => graphStore.writePositions({ a: { x: 1, y: 1 } }), () => graphStore.writePositions({ a: { x: 2, y: 2 } }));
		assertAllOrNothing(t, config.LEDGER_FILES.chains, () => graphStore.rewriteLedgers({ chains: [] }), () => graphStore.rewriteLedgers({ chains: [] }));
	});

	it("source organization", (t) => {
		assertAllOrNothing(t, config.SOURCE_ORGANIZATION_FILE,
			() => sourceOrganizationStore.write({ version: 1, folders: [], placements: {} }),
			() => sourceOrganizationStore.write({ version: 1, folders: [{ id: "fld_a", name: "A", parentId: null, createdAt: "2026-10-31T00:00:00.000Z" }], placements: {} }));
	});

	it("prompt edit", (t) => {
		assertAllOrNothing(t, path.join(config.PROMPTS_OVERRIDE_DIR, "system-prompt.md"),
			() => promptOverrides.writeOverride("system-prompt.md", "old prompt"),
			() => promptOverrides.writeOverride("system-prompt.md", "new prompt"));
	});

	it("auth keys", (t) => {
		assertAllOrNothing(t, config.AUTH_FILE, () => authStore.setAuthVar("KEEP", "old"), () => authStore.setAuthVar("KEEP", "new"));
	});
});
