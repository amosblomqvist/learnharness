"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { PluginModelPickerProps, PluginThinkingPickerProps } from "@/src/core";
import { useModelCatalog } from "@/components/model-catalog";
import { ModelPickerPill } from "@/components/model-picker-pill";
import { ModelMenuList, ThinkingMenuList } from "@/components/settings/model-menu";
import { MenuShell } from "@/components/menu-shell";
import { prettyModel } from "@/components/usage-format";
import { THINKING_LABEL } from "@/components/thinking-default";
import { claimPluginInputFocus } from "@/components/plugin-dictation";

export type PickerCommand = { invoke(): void };
type Extra = { onError?: (error: unknown) => void; commandRef?: RefObject<PickerCommand | null> };

/** Dismissal is scoped to this menu, not every menu in the document. */
export function usePluginMenuDismiss(open: boolean, root: RefObject<HTMLElement | null>, close: () => void) {
	useEffect(() => {
		if (!open) return;
		const pointer = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (root.current?.contains(target) || target.closest("[data-lh-menu]")) return;
			close();
		};
		const key = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			close();
		};
		document.addEventListener("pointerdown", pointer);
		document.addEventListener("keydown", key, true);
		return () => {
			document.removeEventListener("pointerdown", pointer);
			document.removeEventListener("keydown", key, true);
		};
	}, [open, root, close]);
}

export function PluginModelPicker({ value, onChange, disabled, onError, commandRef }: PluginModelPickerProps & Extra) {
	const { catalog, refresh } = useModelCatalog();
	const root = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string>();
	const close = () => setOpen(false);
	const invoke = () => { if (!disabled) { setOpen(true); refresh(); } };
	usePluginMenuDismiss(open, root, close);
	useEffect(() => {
		if (commandRef) commandRef.current = { invoke };
		const off = root.current ? claimPluginInputFocus(root.current, { cycleModel: invoke }) : undefined;
		return () => { off?.(); if (commandRef) commandRef.current = null; };
	});
	return <div ref={root} className="relative inline-flex" data-plugin-model-picker="">
		<ModelPickerPill disabled={disabled} aria-label="Model selector" aria-expanded={open} onClick={() => { if (open) close(); else invoke(); }}>
			{value ? prettyModel(value.id) : "—"}
		</ModelPickerPill>
		{open && !disabled && <MenuShell anchorRef={root} preferredSide="up" testid="plugin-model-menu" menuClass="flex w-[22rem] flex-col rounded-xl border bg-card p-2 text-xs shadow-xl">
			{error && <div role="alert" className="text-destructive">{error}</div>}
			<ModelMenuList models={catalog?.models} effectiveId={value?.id} effectiveProvider={value?.provider} onPick={(model) => {
				setError(undefined);
				Promise.resolve().then(() => onChange({ provider: model.provider, id: model.id })).then(close).catch((error: unknown) => {
					setError(error instanceof Error ? error.message : String(error)); onError?.(error);
				});
			}} />
		</MenuShell>}
	</div>;
}

export function PluginThinkingPicker({ model, value, onChange, disabled, onError, commandRef }: PluginThinkingPickerProps & Extra) {
	const { catalog } = useModelCatalog();
	const levels = catalog?.models.find((entry) => entry.id === model?.id && entry.provider === model?.provider)?.supportedLevels ?? [];
	const root = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string>();
	const close = () => setOpen(false);
	const pick = (level: ThinkingLevel) => {
		setError(undefined);
		Promise.resolve().then(() => onChange(level)).then(close).catch((error: unknown) => {
			setError(error instanceof Error ? error.message : String(error)); onError?.(error);
		});
	};
	const cycle = () => {
		if (disabled || levels.length === 0) return;
		const next = levels[((value === undefined ? -1 : levels.indexOf(value)) + 1) % levels.length];
		if (next !== undefined) pick(next);
	};
	usePluginMenuDismiss(open, root, close);
	useEffect(() => {
		if (commandRef) commandRef.current = { invoke: cycle };
		const off = root.current ? claimPluginInputFocus(root.current, { cycleThinking: cycle }) : undefined;
		return () => { off?.(); if (commandRef) commandRef.current = null; };
	});
	return <div ref={root} className="relative inline-flex" data-plugin-thinking-picker="">
		<ModelPickerPill disabled={disabled || !model} aria-label="Thinking" aria-expanded={open} onClick={() => setOpen(!open)}>
			{value === undefined ? "—" : THINKING_LABEL[value] ?? value}
		</ModelPickerPill>
		{open && !disabled && <MenuShell anchorRef={root} preferredSide="up" testid="plugin-thinking-menu" menuClass="flex w-44 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl">
			<ThinkingMenuList levels={levels} effectiveLevel={value} onPick={(level) => pick(level as ThinkingLevel)} empty={catalog ? "No thinking levels." : "Loading…"} />
			{error && <div role="alert" className="text-destructive">{error}</div>}
		</MenuShell>}
	</div>;
}
