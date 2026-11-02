"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { DICTATION_PROVIDERS, bindingForAction, formatBinding, type DictationProvider } from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { SettingsMenuTrigger, SettingsRow } from "@/components/settings/controls";
import { useDictationActive } from "@/components/dictation-state";
import { useDictationLanguage } from "@/components/dictation-preference";
import { formatMegabytes, useParakeetModel } from "@/components/parakeet-model";

export const DICTATION_PROVIDER_LABELS: Record<DictationProvider, string> = {
	deepgram: "Deepgram",
	parakeet: "Parakeet (local)",
};

const MODEL_HINT = "Parakeet TDT 0.6B v3 · int8 · 487 MB download";

export function DictationProviderSetting() {
	const { provider, saving, error, saveProvider, load } = useDictationLanguage();
	const active = useDictationActive();
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const label = DICTATION_PROVIDER_LABELS[provider];
	const disabled = active || saving;

	useEffect(() => { if (active) setOpen(false); }, [active]);
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element;
			if (target instanceof Element && target.closest('[data-testid="dictation-provider-menu"]')) return;
			if (!triggerRef.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open]);
	const closeOnEscape = (event: ReactKeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		setOpen(false);
		triggerRef.current?.focus();
	};
	const pick = async (next: DictationProvider) => {
		if (disabled) return;
		if (next === provider || await saveProvider(next)) {
			setOpen(false);
			triggerRef.current?.focus();
		}
	};

	return <SettingsRow label="Provider" testid="row-dictation-provider" dimmed={active}>
		<Hint label={error ?? `Dictation provider: ${label}`} side="top">
			<SettingsMenuTrigger
				ref={triggerRef}
				value={label}
				data-testid="dictation-provider"
				aria-label={`Dictation provider: ${label}`}
				aria-expanded={open && !active}
				disabled={disabled}
				onKeyDown={(event) => { if (open) closeOnEscape(event); }}
				onClick={() => {
					setOpen((value) => !value);
					void load().catch(() => {});
				}}
				className="min-w-20 max-w-[65%]"
			/>
		</Hint>
		{open && !active && <MenuShell
			anchorRef={triggerRef}
			testid="dictation-provider-menu"
			preferredSide="down"
			menuClass="flex w-56 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-border bg-card p-1 text-xs shadow-xl"
		>
			<div onKeyDown={closeOnEscape}>
				{error && <div role="alert" className="mb-1.5 px-2 pt-1 text-destructive">{error}</div>}
				{DICTATION_PROVIDERS.map((id) => <button
					key={id}
					type="button"
					data-testid={`dictation-provider-${id}`}
					aria-pressed={id === provider}
					disabled={disabled}
					onClick={() => { void pick(id); }}
					className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-card-foreground hover:bg-accent disabled:opacity-50"
				>
					<span>{DICTATION_PROVIDER_LABELS[id]}</span>
					{id === provider && <span aria-hidden>✓</span>}
				</button>)}
			</div>
		</MenuShell>}
	</SettingsRow>;
}

/** The "Local model" row: download, cancel, or remove the Parakeet model. */
export function DictationModelSetting() {
	const { status, error, download, remove } = useParakeetModel(true);
	const active = useDictationActive();
	let hint: string = MODEL_HINT;
	let action: { label: string; run: () => void; primary?: boolean } | null = null;
	let percent: number | null = null;
	if (status?.state === "downloading") {
		hint = `Downloading… ${Math.round(status.receivedBytes / 1_000_000)} / ${formatMegabytes(status.totalBytes)}`;
		percent = status.totalBytes > 0 ? Math.min(100, Math.round(status.receivedBytes / status.totalBytes * 100)) : 0;
		action = { label: "Cancel", run: () => { void remove(); } };
	} else if (status?.state === "ready") {
		hint = `Ready · ${formatMegabytes(status.diskBytes)} on disk`;
		action = { label: "Remove", run: () => { void remove(); } };
	} else if (status?.state === "missing") {
		if (status.error) hint = status.error;
		action = { label: "Download", run: () => { void download(); }, primary: true };
	}
	return <>
		<SettingsRow label="Local model" testid="row-dictation-model" hint={error ?? hint} dimmed={active}>
			{action && <button
				type="button"
				data-testid="dictation-model-action"
				disabled={active}
				onClick={action.run}
				className={`h-7 rounded-sm border border-border px-3 font-ui text-xs transition-colors disabled:cursor-not-allowed ${action.primary ? "bg-foreground text-background" : "bg-background text-foreground hover:border-muted-foreground/50"}`}
			>{action.label}</button>}
		</SettingsRow>
		{percent !== null && <div
			role="progressbar"
			aria-label="Model download"
			aria-valuenow={percent}
			aria-valuemin={0}
			aria-valuemax={100}
			className="h-1.5 overflow-hidden rounded-full bg-accent"
		>
			<div className="h-full bg-foreground" style={{ width: `${percent}%` }} />
		</div>}
	</>;
}

/** The note under the Dictation group while Parakeet is selected. */
export function ParakeetNote() {
	return <p data-testid="dictation-parakeet-note" className="px-1 text-[11px] leading-relaxed text-muted-foreground/70">
		Audio stays on this computer. Text appears when you stop dictating ({formatBinding(bindingForAction("toggle-dictation"))}).
	</p>;
}
