"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { DICTATION_LANGUAGES, type DictationLanguage } from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { SettingsMenuTrigger, SettingsRow } from "@/components/settings/controls";
import { SearchMenuList } from "@/components/settings/search-menu-list";
import { useDictationActive } from "@/components/dictation-state";
import { useDictationLanguage } from "@/components/dictation-preference";

type LanguagePreference = ReturnType<typeof useDictationLanguage>;

export function DictationLanguageSetting() {
	const preference = useDictationLanguage();
	const active = useDictationActive();
	return <SettingsRow label="Language" testid="row-dictation-language" dimmed={active}>
		<DictationLanguagePicker preference={preference} disabled={active} />
	</SettingsRow>;
}

function DictationLanguagePicker({ preference, disabled }: {
	preference: LanguagePreference;
	disabled: boolean;
}) {
	const { language, saving, error, load, save } = preference;
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const label = DICTATION_LANGUAGES.find((item) => item.code === language)?.label ?? "—";

	useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element;
			if (target instanceof Element && target.closest('[data-testid="dictation-language-menu"]')) return;
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
	const pick = async (code: DictationLanguage) => {
		if (disabled || saving || language === undefined) return;
		if (await save(code)) {
			setOpen(false);
			triggerRef.current?.focus();
		}
	};

	return <>
		<Hint label={error ?? `Dictation language: ${label}`} side="top">
			<SettingsMenuTrigger
				ref={triggerRef}
				value={label}
				data-testid="dictation-language"
				aria-label={`Dictation language: ${label}`}
				aria-expanded={open && !disabled}
				disabled={disabled || saving}
				onKeyDown={(event) => { if (open) closeOnEscape(event); }}
				onClick={() => {
					setOpen((value) => !value);
					if (language === undefined) void load().catch(() => {});
				}}
				className="min-w-20 max-w-[65%]"
			/>
		</Hint>
		{open && !disabled && <MenuShell
			anchorRef={triggerRef}
			testid="dictation-language-menu"
			preferredSide="down"
			menuClass="flex w-72 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
		>
			<div onKeyDown={(event) => {
				closeOnEscape(event);
				if (event.key === "Enter") {
					// Empty search results must not submit the composer, but a
					// focused option button still needs Enter's native click.
					if (event.target instanceof HTMLInputElement) event.preventDefault();
					event.stopPropagation();
				}
			}}>
				{error && <div role="alert" className="mb-1.5 text-destructive">{error}</div>}
				<SearchMenuList
					items={DICTATION_LANGUAGES}
					itemKey={(item) => item.code}
					searchTerms={(item) => [item.code, item.label]}
					isSelected={(item) => item.code === language}
					onPick={(item) => { void pick(item.code); }}
					disabled={saving || language === undefined}
					searchTestid="dictation-language-search"
					listTestid="dictation-language-list"
					optionTestid={(item) => `dictation-language-${item.code}`}
					ariaLabel="Search dictation languages"
					placeholder="Search languages…"
					empty="No languages match."
					renderItem={(item) => <span className="text-card-foreground">{item.label}</span>}
				/>
			</div>
		</MenuShell>}
	</>;
}

export function DictationProviderSetting() {
	const preference = useDictationLanguage();
	const active = useDictationActive();
	return (
		<SettingsRow label="Provider" testid="row-dictation-provider" dimmed={active}>
			<DictationProviderPicker preference={preference} disabled={active} />
		</SettingsRow>
	);
}

const PROVIDER_OPTIONS: readonly { id: "handy" | "deepgram"; label: string }[] = [
	{ id: "handy", label: "Handy (Local)" },
	{ id: "deepgram", label: "Deepgram (Cloud)" },
];

function DictationProviderPicker({
	preference,
	disabled,
}: {
	preference: LanguagePreference;
	disabled: boolean;
}) {
	const { language, provider, saving, error, load, saveDictationSettings } = preference;
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const current = provider ?? "handy";
	const label = PROVIDER_OPTIONS.find((p) => p.id === current)?.label ?? "Handy (Local)";

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

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

	const pick = async (id: "handy" | "deepgram") => {
		if (disabled || saving || language === undefined) return;
		if (await saveDictationSettings({ provider: id })) {
			setOpen(false);
			triggerRef.current?.focus();
		}
	};

	return (
		<>
			<Hint label={error ?? `Dictation provider: ${label}`} side="top">
				<SettingsMenuTrigger
					ref={triggerRef}
					value={label}
					data-testid="dictation-provider"
					aria-label={`Dictation provider: ${label}`}
					aria-expanded={open && !disabled}
					disabled={disabled || saving}
					onKeyDown={(event) => {
						if (open) closeOnEscape(event);
					}}
					onClick={() => {
						setOpen((v) => !v);
						if (language === undefined) void load().catch(() => {});
					}}
					className="min-w-20 max-w-[65%]"
				/>
			</Hint>
			{open && !disabled && (
				<MenuShell
					anchorRef={triggerRef}
					testid="dictation-provider-menu"
					preferredSide="down"
					menuClass="flex w-64 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
				>
					<div
						onKeyDown={(event) => {
							closeOnEscape(event);
							if (event.key === "Enter") {
								if (event.target instanceof HTMLInputElement) event.preventDefault();
								event.stopPropagation();
							}
						}}
					>
						{error && <div role="alert" className="mb-1.5 text-destructive">{error}</div>}
						<SearchMenuList
							items={PROVIDER_OPTIONS}
							itemKey={(item) => item.id}
							searchTerms={(item) => [item.id, item.label]}
							isSelected={(item) => item.id === current}
							onPick={(item) => {
								void pick(item.id);
							}}
							disabled={saving || language === undefined}
							searchTestid="dictation-provider-search"
							listTestid="dictation-provider-list"
							optionTestid={(item) => `dictation-provider-${item.id}`}
							ariaLabel="Search dictation providers"
							placeholder="Search providers…"
							empty="No providers match."
							renderItem={(item) => <span className="text-card-foreground">{item.label}</span>}
						/>
					</div>
				</MenuShell>
			)}
		</>
	);
}

export function DictationHandyModelSetting() {
	const preference = useDictationLanguage();
	const active = useDictationActive();
	const provider = preference.provider ?? "handy";
	if (provider !== "handy") return null;

	return (
		<SettingsRow label="Handy Model" testid="row-dictation-model" dimmed={active}>
			<DictationHandyModelPicker preference={preference} disabled={active} />
		</SettingsRow>
	);
}

function DictationHandyModelPicker({
	preference,
	disabled,
}: {
	preference: LanguagePreference;
	disabled: boolean;
}) {
	const { language, handyModel, saving, error, load, saveDictationSettings } = preference;
	const [open, setOpen] = useState(false);
	const [models, setModels] = useState<Array<{ id: string; name: string; is_downloaded: boolean }>>([]);
	const [available, setAvailable] = useState(true);
	const [loaded, setLoaded] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);

	const defaultOption = { id: "", name: "Default (Selected in Handy)", is_downloaded: true };
	const allOptions = [defaultOption, ...models.filter((m) => m.is_downloaded)];
	const selected =
		allOptions.find((m) => m.id === (handyModel ?? "")) ??
		(handyModel ? { id: handyModel, name: handyModel, is_downloaded: true } : defaultOption);

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	const loadModels = async () => {
		if (loaded) return;
		try {
			const res = await fetch("/api/stt/handy/models");
			if (res.ok) {
				const data = (await res.json()) as {
					available?: boolean;
					models?: Array<{ id: string; name: string; is_downloaded: boolean }>;
				};
				if (typeof data.available === "boolean") {
					setAvailable(data.available);
				}
				if (Array.isArray(data.models)) {
					setModels(data.models);
					setLoaded(true);
				}
			}
		} catch {}
	};

	useEffect(() => {
		if (handyModel) void loadModels();
	}, [handyModel]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element;
			if (target instanceof Element && target.closest('[data-testid="dictation-model-menu"]')) return;
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

	const pick = async (id: string) => {
		if (disabled || saving || language === undefined) return;
		if (await saveDictationSettings({ handyModel: id || undefined })) {
			setOpen(false);
			triggerRef.current?.focus();
		}
	};

	return (
		<>
			<Hint label={error ?? `Dictation model: ${selected.name}`} side="top">
				<SettingsMenuTrigger
					ref={triggerRef}
					value={selected.name}
					data-testid="dictation-model"
					aria-label={`Dictation model: ${selected.name}`}
					aria-expanded={open && !disabled}
					disabled={disabled || saving}
					onKeyDown={(event) => {
						if (open) closeOnEscape(event);
					}}
					onClick={() => {
						setOpen((v) => !v);
						if (language === undefined) void load().catch(() => {});
						void loadModels();
					}}
					className="min-w-20 max-w-[65%]"
				/>
			</Hint>
			{open && !disabled && (
				<MenuShell
					anchorRef={triggerRef}
					testid="dictation-model-menu"
					preferredSide="down"
					menuClass="flex w-72 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
				>
					<div
						onKeyDown={(event) => {
							closeOnEscape(event);
							if (event.key === "Enter") {
								if (event.target instanceof HTMLInputElement) event.preventDefault();
								event.stopPropagation();
							}
						}}
					>
						{error && <div role="alert" className="mb-1.5 text-destructive">{error}</div>}
						{!available && loaded && (
							<div role="alert" className="mb-1.5 text-destructive">
								Handy binary not found on this system.
							</div>
						)}
						<SearchMenuList
							items={allOptions}
							itemKey={(item) => item.id}
							searchTerms={(item) => [item.id, item.name]}
							isSelected={(item) => item.id === (handyModel ?? "")}
							onPick={(item) => {
								void pick(item.id);
							}}
							disabled={saving || language === undefined}
							searchTestid="dictation-model-search"
							listTestid="dictation-model-list"
							optionTestid={(item) => `dictation-model-${item.id || "default"}`}
							ariaLabel="Search Handy models"
							placeholder="Search models…"
							empty="No downloaded models found."
							renderItem={(item) => <span className="text-card-foreground">{item.name}</span>}
						/>
					</div>
				</MenuShell>
			)}
		</>
	);
}
