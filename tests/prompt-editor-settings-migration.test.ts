import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-prompt-settings-migration-"));
process.env.LH_DATA_DIR = dataDir;

const { GET: getSettings } = await import("../app/api/settings/route.ts");
const { GET: getPrompts } = await import("../app/api/settings/prompts/route.ts");

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

it("migrates active prompt edits when the app first reads settings", async () => {
	const proberPath = path.join(dataDir, "prompts", "prober", "10-probe-doctrine.md");
	fs.mkdirSync(path.dirname(proberPath), { recursive: true });
	fs.writeFileSync(proberPath, "ACTIVE LEGACY PROBER EDIT");
	fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({
		version: 1,
		agent: { prompts: { "prober/10-probe-doctrine.md": true } },
	}));

	assert.equal((await getSettings()).status, 200);
	const response = await getPrompts();
	const result = await response.json() as { editors: Record<string, { text: string }> };
	assert.ok(result.editors.prober?.text.includes("ACTIVE LEGACY PROBER EDIT"));
});
