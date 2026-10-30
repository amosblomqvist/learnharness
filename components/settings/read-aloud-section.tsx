"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
	DEFAULT_TTS_VOICE_ID, keyRowTarget, resolveTtsModel, resolveTtsVoice,
	type TtsModel, type TtsVoice,
} from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { SettingsMenuTrigger, SettingsRow, ThinSelect, Toggle } from "@/components/settings/controls";
import { SearchMenuList } from "@/components/settings/search-menu-list";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { useReadAloudSettings } from "@/components/read-aloud-preference";

/** The ElevenLabs key's id in the keys store (same as components/read-aloud.tsx). */
const ELEVENLABS_KEY_ID = "ELEVENLABS_API_KEY";

type Loaded<T> =
	| { status: "loading" }
	| { status: "ready"; items: T[] }
	| { status: "keyless" }
	| { status: "error"; message: string };

/** One account list from the proxy (/api/tts/voices or /api/tts/models).
 *  Never a stale or fake list: a failure is its own state, with its message. */
async function fetchList<T>(url: string, what: string): Promise<Loaded<T>> {
	try {
		const res = await fetch(url);
		if (res.ok) return { status: "ready", items: await res.json() as T[] };
		const body = await res.json().catch(() => null) as { message?: unknown; keyless?: unknown } | null;
		if (res.status === 503 && typeof body?.keyless === "string") return { status: "keyless" };
		return { status: "error", message: typeof body?.message === "string" && body.message ? body.message : `Could not load ${what} (${res.status})` };
	} catch {
		return { status: "error", message: `Could not load ${what}` };
	}
}

function useList<T>(url: string, what: string): Loaded<T> {
	const [state, setState] = useState<Loaded<T>>({ status: "loading" });
	useEffect(() => {
		let live = true;
		void fetchList<T>(url, what).then((next) => { if (live) setState(next); });
		return () => { live = false; };
	}, [url, what]);
	return state;
}

/** Settings → Read aloud: the voice and model ElevenLabs speaks with. Both
 *  lists come live from the account; an unset choice shows what would play
 *  (Alice; the resolved model), so the picker never claims otherwise. */
export function ReadAloudSection() {
	const { open: openSettings } = useSettingsDialog();
	const { voiceId, modelId, loaded, saving, error, autoRead, saveVoice, saveModel, saveAutoRead } = useReadAloudSettings();
	const voices = useList<TtsVoice>("/api/tts/voices", "voices");
	const models = useList<TtsModel>("/api/tts/models", "models");
	const keyless = voices.status === "keyless" || models.status === "keyless";

	return <>
		<p data-testid="read-aloud-billing-note" className="text-xs text-muted-foreground/70">
			ElevenLabs bills your account separately, so read aloud is not shown in the cost meter.
		</p>
		<SettingsRow label="Read replies aloud" hint="Plays each new reply once it has finished." testid="row-read-aloud-auto">
			<Toggle checked={autoRead} disabled={saving || !loaded} label="Read replies aloud" onChange={(on) => void saveAutoRead(on)} />
		</SettingsRow>
		{keyless ? (
			<button
				type="button"
				data-testid="read-aloud-keyless"
				onClick={() => openSettings("keys", keyRowTarget(ELEVENLABS_KEY_ID, "read-aloud"))}
				className="self-start text-left text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
			>
				Read aloud needs an ElevenLabs key
			</button>
		) : <>
			<VoiceRow state={voices} saved={voiceId} disabled={saving || !loaded} onChange={saveVoice} error={error} />
			<ModelRow state={models} saved={modelId} disabled={saving || !loaded} onChange={(m) => void saveModel(m)} error={error} />
		</>}
		{error && !keyless && <p role="alert" data-testid="read-aloud-save-error" className="text-xs text-destructive">{error}</p>}
	</>;
}

function ListError({ testid, message }: { testid: string; message: string }) {
	return <p role="alert" data-testid={testid} className="text-xs text-destructive">{message}</p>;
}

function VoiceRow({ state, saved, disabled, onChange, error }: {
	state: Loaded<TtsVoice>; saved: string | undefined; disabled: boolean; onChange: (id: string) => Promise<boolean>; error: string | null;
}) {
	if (state.status === "error") return <SettingsRow label="Voice" testid="row-read-aloud-voice"><ListError testid="read-aloud-voices-error" message={state.message} /></SettingsRow>;
	const items = state.status === "ready" ? state.items : undefined;
	// What actually plays: a saved voice no longer on the account shows Alice
	// (shown only, never written back).
	const value = resolveTtsVoice(saved, items?.map((v) => v.id) ?? []);
	const label = items === undefined ? "Loading voices…" : items.find((v) => v.id === value)?.name ?? (value === DEFAULT_TTS_VOICE_ID ? "Alice" : value);
	return <SettingsRow label="Voice" testid="row-read-aloud-voice">
		<VoicePicker items={items} value={value} label={label} disabled={disabled} onChange={onChange} error={error} />
	</SettingsRow>;
}

/** The voice menu: the app's searchable menu (as the dictation language
 *  picker) over the account's voices, name with the category as quiet text. */
function VoicePicker({ items, value, label, disabled, onChange, error }: {
	items: readonly TtsVoice[] | undefined; value: string; label: string; disabled: boolean;
	onChange: (id: string) => Promise<boolean>; error: string | null;
}) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const unavailable = items === undefined;

	useEffect(() => { if (unavailable) setOpen(false); }, [unavailable]);
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element;
			if (target instanceof Element && target.closest('[data-testid="read-aloud-voice-menu"]')) return;
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
	const pick = async (voice: TtsVoice) => {
		if (unavailable) return;
		if (await onChange(voice.id)) {
			setOpen(false);
			triggerRef.current?.focus();
		}
	};

	return <>
		<Hint label={error ?? `Read aloud voice: ${label}`} side="top">
			<SettingsMenuTrigger
				ref={triggerRef}
				value={label}
				data-testid="read-aloud-voice"
				aria-label={`Read aloud voice: ${label}`}
				aria-expanded={open && !unavailable}
				disabled={disabled || unavailable}
				onKeyDown={(event) => { if (open) closeOnEscape(event); }}
				onClick={() => setOpen((v) => !v)}
				className="min-w-20 max-w-[65%]"
			/>
		</Hint>
		{open && !unavailable && <MenuShell
			anchorRef={triggerRef}
			testid="read-aloud-voice-menu"
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
					items={items}
					itemKey={(v) => v.id}
					searchTerms={(v) => [v.name, v.category]}
					isSelected={(v) => v.id === value}
					onPick={(v) => { void pick(v); }}
					disabled={disabled}
					searchTestid="read-aloud-voice-search"
					listTestid="read-aloud-voice-list"
					optionTestid={(v) => `read-aloud-voice-${v.id}`}
					ariaLabel="Search voices"
					placeholder="Search voices…"
					empty="No voices match."
					renderItem={(v) => <>
						<span className="truncate text-card-foreground">{v.name}</span>
						{v.category && <span className="truncate text-muted-foreground">{v.category}</span>}
					</>}
				/>
			</div>
		</MenuShell>}
	</>;
}

function ModelRow({ state, saved, disabled, onChange, error }: {
	state: Loaded<TtsModel>; saved: string | undefined; disabled: boolean; onChange: (id: string) => void; error: string | null;
}) {
	if (state.status === "error") return <SettingsRow label="Model" testid="row-read-aloud-model"><ListError testid="read-aloud-models-error" message={state.message} /></SettingsRow>;
	const items = state.status === "ready" ? state.items : [];
	// What actually plays: a saved model that is no longer listed shows the fallback.
	const value = state.status === "ready" ? resolveTtsModel(saved, items.map((m) => m.id)) : "";
	return <SettingsRow label="Model" testid="row-read-aloud-model">
		<Hint label={error ?? "Read aloud model"} side="top">
			<ThinSelect value={value} ariaLabel="Read aloud model" testid="read-aloud-model" disabled={disabled || state.status !== "ready"} onChange={onChange}>
				{state.status !== "ready" && <option value="">Loading models…</option>}
				{items.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
			</ThinSelect>
		</Hint>
	</SettingsRow>;
}
