import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { it } from "node:test";
const { pickAttachmentPath } = createRequire(import.meta.url)("../electron/attachment-picker.cjs");

function fixture() {
	const win = {};
	const mainFrame = { url: "http://127.0.0.1:1234/" };
	const event = { sender: { mainFrame }, senderFrame: mainFrame };
	const calls: unknown[][] = [];
	const deps = {
		BrowserWindow: { fromWebContents: (sender: unknown) => sender === event.sender ? win : null },
		trustedAppWindows: new Set([win]), origin: "http://127.0.0.1:1234",
		dialog: { showOpenDialog: async (...args: unknown[]) => { calls.push(args); return { canceled: false, filePaths: ["/course/empty folder"] }; } },
	};
	return { win, mainFrame, event, deps, calls };
}

it("native attachment picker owns the dialog parent/options and returns ONE original directory path without enumeration", async () => {
	const f = fixture();
	assert.equal(await pickAttachmentPath(f.event, "folder", f.deps), "/course/empty folder");
	assert.deepEqual(f.calls, [[f.win, { properties: ["openDirectory"] }]]);
});
for (const [canceled, filePaths] of [[true, ["/ignored"]], [false, []]] as const) it(`native cancellation/empty result returns null (${canceled})`, async () => {
	const f = fixture();
	f.deps.dialog.showOpenDialog = async () => ({ canceled, filePaths: [...filePaths] });
	assert.equal(await pickAttachmentPath(f.event, "folder", f.deps), null);
});
for (const mode of [undefined, null, "files", "openDirectory", { mode: "folder" }, { properties: ["openFile"] }]) it(`rejects unsupported renderer mode ${JSON.stringify(mode)} before opening a dialog`, async () => {
	const f = fixture();
	await assert.rejects(pickAttachmentPath(f.event, mode, f.deps), /Unsupported attachment picker mode/);
	assert.deepEqual(f.calls, []);
});
for (const kind of ["unregistered window", "foreign origin", "subframe", "malformed origin", "unknown sender"] as const) it(`rejects ${kind} before opening a dialog`, async () => {
	const f = fixture();
	if (kind === "unregistered window") f.deps.trustedAppWindows.clear();
	if (kind === "foreign origin") f.mainFrame.url = "http://127.0.0.1:5678/";
	if (kind === "malformed origin") f.mainFrame.url = "not-a-url";
	if (kind === "subframe") f.event.senderFrame = { ...f.mainFrame };
	if (kind === "unknown sender") f.deps.BrowserWindow.fromWebContents = () => null;
	await assert.rejects(pickAttachmentPath(f.event, "folder", f.deps), /Untrusted desktop request/);
	assert.deepEqual(f.calls, []);
});
it("dialog errors propagate without manufacturing a path", async () => {
	const f = fixture();
	f.deps.dialog.showOpenDialog = async () => { throw new Error("fixture failure"); };
	await assert.rejects(pickAttachmentPath(f.event, "folder", f.deps), /fixture failure/);
});
it("production IPC registration supplies the owned windows and exact application origin", () => {
	const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
	assert.match(main, /ipcMain\.handle\("lh:attachment:pick", \(event, mode\) => pickAttachmentPath\(event, mode, \{\s*BrowserWindow, dialog, trustedAppWindows, origin: new URL\(url\)\.origin,/);
});
