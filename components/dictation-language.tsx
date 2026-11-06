"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { DICTATION_LANGUAGES, isLocalDictationLanguage } from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { SettingsMenuTrigger, SettingsRow } from "@/components/settings/controls";
import { SearchMenuList } from "@/components/settings/search-menu-list";
import { useDictationActive } from "@/components/dictation-state";
import { useDictationLanguage } from "@/components/dictation-preference";

const LOCAL_LANGUAGES = [
	{ code: "auto", label: "Auto-detect" },
	...DICTATION_LANGUAGES.filter((item) => item.code !== "multi"),
];

export function DictationLanguageSetting({ onSaved }: { onSaved?: () => void } = {}) {
	const preference = useDictationLanguage();
	const active = useDictationActive();
	return <SettingsRow label="Language" testid="row-dictation-language" dimmed={active} align="start">
		<DictationLanguagePicker language={preference.language} languages={DICTATION_LANGUAGES}
			disabled={active} saving={preference.saving} error={preference.error} load={preference.load}
			save={(code) => preference.save(code)} onSaved={onSaved} />
	</SettingsRow>;
}

export function LocalDictationLanguageSetting({ language, disabled, onChange }: {
	language: string;
	disabled: boolean;
	onChange: (language: string) => void;
}) {
	return <SettingsRow label="Language" testid="row-local-dictation-language" dimmed={disabled}>
		<DictationLanguagePicker language={language} languages={LOCAL_LANGUAGES} disabled={disabled}
			testid="local-dictation-language" ariaLabel="Local dictation language"
			save={(code) => { onChange(code); return true; }}
			customItem={(query) => {
				const code = query.trim();
				return isLocalDictationLanguage(code) ? { code, label: `Use language code: ${code}` } : undefined;
			}} />
	</SettingsRow>;
}

function DictationLanguagePicker<Code extends string>({
	language, languages, disabled, save, saving = false, error, load, onSaved,
	testid = "dictation-language", ariaLabel = "Dictation language", customItem,
}: {
	language: Code | undefined;
	languages: readonly { code: Code; label: string }[];
	disabled: boolean;
	save: (code: Code) => boolean | Promise<boolean>;
	saving?: boolean;
	error?: string | null;
	load?: () => Promise<unknown>;
	onSaved?: () => void;
	testid?: string;
	ariaLabel?: string;
	customItem?: (query: string) => { code: Code; label: string } | undefined;
}) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const label = languages.find((item) => item.code === language)?.label ?? language ?? "—";

	useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element;
			if (target instanceof Element && target.closest(`[data-testid="${testid}-menu"]`)) return;
			if (!triggerRef.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open, testid]);
	const closeOnEscape = (event: ReactKeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		setOpen(false);
		triggerRef.current?.focus();
	};
	const pick = async (code: Code) => {
		if (disabled || saving || language === undefined) return;
		if (await save(code)) {
			setOpen(false);
			triggerRef.current?.focus();
			onSaved?.();
		}
	};

	return <>
		<Hint label={error ?? `${ariaLabel}: ${label}`} side="top">
			<SettingsMenuTrigger
				ref={triggerRef}
				value={label}
				data-testid={testid}
				aria-label={`${ariaLabel}: ${label}`}
				aria-expanded={open && !disabled}
				disabled={disabled || saving}
				onKeyDown={(event) => { if (open) closeOnEscape(event); }}
				onClick={() => {
					setOpen((value) => !value);
					if (language === undefined) void load?.().catch(() => {});
				}}
				className="min-w-20 max-w-[65%]"
			/>
		</Hint>
		{open && !disabled && <MenuShell
			anchorRef={triggerRef}
			testid={`${testid}-menu`}
			preferredSide="down"
			menuClass="flex w-72 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
		>
			<div data-dictation-language-menu onKeyDown={(event) => {
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
					items={languages}
					customItem={customItem}
					itemKey={(item) => item.code}
					searchTerms={(item) => [item.code, item.label]}
					isSelected={(item) => item.code === language}
					onPick={(item) => { void pick(item.code); }}
					disabled={saving || language === undefined}
					searchTestid={`${testid}-search`}
					listTestid={`${testid}-list`}
					optionTestid={(item) => `${testid}-${item.code}`}
					ariaLabel={`Search ${ariaLabel.toLowerCase()}s`}
					placeholder="Search languages…"
					empty="No languages match."
					renderItem={(item) => <span className="text-card-foreground">{item.label}</span>}
				/>
			</div>
		</MenuShell>}
	</>;
}
