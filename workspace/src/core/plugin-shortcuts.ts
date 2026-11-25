/** Declarative action shortcuts and deterministic, browser-safe resolution. */
export interface PluginShortcutViewScope {
	readonly sessions?: readonly ("teaching" | "practice")[];
	/** View IDs always belong to the registering plugin. */
	readonly views?: readonly string[];
}
export interface PluginActionShortcut {
	readonly scope: "app" | PluginShortcutViewScope;
	/** Canonical host spelling, e.g. mod+shift+d. Omit for initially unbound. */
	readonly defaultBinding?: string;
}
export interface PluginShortcutCandidate {
	id: `plugin:${string}:${string}`;
	pluginId: string;
	actionId: string;
	pluginName: string;
	name: string;
	shortcut: PluginActionShortcut;
}
export interface ResolvedPluginShortcut extends PluginShortcutCandidate {
	binding: string;
	source: "user" | "default";
	status: "active" | "unbound" | "conflict" | "invalid";
	reason?: string;
}
export function pluginShortcutId(pluginId: string, actionId: string): PluginShortcutCandidate["id"] { return `plugin:${pluginId}:${actionId}`; }

export function isPluginShortcutBinding(binding: unknown): binding is string {
	if (typeof binding !== "string") return false;
	const parts = /^(?:(mod)\+)?(?:(alt)\+)?(?:(shift)\+)?(.+)$/.exec(binding);
	if (!parts) return false;
	const key = parts[4]!;
	if (["escape", "tab", "enter"].includes(key)) return false;
	const functionKey = /^f(?:[1-9]|1\d|2[0-4])$/.test(key);
	if (!parts[1] && !parts[2]) return functionKey;
	return functionKey || /^[!-~]$/.test(key) && key === key.toLowerCase() ||
		["arrowup", "arrowdown", "arrowleft", "arrowright", "backspace", "delete", "home", "end", "pageup", "pagedown", "insert", " "].includes(key);
}

export function preparePluginShortcut(value: unknown): PluginActionShortcut {
	const invalid = (): never => { throw new Error("Plugin shortcut requires an explicit app or nonempty session/view scope and a valid optional defaultBinding"); };
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
	const { scope, defaultBinding } = value as Record<string, unknown>;
	if (defaultBinding !== undefined && !isPluginShortcutBinding(defaultBinding)) return invalid();
	if (scope === "app") return Object.freeze({ scope, ...(defaultBinding !== undefined ? { defaultBinding } : {}) });
	if (!scope || typeof scope !== "object" || Array.isArray(scope)) return invalid();
	const { sessions, views } = scope as Record<string, unknown>;
	if (sessions !== undefined && (!Array.isArray(sessions) || sessions.some(kind => kind !== "teaching" && kind !== "practice"))) return invalid();
	if (views !== undefined && (!Array.isArray(views) || views.some(id => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)))) return invalid();
	if (!(Array.isArray(sessions) && sessions.length) && !(Array.isArray(views) && views.length)) return invalid();
	return Object.freeze({ scope: Object.freeze({
		...(sessions ? { sessions: Object.freeze([...sessions as ("teaching" | "practice")[]]) } : {}),
		...(views ? { views: Object.freeze([...views as string[]]) } : {}),
	}), ...(defaultBinding !== undefined ? { defaultBinding } : {}) });
}
export function pluginShortcutScopesOverlap(a: PluginShortcutCandidate, b: PluginShortcutCandidate): boolean {
	const x = a.shortcut.scope, y = b.shortcut.scope;
	return x === "app" || y === "app" || !!x.sessions?.some(kind => y.sessions?.includes(kind)) ||
		a.pluginId === b.pluginId && !!x.views?.some(id => y.views?.includes(id));
}
export function pluginShortcutMatches(candidate: PluginShortcutCandidate, context: { surface: "session"; kind: "teaching" | "practice" } | { surface: "plugin-view"; pluginId: string; viewId: string } | { surface: "app" }): boolean {
	const scope = candidate.shortcut.scope;
	if (scope === "app") return true;
	if (context.surface === "session") return !!scope.sessions?.includes(context.kind);
	return context.surface === "plugin-view" && context.pluginId === candidate.pluginId && !!scope.views?.includes(context.viewId);
}
export function resolvePluginShortcuts(candidates: readonly PluginShortcutCandidate[], overrides: Readonly<Record<string, unknown>>, core: ReadonlyMap<string, string>): ResolvedPluginShortcut[] {
	const rows = candidates.map((candidate): ResolvedPluginShortcut => {
		const user = Object.prototype.hasOwnProperty.call(overrides, candidate.id);
		const binding = user ? overrides[candidate.id] : candidate.shortcut.defaultBinding ?? "";
		const base = { ...candidate, binding: typeof binding === "string" ? binding : "", source: user ? "user" as const : "default" as const };
		if (binding === "") return { ...base, status: "unbound" };
		if (!isPluginShortcutBinding(binding)) return { ...base, status: "invalid", reason: "Not an allowed plugin action shortcut" };
		if (core.has(binding)) return { ...base, status: "conflict", reason: `Conflicts with core shortcut: ${core.get(binding)}` };
		return { ...base, status: "active" };
	});
	for (const row of rows) {
		if (!row.binding || !isPluginShortcutBinding(row.binding) || core.has(row.binding)) continue;
		const other = rows.find(other => other !== row && other.binding === row.binding && pluginShortcutScopesOverlap(row, other) && (row.source === "default" || other.source === "user"));
		if (other) { row.status = "conflict"; row.reason = `Conflicts with ${other.pluginName} · ${other.name}`; }
	}
	return rows;
}
