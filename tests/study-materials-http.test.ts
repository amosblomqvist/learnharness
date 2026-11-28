import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("material HTTP access validates intent, keeps credentials private and prepares only selected text", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "lh-material-http-"));
	const saved = { auth: process.env.LH_AUTH_FILE, data: process.env.LH_DATA_DIR, desktop: process.env.LH_DESKTOP_SERVER, secret: process.env.LH_DESKTOP_API_SECRET };
	process.env.LH_AUTH_FILE = path.join(root, "auth.json"); process.env.LH_DATA_DIR = path.join(root, "data"); delete process.env.LH_DESKTOP_SERVER; delete process.env.LH_DESKTOP_API_SECRET;
	try {
		const vault = path.join(root, "vault"); await fs.mkdir(vault); await fs.writeFile(path.join(vault, "Lesson.md"), "# Exact source\nDefinitions for the learner.");
		const { studyMaterialsResponse } = await import("../src/server/study-materials-http.ts");
		const req = (body: object, origin = "http://localhost:3000", intent = true) => new Request("http://localhost:3000/api/materials", { method: "POST", headers: { origin, "Content-Type": "application/json", ...(intent ? { "x-learnharness-materials": "1" } : {}) }, body: JSON.stringify(body) });
		assert.equal((await studyMaterialsResponse(req({ op: "status" }, "https://other.test"))).status, 403);
		assert.equal((await studyMaterialsResponse(req({ op: "status" }, undefined, false))).status, 403);
		const token = "synthetic-token-never-return";
		const configured = await studyMaterialsResponse(req({ op: "configure", obsidianRoot: vault, notionToken: token }));
		assert.equal(configured.status, 200); const publicStatus = await configured.text(); assert(!publicStatus.includes(token)); assert(publicStatus.includes('"notionConfigured":true'));
		const status = await (await studyMaterialsResponse(req({ op: "status" }))).text(); assert(!status.includes(token));
		const listed = await (await studyMaterialsResponse(req({ op: "list", source: "obsidian" }))).json(); assert.equal(listed.entries[0].title, "Lesson.md");
		const prepared = await (await studyMaterialsResponse(req({ op: "prepare", materials: [{ source: "obsidian", id: "Lesson.md" }] }))).json();
		assert.equal(prepared.materials[0].text, "# Exact source\nDefinitions for the learner.");
		assert.equal((await studyMaterialsResponse(req({ op: "prepare", materials: [] }))).status, 400);
		const bad = await studyMaterialsResponse(req({ op: "configure", notionToken: "private\nheader-injection" })); assert.equal(bad.status, 400); assert(!(await bad.text()).includes("header-injection"));
		await studyMaterialsResponse(req({ op: "configure", clearNotion: true }));
		assert.equal((await (await studyMaterialsResponse(req({ op: "status" }))).json()).notionConfigured, false);
		process.env.LH_DESKTOP_SERVER = "1";
		assert.equal((await studyMaterialsResponse(req({ op: "status" }))).status, 403);
	} finally {
		for (const [key, value] of [["LH_AUTH_FILE", saved.auth], ["LH_DATA_DIR", saved.data], ["LH_DESKTOP_SERVER", saved.desktop], ["LH_DESKTOP_API_SECRET", saved.secret]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
		assert.equal(await fs.realpath(path.dirname(root)), await fs.realpath(os.tmpdir())); await fs.rm(root, { recursive: true, force: true });
	}
});
