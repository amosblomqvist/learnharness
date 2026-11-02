/* Main-owned desktop workspace. No renderer URLs or paths cross this boundary. */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const own = (value) => value && typeof value === "object" && !Array.isArray(value);
const validId = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const validViewId = (value) => validId(value) || (typeof value === "string" && value.startsWith("pane:") && validId(value.slice(5)));
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const copy = (value) => JSON.parse(JSON.stringify(value));
function viewState(value) {
	if (!own(value)) throw new Error("Invalid view state.");
	const result = {};
	if (value.draft !== undefined) {
		if (typeof value.draft !== "string" || value.draft.length > 200000) throw new Error("Invalid draft.");
		result.draft = value.draft;
	}
	if (value.questionDraft !== undefined) {
		if (value.questionDraft === null) result.questionDraft = null;
		else {
			const q = value.questionDraft;
			if (!own(q) || (typeof q.questionId !== "string" || q.questionId.length < 1 || q.questionId.length > 10000) || typeof q.text !== "string" || q.text.length > 200000) throw new Error("Invalid question draft.");
			result.questionDraft = { questionId: q.questionId, text: q.text };
		}
	}
	if (value.scrollTop !== undefined) {
		if (!finite(value.scrollTop) || value.scrollTop < 0 || value.scrollTop > 1e9) throw new Error("Invalid scroll position.");
		result.scrollTop = value.scrollTop;
	}
	return result;
}
function constrainBounds(bounds, displays, primary) {
	const b = own(bounds) && ["x", "y", "width", "height"].every((k) => finite(bounds[k]))
		? bounds : { ...primary, width: Math.min(1440, primary.width), height: Math.min(900, primary.height) };
	const area = displays.find((d) => b.x < d.x + d.width && b.x + b.width > d.x && b.y < d.y + d.height && b.y + b.height > d.y) ?? primary;
	const width = Math.min(Math.max(640, b.width), area.width);
	const height = Math.min(Math.max(600, b.height), area.height);
	return { x: Math.round(Math.max(area.x, Math.min(b.x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(b.y, area.y + area.height - height))), width: Math.round(width), height: Math.round(height) };
}
class Workspace {
	constructor(file) {
		this.file = file;
		this.state = { version: 1, windows: [], views: {}, keyboardOverrides: null };
		try { this.restore(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { /* Missing or corrupt workspace opens one empty window. */ }
	}
	restore(input) {
		if (!own(input) || input.version !== 1 || !Array.isArray(input.windows) || input.windows.length > 32 || !own(input.views) || Object.keys(input.views).length > 10000) throw new Error("Invalid workspace.");
		const ids = new Set(); const sessions = new Set();
		const windows = input.windows.map((w) => {
			if (!own(w) || !validId(w.id) || ids.has(w.id) || !Array.isArray(w.panes) || w.panes.length < 1 || w.panes.length > 2) throw new Error("Invalid window.");
			ids.add(w.id);
			const panes = w.panes.map((p) => {
				if (!own(p) || !validId(p.id) || ids.has(p.id) || (p.sessionId !== null && (!validId(p.sessionId) || sessions.has(p.sessionId)))) throw new Error("Invalid pane.");
				ids.add(p.id); if (p.sessionId) sessions.add(p.sessionId);
				return { id: p.id, sessionId: p.sessionId };
			});
			return { id: w.id, panes, activePaneId: panes.some((p) => p.id === w.activePaneId) ? w.activePaneId : panes[0].id, split: finite(w.split) ? Math.max(.1, Math.min(.9, w.split)) : .5, bounds: w.bounds, zoom: finite(w.zoom) ? Math.max(.25, Math.min(5, w.zoom)) : 1 };
		});
		const views = {};
		for (const [id, view] of Object.entries(input.views)) { if (!validViewId(id)) throw new Error("Invalid session."); views[id] = viewState(view); }
		this.state = { version: 1, windows, views, keyboardOverrides: this.keyboard(input.keyboardOverrides ?? null) };
	}
	persist() {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const temporary = `${this.file}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
		fs.renameSync(temporary, this.file);
	}
	newWindow(pane = { id: randomUUID(), sessionId: null }) {
		const w = { id: randomUUID(), panes: [pane], activePaneId: pane.id, split: .5, zoom: 1 };
		this.state.windows.push(w); return w;
	}
	window(id) { const w = this.state.windows.find((w) => w.id === id); if (!w) throw new Error("Unknown window."); return w; }
	snapshot(id) { const w = this.window(id); return copy({ ...w, views: this.state.views, keyboardOverrides: this.state.keyboardOverrides }); }
	keyboard(value) {
		if (value === null) return null;
		if (typeof value !== "string" || value.length > 20000) throw new Error("Invalid keyboard preferences.");
		const parsed = JSON.parse(value);
		if (!own(parsed) || !Object.entries(parsed).every(([key, binding]) => validId(key) && typeof binding === "string" && binding.length <= 200)) throw new Error("Invalid keyboard preferences.");
		return JSON.stringify(parsed);
	}
	open(windowId, sessionId, disposition) {
		if (sessionId !== null && !validId(sessionId)) throw new Error("Invalid session.");
		if (!["active", "beside", "window"].includes(disposition)) throw new Error("Invalid destination.");
		const source = this.window(windowId);
		if (sessionId !== null) for (const w of this.state.windows) {
			const pane = w.panes.find((p) => p.sessionId === sessionId);
			if (pane) { w.activePaneId = pane.id; return w; }
		}
		let target = source;
		if (disposition === "window") target = this.newWindow();
		let pane = target.panes.find((p) => p.id === target.activePaneId);
		if (disposition === "beside") {
			if (target.panes.length < 2) { pane = { id: randomUUID(), sessionId: null }; target.panes.push(pane); }
			else pane = target.panes.find((p) => p.id !== target.activePaneId);
		}
		pane.sessionId = sessionId; target.activePaneId = pane.id; return target;
	}
	move(windowId, paneId) {
		const source = this.window(windowId); const pane = source.panes.find((p) => p.id === paneId);
		if (!pane) throw new Error("Unknown pane.");
		this.close(windowId, paneId); return this.newWindow(pane);
	}
	close(windowId, paneId) {
		const w = this.window(windowId);
		if (!w.panes.some((p) => p.id === paneId)) throw new Error("Unknown pane.");
		w.panes = w.panes.filter((p) => p.id !== paneId);
		if (!w.panes.length) w.panes.push({ id: randomUUID(), sessionId: null });
		if (!w.panes.some((p) => p.id === w.activePaneId)) w.activePaneId = w.panes[0].id;
	}
	save(windowId, patch) {
		const w = this.window(windowId); if (!own(patch)) throw new Error("Invalid workspace patch.");
		if (patch.activePaneId !== undefined && !w.panes.some((p) => p.id === patch.activePaneId)) throw new Error("Unknown active pane.");
		if (patch.split !== undefined && (!finite(patch.split) || patch.split < .1 || patch.split > .9)) throw new Error("Invalid divider.");
		const keyboard = patch.keyboardOverrides === undefined ? this.state.keyboardOverrides : this.keyboard(patch.keyboardOverrides);
		const updates = {};
		if (patch.views !== undefined) {
			if (!own(patch.views) || Object.keys(patch.views).length > 100) throw new Error("Invalid views.");
			for (const [id, value] of Object.entries(patch.views)) {
				if (!validViewId(id) || (id.startsWith("pane:") && !w.panes.some((p) => `pane:${p.id}` === id))) throw new Error("Invalid session.");
				// A renderer may flush the previous session after navigation, but may
				// never overwrite a session now owned by another window.
				if (this.state.windows.some((other) => other.id !== windowId && other.panes.some((p) => p.sessionId === id))) throw new Error("Session belongs to another window.");
				updates[id] = { ...this.state.views[id], ...viewState(value) };
			}
		}
		if (patch.activePaneId !== undefined) w.activePaneId = patch.activePaneId;
		if (patch.split !== undefined) w.split = patch.split;
		Object.assign(this.state.views, updates);
		this.state.keyboardOverrides = keyboard;
	}
}
module.exports = { Workspace, constrainBounds, viewState };
