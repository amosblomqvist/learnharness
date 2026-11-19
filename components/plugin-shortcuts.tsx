"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { KEYBOARD_ACTIONS, KEYMAP_CHANGED_EVENT, loadOverrides, pluginShortcutId, pluginShortcutMatches, resolvePluginShortcuts, eventBinding, isTypingSurface, type PluginPageActionContext, type PluginShortcutCandidate, type KeymapOverrides } from "@/src/core";
import { usePlugins } from "./plugins";
import type { FrontendPlugin, PluginFrontendManager } from "./plugin-manager";
import type { InteractionLayersController } from "./interaction-layers";
import { findCurrentSurfaceBoundary } from "./plugin-surface-targets";

export function pluginShortcutCandidates(plugins: readonly FrontendPlugin[]): PluginShortcutCandidate[] {
	return plugins.flatMap(plugin => !plugin.info.enabled || plugin.phase !== "active" ? [] : (plugin.shortcuts ?? []).flatMap(({ actionId, shortcut }) => {
		const action = plugin.actions.find(action => action.id === actionId);
		return action ? [{ id: pluginShortcutId(plugin.info.id, actionId), pluginId: plugin.info.id, actionId, pluginName: plugin.info.manifest?.name ?? plugin.info.id, name: action.name, shortcut }] : [];
	}));
}
export function coreShortcutBindings(overrides: KeymapOverrides = loadOverrides()): Map<string, string> {
	return new Map(KEYBOARD_ACTIONS.filter(action => !action.displayOnly).flatMap(action => {
		const binding = overrides[action.id] ?? action.binding;
		return binding ? [[binding, action.label] as const] : [];
	}));
}
export function useKeymapRevision() {
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		const changed = () => setRevision(value => value + 1);
		window.addEventListener(KEYMAP_CHANGED_EVENT, changed);
		window.addEventListener("storage", changed);
		return () => { window.removeEventListener(KEYMAP_CHANGED_EVENT, changed); window.removeEventListener("storage", changed); };
	}, []);
	return revision;
}
export function usePluginShortcutRows() {
	const { snapshot } = usePlugins();
	useKeymapRevision();
	const candidates = pluginShortcutCandidates(snapshot.plugins), overrides = loadOverrides();
	return { candidates, rows: resolvePluginShortcuts(candidates, overrides, coreShortcutBindings(overrides)) };
}
export function usePluginShortcutPage(pathname: string, read: () => PluginPageActionContext | undefined) {
	const { manager } = usePlugins();
	const latest = useRef(read); latest.current = read;
	useLayoutEffect(() => manager?.registerShortcutPage(pathname, () => latest.current()), [manager, pathname]);
}
export function pluginShortcutScopeLabel(candidate: PluginShortcutCandidate): string {
	const scope = candidate.shortcut.scope;
	return scope === "app" ? "App-wide" : [...(scope.sessions ?? []).map(kind => kind === "teaching" ? "Teaching" : "Practice"), ...(scope.views?.length ? [`Views: ${scope.views.join(", ")}`] : [])].join(" · ");
}

/** Window-bubble fallback only; never an independent low-level plugin listener. */
export function dispatchPluginActionShortcut(event: KeyboardEvent, manager: PluginFrontendManager | null, controller: InteractionLayersController | null): boolean {
	if (!manager || !controller || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.getModifierState?.("AltGraph")) return false;
	if (isTypingSurface(event) && !(event.metaKey || event.ctrlKey || event.altKey)) return false;
	const binding = eventBinding(event), snapshot = manager.getSnapshot();
	const rows = resolvePluginShortcuts(pluginShortcutCandidates(snapshot.plugins), loadOverrides(), coreShortcutBindings()).filter(row => row.binding === binding && row.status === "active");
	if (!rows.length) return false;
	// The event's original foreground and current foreground must agree. A leaf
	// closing/opening UI cannot make this same physical key reach another owner.
	const original = controller.getEventOwner(event), foreground = controller.getTopLayer();
	if (original !== foreground) return false;
	let page: PluginPageActionContext | undefined;
	try { page = manager.shortcutPageContext(); } catch { return false; }
	if (!page) return false;
	const eligible = rows.filter(row => {
		if (!pluginShortcutMatches(row, page)) return false;
		if (!foreground) return true;
		const root = foreground.rootRef.current;
		return foreground.kind === "view" && root?.getAttribute("data-plugin-shortcut-owner") === row.pluginId &&
			!!findCurrentSurfaceBoundary(document)?.stack?.contains(root);
	});
	if (eligible.length !== 1) return false;
	const row = eligible[0]!, plugin = snapshot.plugins.find(plugin => plugin.info.id === row.pluginId), action = plugin?.actions.find(action => action.id === row.actionId);
	if (!action) return false;
	const invoked = manager.tryRunAction(row.pluginId, action, () => ({ ...page, placement: "keyboard" }));
	if (invoked) event.preventDefault();
	return invoked;
}
