/*
 * Preload (2026-09-17, narrow-window wave): the ONLY bridge between the
 * sandboxed renderer and the main process. contextIsolation + sandbox are
 * on (electron/main.cjs), so this file is the renderer's entire access to
 * Electron — keep it a minimal, explicit API surface.
 *
 *   window.lh.platform — read-only OS identity for native window-control
 *   gutters (darwin: left traffic lights; win32/linux: right overlay).
 *
 *   window.lh.expandWindow() — widen the window to the sidebar auto-close
 *   threshold (928px) when the sidebar is opened below it. The main
 *   process clamps: no-op if the window is already wide enough.
 *
 *   window.lh.onZoom(cb) / window.lh.getZoom() — the zoom truth (owner
 *   round 7, 2026-10-05): every ⌘±/⌘0 change arrives as "lh:zoom" with
 *   the new factor; getZoom covers the first-paint race. The renderer
 *   publishes it as --lh-zoom so physical-constant lengths (the traffic-
 *   light gutter) can divide by it.
 *
 *   window.lh.onUpdateStatus(cb) / window.lh.installUpdate() — the
 *   auto-update channel (Wave C, 2026-10-10): "lh:update-status" pushes
 *   {status:"downloaded", version} once an update is staged; installUpdate
 *   asks main to kill the server and quit-and-install. Browser builds:
 *   both absent, the banner never renders.
 *
 * Channel names are mirrored in electron/main.cjs — keep them in sync.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lh", {
	platform: process.platform,
	expandWindow: () => ipcRenderer.send("lh:expand-window"),
	onZoom: (cb) => {
		const listener = (_event, factor) => cb(factor);
		ipcRenderer.on("lh:zoom", listener);
		return () => ipcRenderer.removeListener("lh:zoom", listener);
	},
	getZoom: () => ipcRenderer.invoke("lh:zoom:get"),
	getChatGPTStatus: () => ipcRenderer.invoke("lh:chatgpt:status"),
	chatGPTSignIn: () => ipcRenderer.invoke("lh:chatgpt:sign-in"),
	chatGPTCancelSignIn: () => ipcRenderer.invoke("lh:chatgpt:cancel-sign-in"),
	chatGPTOpenAuthorization: () => ipcRenderer.invoke("lh:chatgpt:open-authorization"),
	chatGPTDisconnect: () => ipcRenderer.invoke("lh:chatgpt:disconnect"),
	onUpdateStatus: (cb) => {
		const listener = (_event, status) => cb(status);
		ipcRenderer.on("lh:update-status", listener);
		return () => ipcRenderer.removeListener("lh:update-status", listener);
	},
	installUpdate: () => ipcRenderer.send("lh:update-install"),
});
