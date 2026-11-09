import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-prompt-editor-"));
process.env.LH_DATA_DIR = dataDir;

// Configuration captures LH_DATA_DIR at import time, so load app modules after setting the isolated data root.
const { GET, PUT } = await import("../app/api/settings/prompts/route.ts");
const historyRoute = await import("../app/api/settings/prompts/history/route.ts");
const { composePrompt, PROMPT_EDITOR_IDS } = await import("../src/core/prompt-editor.ts");

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function request(method: string, body?: unknown): Request {
	return new Request("http://test/api/settings/prompts", {
		method,
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function editors() {
	const response = await GET();
	assert.equal(response.status, 200);
	return response.json() as Promise<{
		editors: Record<(typeof PROMPT_EDITOR_IDS)[number], { text: string; defaultText: string }>;
		history: Array<{ id: string; editor: (typeof PROMPT_EDITOR_IDS)[number]; text: string; savedAt: string }>;
	}>;
}

it("saves editable prompt text, composes it for the right roles, and restores a saved version", async () => {
	const initial = await editors();
	assert.deepEqual(Object.keys(initial.editors).sort(), [...PROMPT_EDITOR_IDS].sort());
	assert.deepEqual(initial.history, []);

	const commonSave = await PUT(request("PUT", { editor: "common", text: "CUSTOM COMMON TEXT" }));
	assert.equal(commonSave.status, 200);
	const commonVersion = (await commonSave.json()) as { versionId: string };

	const sharedSave = await PUT(request("PUT", { editor: "proberTeacherShared", text: "CUSTOM TEACHING TEXT" }));
	assert.equal(sharedSave.status, 200);

	const current = await editors();
	assert.equal(current.editors.common.text, "CUSTOM COMMON TEXT");
	assert.equal(current.editors.proberTeacherShared.text, "CUSTOM TEACHING TEXT");
	assert.equal(current.history.length, 2);

	const text = Object.fromEntries(PROMPT_EDITOR_IDS.map((id) => [id, current.editors[id].text])) as Record<(typeof PROMPT_EDITOR_IDS)[number], string>;
	const prober = composePrompt("prober", text);
	const teacher = composePrompt("teacher", text);
	const practice = composePrompt("practice", text);
	assert.ok(prober.includes("CUSTOM TEACHING TEXT"));
	assert.ok(teacher.includes("CUSTOM TEACHING TEXT"));
	assert.ok(!practice.includes("CUSTOM TEACHING TEXT"));
	for (const prompt of [prober, teacher, practice]) assert.ok(prompt.includes("CUSTOM COMMON TEXT"));
	assert.ok(prober.indexOf("CUSTOM TEACHING TEXT") < prober.indexOf("CUSTOM COMMON TEXT"));

	const restore = await historyRoute.POST(request("POST", { editor: "common", versionId: commonVersion.versionId }));
	assert.equal(restore.status, 200);
	assert.equal((await editors()).editors.common.text, "CUSTOM COMMON TEXT");
});

it("resets to shipped default without storing the default as a user version", async () => {
	const initial = await editors();
	const defaultText = initial.editors.practice.defaultText;
	await PUT(request("PUT", { editor: "practice", text: "CUSTOM PRACTICE TEXT" }));
	const beforeReset = await editors();
	const historyBeforeReset = beforeReset.history.length;

	const reset = await PUT(request("PUT", { editor: "practice", text: defaultText }));
	assert.equal(reset.status, 200);
	const afterReset = await editors();
	assert.equal(afterReset.editors.practice.text, defaultText);
	assert.equal(afterReset.history.length, historyBeforeReset);
});
