"use strict";
const { trustedSender } = require("./chatgpt-ipc.cjs");

/** Path reference only: fixed directory-only dialog, no enumeration or access grant.
 * Keep the mode whitelist and all trust checks in the main process. */
async function pickAttachmentPath(event, mode, { BrowserWindow, dialog, trustedAppWindows, origin }) {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (!trustedAppWindows.has(win) || !trustedSender(event, origin, BrowserWindow)) throw new Error("Untrusted desktop request.");
	if (mode !== "folder") throw new Error("Unsupported attachment picker mode.");
	const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
	return result.canceled ? null : result.filePaths[0] ?? null;
}

module.exports = { pickAttachmentPath };
