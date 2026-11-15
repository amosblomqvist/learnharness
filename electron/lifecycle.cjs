"use strict";
/**
 * Desktop side of the server lifecycle channel ("lh:lifecycle"; the server
 * half is src/server/desktop-lifecycle.ts): the startup splash while plugin
 * beforeLoad hooks run, the quit screen while beforeQuit hooks run, and the
 * plugin-requested server restart.
 *
 * The small status window loads a self-contained data: page with no preload
 * and no node integration. Its one button navigates to lh-lifecycle://<action>,
 * which the main process intercepts (will-navigate) and cancels, so the page
 * needs no IPC at all.
 */

const CHANNEL = "lh:lifecycle";
const ACTION_SCHEME = "lh-lifecycle:";

function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** The status page. `colors` = { color, symbolColor } from the app chrome. */
function statusPage({ title, detail, action, actionLabel, colors }) {
	const bg = colors?.color ?? "#1f1f1f";
	const fg = colors?.symbolColor ?? "#f2f2f2";
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%;background:${bg};color:${fg};font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-user-select:none;user-select:none}
body{display:flex;flex-direction:column;justify-content:center;gap:10px;padding:0 24px;box-sizing:border-box;-webkit-app-region:drag}
h1{font-size:15px;font-weight:600;margin:0}
p{margin:0;opacity:.75}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px}
.spin{width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:s 1s linear infinite;flex:none}
@keyframes s{to{transform:rotate(360deg)}}
a{-webkit-app-region:no-drag;color:inherit;border:1px solid currentColor;border-radius:6px;padding:4px 12px;text-decoration:none;opacity:.85;flex:none}
a:hover{opacity:1}
</style></head><body>
<div class="row"><div class="row" style="justify-content:flex-start"><div class="spin"></div><h1>${escapeHtml(title)}</h1></div>
<a href="${ACTION_SCHEME}//${escapeHtml(action)}">${escapeHtml(actionLabel)}</a></div>
${detail ? `<p>${escapeHtml(detail)}</p>` : ""}
</body></html>`;
}

/**
 * One status window at a time. `BrowserWindow` is injected for tests.
 * show({ title, detail, action, actionLabel }, onAction) replaces the content.
 */
function createStatusWindow({ BrowserWindow, colors }) {
	let win = null;
	let handler = null;
	return {
		show(content, onAction) {
			handler = onAction;
			if (!win || win.isDestroyed()) {
				win = new BrowserWindow({
					width: 420, height: 120, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
					frame: false, show: false, alwaysOnTop: true, skipTaskbar: false, title: "LearnHarness",
					backgroundColor: colors()?.color,
					webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, javascript: false },
				});
				win.webContents.on("will-navigate", (event, target) => {
					event.preventDefault();
					if (!String(target).startsWith(ACTION_SCHEME)) return;
					const action = String(target).slice(ACTION_SCHEME.length).replace(/^\/+/, "");
					try { handler?.(action); } catch { /* status actions are best effort */ }
				});
				win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
				win.once("ready-to-show", () => { if (win && !win.isDestroyed()) win.show(); });
			}
			void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(statusPage({ ...content, colors: colors() }))}`).catch(() => {});
		},
		close() {
			handler = null;
			if (win && !win.isDestroyed()) win.destroy();
			win = null;
		},
		isOpen() { return !!win && !win.isDestroyed(); },
	};
}

/**
 * Route lifecycle messages from one server child. Handlers:
 *   beforeLoad(state, plugins)  state "start" | "done"
 *   hooks(beforeQuit)
 *   restart()
 *   beforeQuitDone()
 * Returns { send(op), dispose() }.
 */
function attachLifecycleChild(child, handlers) {
	let disposed = false;
	const listener = (message) => {
		if (disposed || !message || message.channel !== CHANNEL || typeof message.op !== "string") return;
		try {
			if (message.op === "before-load" && (message.state === "start" || message.state === "done")) {
				handlers.beforeLoad?.(message.state, Array.isArray(message.plugins) ? message.plugins.filter((p) => typeof p === "string").slice(0, 10) : []);
			} else if (message.op === "hooks" && typeof message.beforeQuit === "boolean") {
				handlers.hooks?.(message.beforeQuit);
			} else if (message.op === "restart") {
				handlers.restart?.();
			} else if (message.op === "before-quit" && message.state === "done") {
				handlers.beforeQuitDone?.();
			}
		} catch { /* a handler failure must not break the channel */ }
	};
	child.on("message", listener);
	return {
		send(op) {
			if (disposed || !child.connected) return false;
			try { child.send({ channel: CHANNEL, op }, () => {}); return true; } catch { return false; }
		},
		dispose() {
			disposed = true;
			child.removeListener("message", listener);
		},
	};
}

module.exports = { CHANNEL, ACTION_SCHEME, statusPage, createStatusWindow, attachLifecycleChild };
