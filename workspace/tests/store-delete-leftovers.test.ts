/**
 * Deletes clear crash leftovers (#403): crashes mid-save can leave
 * `<file>.tmp-<uuid>` beside records, holding their newest bytes. Deleting
 * the record must not leave that copy behind. Runs under its own isolated
 * LH_DATA_DIR (set before any config-loading import).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-delete-leftovers-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { PATHS, SOURCES_FILE, PROMPTS_OVERRIDE_DIR, LEDGER_FILES } = await import("../config.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { promptOverrides } = await import("../src/store/prompt-overrides.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

/** Stand in for crashes: leftover temp copies beside `file`. */
function leaveCrashCopy(file: string): void {
	fs.copyFileSync(file, `${file}.tmp-crash`);
}
const leftovers = (dir: string) => fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));

describe("deleting records removes their crash leftovers", () => {
	it("sessions", () => {
		const chat = chatStore.createChat("doomed");
		leaveCrashCopy(path.join(PATHS.chats, `${chat.id}.json`));
		const keep = chatStore.createChat("kept");
		leaveCrashCopy(path.join(PATHS.chats, `${keep.id}.json`));
		assert.equal(chatStore.deleteChat(chat.id), true);
		assert.deepEqual(leftovers(PATHS.chats), [`${keep.id}.json.tmp-crash`], "only the deleted session's leftover goes");
	});

	it("session jobs", () => {
		const chat = chatStore.createChat("with jobs");
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc_leftover" });
		const jobsDir = path.join(PATHS.data, "jobs");
		leaveCrashCopy(path.join(jobsDir, `${job.id}.json`));
		assert.equal(jobStore.deleteJobsForChat(chat.id), 1);
		assert.deepEqual(leftovers(jobsDir), []);
	});

	it("notes sources", () => {
		graphStore.upsertSource({ id: "src_doomed", filePath: "/notes/doomed.md", importedAt: "2026-10-31T00:00:00.000Z" });
		leaveCrashCopy(SOURCES_FILE);
		assert.equal(graphStore.deleteSources(new Set(["src_doomed"])), 1);
		assert.deepEqual(leftovers(path.dirname(SOURCES_FILE)), []);
	});

	it("graph records purged by session or source deletes", () => {
		graphStore.rewriteLedgers({ coverage: [] });
		fs.writeFileSync(`${LEDGER_FILES.coverage}.tmp-crash`, "purged row\n");
		graphStore.rewriteLedgers({ coverage: [] });
		assert.deepEqual(leftovers(path.dirname(LEDGER_FILES.coverage)), []);
	});

	it("prompt edits", () => {
		promptOverrides.writeOverride("system-prompt.md", "custom base");
		leaveCrashCopy(path.join(PROMPTS_OVERRIDE_DIR, "system-prompt.md"));
		promptOverrides.deleteOverride("system-prompt.md");
		assert.deepEqual(leftovers(PROMPTS_OVERRIDE_DIR), []);
	});
});
