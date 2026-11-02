import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const { Workspace, constrainBounds } = createRequire(import.meta.url)("../electron/workspace.cjs");
function fixture(t: { after(fn: () => void): void }) {
	const dir = mkdtempSync(path.join(tmpdir(), "lh-workspace-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "workspace.json");
	return { file, workspace: new Workspace(file) };
}
test("one view owns each session, duplicate open focuses it, and transfer retains pane identity", (t) => {
	const { workspace: ws } = fixture(t);
	const a = ws.newWindow(); ws.open(a.id, "session_a", "active");
	ws.open(a.id, "session_b", "beside");
	const b = ws.newWindow();
	const owner = ws.open(b.id, "session_a", "window");
	assert.equal(owner.id, a.id); assert.equal(ws.state.windows.length, 2);
	const pane = a.panes[0];
	const moved = ws.move(a.id, pane.id);
	assert.equal(moved.panes[0], pane); assert.equal(a.panes.length, 1);
	assert.equal(a.panes[0].sessionId, "session_b");
});
test("replacing inactive pane preserves draft and reading position across an atomic restart", (t) => {
	const { workspace: ws, file } = fixture(t);
	const w = ws.newWindow(); ws.open(w.id, "a", "active"); ws.open(w.id, "b", "beside");
	const q = { questionId: JSON.stringify(["message", 2, "tool:reused"]), text: JSON.stringify({ selected: [1], userThinking: "why?" }) };
	ws.save(w.id, { views: { a: { draft: "draft a", questionDraft: q, scrollTop: 123 } }, split: .6 });
	ws.open(w.id, "c", "beside"); ws.persist();
	const restored = new Workspace(file);
	assert.deepEqual(restored.state.views.a, { draft: "draft a", questionDraft: q, scrollTop: 123 });
	assert.equal(restored.state.windows[0].split, .6);
	assert.deepEqual(restored.state.windows[0].panes.map((p: { sessionId: string }) => p.sessionId), ["c", "b"]);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
});
test("view patches merge, explicit clear persists, and empty panes retain drafts", (t) => {
	const { workspace: ws } = fixture(t); const w = ws.newWindow(); const key = `pane:${w.panes[0].id}`;
	ws.save(w.id, { views: { [key]: { draft: "topic" } } });
	assert.equal(ws.snapshot(w.id).views[key].draft, "topic");
	ws.open(w.id, "a", "active");
	ws.save(w.id, { views: { a: { draft: "hello", scrollTop: 34 } } });
	ws.save(w.id, { views: { a: { draft: "", questionDraft: null } } });
	assert.deepEqual(ws.state.views.a, { draft: "", scrollTop: 34, questionDraft: null });
});
test("workspace rejects paths, foreign pane writes, foreign session writes, and invalid state without partial mutation", (t) => {
	const { workspace: ws } = fixture(t); const a = ws.newWindow(); const b = ws.newWindow();
	ws.open(b.id, "other", "active");
	for (const id of ["../secret", "https://example.com", "a/b"]) assert.throws(() => ws.open(a.id, id, "active"));
	assert.throws(() => ws.save(a.id, { views: { other: { draft: "overwrite" } } }));
	assert.throws(() => ws.save(a.id, { views: { [`pane:${b.panes[0].id}`]: { draft: "overwrite" } } }));
	assert.throws(() => ws.save(a.id, { split: .6, views: { a: { draft: 5 } } }));
	assert.equal(a.split, .5);
});
test("corrupt and unknown-version state opens empty; duplicate persisted assignments are rejected", (t) => {
	const { file } = fixture(t);
	for (const content of ["{broken", JSON.stringify({ version: 2, windows: [], views: {} })]) {
		writeFileSync(file, content); assert.deepEqual(new Workspace(file).state.windows, []);
	}
	const ws = new Workspace(file); const a = ws.newWindow(); ws.open(a.id, "same", "active");
	const b = ws.newWindow(); b.panes[0].sessionId = "same"; ws.persist();
	assert.deepEqual(new Workspace(file).state.windows, []);
});
test("keyboard overrides persist and invalid data cannot replace preferences", (t) => {
	const { file, workspace: ws } = fixture(t); const w = ws.newWindow();
	ws.save(w.id, { keyboardOverrides: '{"chat_find":"Mod+f"}' }); ws.persist();
	assert.equal(new Workspace(file).snapshot(w.id).keyboardOverrides, '{"chat_find":"Mod+f"}');
	assert.throws(() => ws.save(w.id, { keyboardOverrides: '{"chat_find":5}' }));
	ws.save(w.id, { keyboardOverrides: null }); assert.equal(ws.snapshot(w.id).keyboardOverrides, null);
});
test("missing displays and oversized windows restore inside primary work area", () => {
	const primary = { x: 0, y: 24, width: 1512, height: 958 };
	assert.deepEqual(constrainBounds({ x: -2000, y: 0, width: 1920, height: 1080 }, [primary], primary), primary);
	const second = { x: 1512, y: 0, width: 1920, height: 1080 };
	assert.deepEqual(constrainBounds({ x: 1600, y: 50, width: 1000, height: 700 }, [primary, second], primary), { x: 1600, y: 50, width: 1000, height: 700 });
});

test("asynchronous session creation targets its originating pane after focus changes", (t) => {
	const { workspace: ws } = fixture(t); const w = ws.newWindow();
	const original = w.panes[0].id;
	ws.open(w.id, "other", "beside");
	ws.open(w.id, "created", "active", original);
	assert.equal(w.panes.find((p: { id: string }) => p.id === original).sessionId, "created");
	assert.equal(w.panes[1].sessionId, "other");
	assert.throws(() => ws.open(w.id, "bad", "active", "unknown-pane"));
});
