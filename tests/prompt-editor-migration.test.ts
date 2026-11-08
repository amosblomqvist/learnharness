import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-prompt-migration-"));
process.env.LH_DATA_DIR = dataDir;

const { GET } = await import("../app/api/settings/prompts/route.ts");

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

it("preserves active prompt edits and archives disabled edits without deleting their files", async () => {
	const promptDir = path.join(dataDir, "prompts");
	const proberPath = path.join(promptDir, "prober", "10-probe-doctrine.md");
	const teacherPath = path.join(promptDir, "teacher", "05-method.md");
	fs.mkdirSync(path.dirname(proberPath), { recursive: true });
	fs.mkdirSync(path.dirname(teacherPath), { recursive: true });
	fs.writeFileSync(proberPath, "ACTIVE LEGACY PROBER EDIT");
	fs.writeFileSync(teacherPath, "DISABLED LEGACY TEACHER EDIT");
	fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({
		version: 1,
		agent: { prompts: { "prober/10-probe-doctrine.md": true, "teacher/05-method.md": false } },
	}));

	const response = await GET();
	assert.equal(response.status, 200);
	const result = await response.json() as {
		editors: Record<string, { text: string }>;
		history: Array<{ editor: string; text: string }>;
		migrationNotice: boolean;
	};
	assert.equal(result.migrationNotice, true);
	assert.ok(result.editors.prober?.text.includes("ACTIVE LEGACY PROBER EDIT"));
	assert.ok(!result.editors.teacher?.text.includes("DISABLED LEGACY TEACHER EDIT"));
	assert.ok(result.history.some((entry) => entry.editor === "teacher" && entry.text.includes("DISABLED LEGACY TEACHER EDIT")));
	assert.equal(fs.readFileSync(proberPath, "utf-8"), "ACTIVE LEGACY PROBER EDIT");
	assert.equal(fs.readFileSync(teacherPath, "utf-8"), "DISABLED LEGACY TEACHER EDIT");

	const repeated = await GET();
	const repeatedResult = await repeated.json() as { history: unknown[] };
	assert.equal(repeatedResult.history.length, result.history.length);
});
