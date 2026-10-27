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
 *   {status, version, revision} on updater events; installUpdate asks main
 *   to kill the server and quit-and-install. getUpdateState retrieves the
 *   snapshot for a late subscriber; checkForUpdates requests a manual
 *   check (including download/install-on-quit, even with automatic checks OFF).
 *
 *   window.lh.onOpenSettings(cb) — menu navigation, buffered until React
 *   subscribes after a window is reopened. Browser builds have no bridge.
 *
 * Channel names are mirrored in electron/main.cjs — keep them in sync.
 */
const { contextBridge, ipcRenderer } = require("electron");

let openSettingsListener = null;
let pendingOpenSettings = null;
ipcRenderer.on("lh:open-settings", (_event, section) => {
	if (openSettingsListener) openSettingsListener(section);
	else pendingOpenSettings = section;
});

contextBridge.exposeInMainWorld("lh", {
	platform: process.platform,
	...(process.argv?.includes("--lh-web-subscriptions") ? {
		subscriptionTransport: "web",
		openSubscriptionBrowser: (action) => ipcRenderer.invoke("lh:subscriptions:web-browser", action),
	} : {}),
	chatgpt: {
		status: () => ipcRenderer.invoke("lh:chatgpt:control", { op: "status" }),
		login: (id) => ipcRenderer.invoke("lh:chatgpt:control", { op: "login", id }),
		cancel: () => ipcRenderer.invoke("lh:chatgpt:control", { op: "cancel" }),
		select: (id) => ipcRenderer.invoke("lh:chatgpt:control", { op: "select", id }),
		disconnect: (id) => ipcRenderer.invoke("lh:chatgpt:control", { op: "disconnect", id }),
		logout: (id) => ipcRenderer.invoke("lh:chatgpt:control", { op: "logout", id }),
		consent: (enabled) => ipcRenderer.invoke("lh:chatgpt:control", { op: "consent", enabled }),
		onChange: (cb) => {
			const listener = () => cb();
			ipcRenderer.on("lh:chatgpt:changed", listener);
			return () => ipcRenderer.removeListener("lh:chatgpt:changed", listener);
		},
	},
	subscriptions: {
		status: () => ipcRenderer.invoke("lh:subscriptions:control", { op: "status" }),
		login: (providerId, enabled) => ipcRenderer.invoke("lh:subscriptions:control", { op: "login", providerId, enabled }),
		cancel: (providerId) => ipcRenderer.invoke("lh:subscriptions:control", { op: "cancel", providerId }),
		respond: (providerId, attemptId, promptId, value) => ipcRenderer.invoke("lh:subscriptions:control", { op: "respond", providerId, attemptId, promptId, value }),
		open: (providerId, attemptId, actionId) => ipcRenderer.invoke("lh:subscriptions:control", { op: "open", providerId, attemptId, actionId }),
		retry: (providerId) => ipcRenderer.invoke("lh:subscriptions:control", { op: "retry", providerId }),
		disconnect: (providerId) => ipcRenderer.invoke("lh:subscriptions:control", { op: "disconnect", providerId }),
		consent: (providerId, enabled) => ipcRenderer.invoke("lh:subscriptions:control", { op: "consent", providerId, enabled }),
		onChange: (cb) => {
			const listener = () => cb();
			ipcRenderer.on("lh:subscriptions:changed", listener);
			return () => ipcRenderer.removeListener("lh:subscriptions:changed", listener);
		},
	},
	expandWindow: () => ipcRenderer.send("lh:expand-window"),
	onZoom: (cb) => {
		const listener = (_event, factor) => cb(factor);
		ipcRenderer.on("lh:zoom", listener);
		return () => ipcRenderer.removeListener("lh:zoom", listener);
	},
	getZoom: () => ipcRenderer.invoke("lh:zoom:get"),
	onUpdateStatus: (cb) => {
		const listener = (_event, status) => cb(status);
		ipcRenderer.on("lh:update-status", listener);
		return () => ipcRenderer.removeListener("lh:update-status", listener);
	},
	installUpdate: () => ipcRenderer.send("lh:update-install"),
	getUpdateState: () => ipcRenderer.invoke("lh:update:get"),
	checkForUpdates: () => ipcRenderer.invoke("lh:update:check"),
	onOpenSettings: (cb) => {
		openSettingsListener = cb;
		if (pendingOpenSettings !== null) {
			const section = pendingOpenSettings;
			pendingOpenSettings = null;
			cb(section);
		}
		return () => {
			if (openSettingsListener === cb) openSettingsListener = null;
		};
	},
});
