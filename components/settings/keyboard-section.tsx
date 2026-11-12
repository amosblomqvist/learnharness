"use client";
/**
 * The Keyboard section (thin settings wave): view / rebind / reset over
 * core/keyboard.ts's registry. The overrides persist in localStorage
 * (lh:keymap, overrides-only, merged over DEFAULT_BINDINGS), so rebinding
 * is INSTANT — the dispatcher reads the map per keydown, no reload.
 *
 * Rebind flow: click Rebind → the row listens for the next keydown
 * (capture phase, preventDefault — nothing types anywhere), eventBinding
 * normalizes it, saveOverrides persists. Escape cancels. displayOnly
 * actions (a surface owns those keys — the question dock's row machine)
 * are listed for reading but never rebindable.
 *
 * Plugin actions share this editor/store. Plugin assignments protect core
 * bindings, override competing plugin defaults, and refuse user collisions.
 * Existing core-to-core rebinding behavior is unchanged.
 */

import { useEffect, useRef, useState } from "react";
import { useOptionalInteractionLayers } from "../interaction-layers";
import { isInteractionScopeEligible } from "../plugin-input-focus";
import {
	KEYBOARD_ACTIONS,
	eventBinding,
	formatBinding,
	loadOverrides,
	saveOverrides,
	type KeyAction,
	type KeymapAction,
	type KeymapOverrides,
	type KeyScope,
	isPluginShortcutBinding,
	resolvePluginShortcuts,
} from "@/src/core";
import { SettingsRow } from "./controls.tsx";
import { coreShortcutBindings, pluginShortcutScopeLabel, useKeymapRevision, usePluginShortcutRows } from "../plugin-shortcuts";

const SCOPES: { scope: KeyScope; label: string }[] = [
	{ scope: "global", label: "Global" },
	{ scope: "chat", label: "Chat" },
	{ scope: "graph", label: "Graph" },
];

/** The overrides map after ONE change (pure — exported for tests):
 *  binding null = reset the action to its default (key removed). */
export function nextOverrides(
	current: KeymapOverrides,
	id: KeymapAction,
	binding: string | null,
): KeymapOverrides {
	const next = { ...current };
	if (binding === null) delete next[id];
	else next[id] = binding;
	return next;
}

export function KeyboardSection() {
	const controller = useOptionalInteractionLayers();
	const rootRef = useRef<HTMLDivElement>(null);
	const [overrides, setOverrides] = useState<KeymapOverrides>({});
	const [rebinding, setRebinding] = useState<KeymapAction | null>(null);
	const [rebindError, setRebindError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);
	const revision = useKeymapRevision();
	const { candidates, rows: pluginRows } = usePluginShortcutRows();
	const beginRebind = (id: KeymapAction) => { setRebindError(null); setRebinding(id); };

	// localStorage is read post-mount (SSR-safe); `nonce` re-reads after writes.
	useEffect(() => {
		setOverrides(loadOverrides());
	}, [nonce, revision]);

	// The capture listener — only while a rebind is armed.
	useEffect(() => {
		if (!rebinding) return;
		const onKey = (e: KeyboardEvent) => {
			if (!isInteractionScopeEligible(rootRef.current, controller)) return;
			if (rebinding.startsWith("plugin:") && (e.repeat || e.isComposing || e.keyCode === 229)) return;
			if (e.key === "Escape") controller?.claimEscape(e);
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") {
				setRebinding(null); setRebindError(null);
				return;
			}
			// Modifier keydowns arrive one by one (⌘ down, then ⇧, then the
			// key) — each is a keydown this capture listener sees. They are
			// not bindings; keep listening for the real key.
			if (e.key === "Control" || e.key === "Meta" || e.key === "Alt" || e.key === "Shift") return;
			const binding = eventBinding(e);
			if (!binding) return;
			const next = nextOverrides(loadOverrides(), rebinding, binding);
			if (rebinding.startsWith("plugin:")) {
				if (!isPluginShortcutBinding(binding)) { setRebindError("Use a Mod/Alt chord or function key. Escape, Tab and Enter are reserved."); return; }
				const row = resolvePluginShortcuts(candidates, next, coreShortcutBindings(next)).find(row => row.id === rebinding);
				if (!row || row.status !== "active") { setRebindError(row?.reason ?? "This plugin action is no longer available."); return; }
			}
			setRebindError(null);
			saveOverrides(next);
			setRebinding(null);
			setNonce((n) => n + 1);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [rebinding, controller, candidates]);

	function resetOne(id: KeyAction) {
		saveOverrides(nextOverrides(loadOverrides(), id, null));
		setNonce((n) => n + 1);
	}

	function resetAll() {
		saveOverrides({});
		setNonce((n) => n + 1);
	}

	const overridden = (id: KeyAction) => overrides[id] !== undefined;

	return (
		<>
			{rebindError && rebinding && <p role="alert" className="text-xs text-destructive">{rebindError}</p>}
			{SCOPES.map(({ scope, label }) => {
				const actions = KEYBOARD_ACTIONS.filter((a) => a.scope === scope);
				if (!actions.length) return null;
				return (
					<div key={scope} ref={scope === "global" ? rootRef : undefined} data-testid={`kbd-scope-${scope}`}>
						<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">{label}</p>
						<div className="flex flex-col gap-2">
							{actions.map((def) => {
								const effective = overrides[def.id] ?? def.binding;
								return (
									<SettingsRow
										key={def.id}
										label={def.label}
										hint={def.displayOnly ? "Fixed — part of this screen" : undefined}
										testid={`kbd-row-${def.id}`}
									>
										<span className="flex items-center gap-2">
											<kbd className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-ui text-xs">
												{rebinding === def.id ? "Press keys…" : formatBinding(effective)}
											</kbd>
											{def.displayOnly ? null : rebinding === def.id ? (
												<button
													type="button"
													onClick={() => setRebinding(null)}
													className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
												>
													Cancel
												</button>
											) : (
												<>
													<button
														type="button"
														onClick={() => beginRebind(def.id)}
														data-testid={`kbd-rebind-${def.id}`}
														className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
													>
														Rebind
													</button>
													{overridden(def.id) && (
														<button
															type="button"
															onClick={() => resetOne(def.id)}
															data-testid={`kbd-reset-${def.id}`}
															className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
														>
															Reset
														</button>
													)}
												</>
											)}
										</span>
									</SettingsRow>
								);
							})}
						</div>
					</div>
				);
			})}
			{[...new Set(pluginRows.map(row => row.pluginId))].map(pluginId => <div key={pluginId} data-testid={`kbd-plugin-${pluginId}`}>
				<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">{pluginRows.find(row => row.pluginId === pluginId)!.pluginName}</p>
				<div className="flex flex-col gap-2">{pluginRows.filter(row => row.pluginId === pluginId).map(row => <SettingsRow key={row.id} label={row.name}
					hint={`${pluginShortcutScopeLabel(row)}${row.reason ? ` · Inactive: ${row.reason}` : ""}`} testid={`kbd-row-${row.id}`}>
					<span className="flex items-center gap-2">
						<kbd className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-ui text-xs">{rebinding === row.id ? "Press keys…" : row.binding ? formatBinding(row.binding) : "Unbound"}</kbd>
						{rebinding === row.id ? <button type="button" onClick={() => { setRebinding(null); setRebindError(null); }} className="text-xs text-muted-foreground">Cancel</button> : <>
							<button type="button" data-testid={`kbd-rebind-${row.id}`} onClick={() => beginRebind(row.id)} className="text-xs text-muted-foreground hover:underline">Rebind</button>
							{row.binding && <button type="button" data-testid={`kbd-clear-${row.id}`} onClick={() => { saveOverrides(nextOverrides(loadOverrides(), row.id, "")); setNonce(n => n + 1); }} className="text-xs text-muted-foreground hover:underline">Clear</button>}
							{overrides[row.id] !== undefined && <button type="button" data-testid={`kbd-reset-${row.id}`} onClick={() => { saveOverrides(nextOverrides(loadOverrides(), row.id, null)); setNonce(n => n + 1); }} className="text-xs text-muted-foreground hover:underline">Reset</button>}
						</>}
					</span>
				</SettingsRow>)}</div>
			</div>)}
			<div className="mt-1 flex items-center justify-between">
				<span className="text-xs text-muted-foreground/70">Stored on this device (lh:keymap) — overrides only.</span>
				<button
					type="button"
					onClick={resetAll}
					data-testid="kbd-reset-all"
					className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
				>
					Reset all to defaults
				</button>
			</div>
		</>
	);
}