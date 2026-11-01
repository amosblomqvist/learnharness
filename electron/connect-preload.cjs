/*
 * Preload for the "Connect to Server" window (electron/connect.html) only.
 * Channel names are mirrored in electron/main.cjs — keep them in sync.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lhConnect", {
	current: () => ipcRenderer.invoke("lh:connect:current"),
	connect: (address, allowInsecure) => ipcRenderer.invoke("lh:connect:save", address, allowInsecure === true),
	useLocal: () => ipcRenderer.invoke("lh:connect:local"),
	close: () => ipcRenderer.send("lh:connect:close"),
});
