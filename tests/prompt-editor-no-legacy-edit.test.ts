import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-prompt-no-legacy-edit-"));
process.env.LH_DATA_DIR = dataDir;

const { GET } = await import("../app/api/settings/prompts/route.ts");

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

it("does not report a prompt migration when settings contain no prompt edits", async () => {
	fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ version: 1, general: { autoUpdate: false } }));

	const response = await GET();
	assert.equal(response.status, 200);
	const result = await response.json() as { history: unknown[]; migrationNotice: boolean };
	assert.equal(result.migrationNotice, false);
	assert.deepEqual(result.history, []);
});
