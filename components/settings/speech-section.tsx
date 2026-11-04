"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, PlayIcon, SquareIcon } from "lucide-react";
import { SPEECH_PREVIEW_TEXT, SPEECH_QUALITY_LABEL, type SpeechSettings, type SpeechStatus } from "@/src/core";
import { pauseSpeechPreview, previewSpeech, resumeSpeechPreview, stopSpeechPreview, useSpeechPreview } from "@/components/narration";
import { notifySettingsSaved } from "@/components/settings-signal";
import { SPEECH_STATE_LABELS, SpeechStatusMonitor, speechWorkActive } from "@/components/speech-status";
import { SettingsRow, Toggle } from "./controls";
import { Button } from "@/components/ui/button";

export function SpeechSection({ settings, onChange }: { settings?: SpeechSettings; onChange: (settings: SpeechSettings) => Promise<boolean | void> | boolean | void }) {
	const [status, setStatus] = useState<SpeechStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [saving, setSaving] = useState(false);
	const [rate, setRate] = useState(settings?.playbackRate ?? 1);
	const latest = useRef(settings);
	latest.current = settings;
	const locked = useRef(false);
	const mounted = useRef(false);
	const monitor = useRef<SpeechStatusMonitor | null>(null);
	const preview = useSpeechPreview();
	useEffect(() => setRate(settings?.playbackRate ?? 1), [settings?.playbackRate]);
	useEffect(() => {
		mounted.current = true;
		const observer = new SpeechStatusMonitor({
			fetch: (...args) => fetch(...args),
			onStatus(next) { setStatus(next); setError(null); },
			onError: setError,
			onAvailabilityChanged() { notifySettingsSaved("speech"); },
		});
		monitor.current = observer;
		void observer.refresh();
		return () => { mounted.current = false; observer.stop(); monitor.current = null; stopSpeechPreview(); };
	}, []);
	async function action(path: string, method: string, body?: object) {
		if (locked.current) return;
		locked.current = true;
		setBusy(true); setError(null);
		stopSpeechPreview();
		try {
			// Dialog closure never cancels an admitted installation.
			const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
			if (!response.ok) { const detail = await response.json().catch(() => ({})) as { error?: string }; throw new Error(detail.error ?? "Speech operation failed."); }
			if (mounted.current) await monitor.current?.refresh();
		} catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Speech operation failed."); }
		finally { locked.current = false; if (mounted.current) setBusy(false); }
	}
	async function save(delta: SpeechSettings) {
		if (locked.current) return;
		locked.current = true;
		setSaving(true); setError(null);
		if (delta.voice !== undefined) stopSpeechPreview();
		try {
			const confirmed = await onChange({ ...latest.current, ...delta });
			if (mounted.current && confirmed === false) setRate(latest.current?.playbackRate ?? 1);
		} catch (cause) {
			if (mounted.current) { setError(cause instanceof Error ? cause.message : "Speech settings could not be saved."); setRate(latest.current?.playbackRate ?? 1); }
		} finally { locked.current = false; if (mounted.current) setSaving(false); }
	}
	function commitRate(value: number) { if (value !== (latest.current?.playbackRate ?? 1)) void save({ playbackRate: value }); }
	function previewError(cause: unknown) {
		if (mounted.current && !(cause instanceof Error && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "Preview failed.");
	}
	const activeOperation = status?.operation && speechWorkActive(status) ? status.operation : null;
	const disabled = busy || saving || !status?.engines.some(engine => engine.available);
	const selectedVoice = settings?.voice;
	return <>
		{error && <p role="alert" className="mb-3 text-xs text-destructive">{error}</p>}
		{!status && !error && <p className="text-xs text-muted-foreground">Loading voices…</p>}
		{status?.engines.filter(engine => !engine.available && engine.reason).map(engine => <p key={engine.id} role="status" className="mb-3 text-xs text-muted-foreground">{engine.reason}</p>)}
		{status && <>
			<p className="mb-2 text-xs text-muted-foreground">Preview: &ldquo;{SPEECH_PREVIEW_TEXT}&rdquo;</p>
			<div role="radiogroup" aria-label="Voice" className="divide-y divide-border overflow-hidden rounded-md border border-border">
				{status.voices.map(voice => <VoiceRow
					key={voice.id}
					voice={voice}
					selected={selectedVoice === voice.id}
					previewing={preview.voiceId === voice.id && preview.status !== "idle"}
					disabled={disabled || (!!activeOperation && activeOperation.voiceId !== voice.id)}
					operation={activeOperation?.voiceId === voice.id ? activeOperation : null}
					onSelect={() => void save({ engine: voice.engine, voice: voice.id })}
					onPreview={() => { setError(null); void previewSpeech(voice.id, settings?.playbackRate ?? 1).catch(previewError); }}
					onStopPreview={stopSpeechPreview}
					onInstall={() => void action("/api/speech/install", "POST", { voiceId: voice.id })}
					onCancel={() => activeOperation && void action("/api/speech/install/cancel", "POST", { operationId: activeOperation.id })}
					onRemove={() => void action(`/api/speech/voices/${encodeURIComponent(voice.id)}`, "DELETE")}
				/>)}
			</div>
		</>}
		{status?.operation?.state === "failed" && status.operation.error && <p role="alert" className="mt-3 text-xs text-destructive">{status.operation.error}</p>}
		<div className="mt-5 flex flex-col gap-3 border-t border-border pt-4">
			<SettingsRow label="Read new responses automatically"><Toggle label="Read new responses automatically" checked={settings?.automaticReading ?? false} disabled={disabled} onChange={automaticReading => void save({ automaticReading })} /></SettingsRow>
			<SettingsRow label="Playback speed"><span className="flex items-center gap-2"><input aria-label="Playback speed" type="range" min="0.75" max="2" step="0.05" disabled={disabled} value={rate} onChange={event => setRate(Number(event.target.value))} onPointerUp={event => commitRate(Number(event.currentTarget.value))} onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) commitRate(Number(event.currentTarget.value)); }} onBlur={event => commitRate(Number(event.currentTarget.value))} /><span className="w-9 text-right text-xs">{rate}×</span></span></SettingsRow>
		</div>
	</>;
}

/** One voice: choose it (once installed), hear it, and install it if needed. */
function VoiceRow({ voice, selected, previewing, disabled, operation, onSelect, onPreview, onStopPreview, onInstall, onCancel, onRemove }: {
	voice: SpeechStatus["voices"][number];
	selected: boolean;
	previewing: boolean;
	disabled: boolean;
	operation: SpeechStatus["operation"];
	onSelect(): void;
	onPreview(): void;
	onStopPreview(): void;
	onInstall(): void;
	onCancel(): void;
	onRemove(): void;
}) {
	const ready = voice.state === "ready";
	const installing = !!operation;
	const percent = operation && operation.totalBytes ? Math.round((operation.downloadedBytes / operation.totalBytes) * 100) : 0;
	const status = installing ? `${SPEECH_STATE_LABELS[operation!.state]} ${percent}%` : ready ? "Installed" : voice.state === "unavailable" ? "Unavailable" : voice.state === "failed" ? "Install failed" : "Not installed";
	return <div className="flex items-center gap-3 px-3 py-2.5" data-testid={`speech-voice-${voice.id}`}>
		<button
			type="button"
			role="radio"
			aria-checked={selected}
			disabled={!ready || disabled || selected}
			onClick={onSelect}
			className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left disabled:cursor-default"
		>
			<span aria-hidden className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${selected ? "border-foreground" : "border-muted-foreground/60"}`}>
				{selected && <span className="size-2 rounded-full bg-foreground" />}
			</span>
			<span className="min-w-0">
				<span className="block truncate font-prose text-(length:--lh-prose-size)">{voice.name}</span>
				<span className="block truncate text-xs text-muted-foreground">{SPEECH_QUALITY_LABEL[voice.quality]} · {(voice.downloadBytes / 1e6).toFixed(0)} MB · {voice.license}</span>
			</span>
		</button>
		<span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{status}</span>
		<Button type="button" size="icon-sm" variant="ghost" aria-label={previewing ? `Stop ${voice.name} sample` : `Play ${voice.name} sample`} title={previewing ? "Stop sample" : "Play sample"} onClick={previewing ? onStopPreview : onPreview}>
			{previewing ? <SquareIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
		</Button>
		{installing ? <Button type="button" size="sm" variant="ghost" disabled={disabled || operation!.state === "removing"} onClick={onCancel}>Cancel</Button>
			: ready ? (selected ? <CheckIcon aria-label="Selected" className="size-4 text-muted-foreground" /> : <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onRemove}>Remove</Button>)
			: voice.state !== "unavailable" && <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onInstall}>{voice.state === "failed" ? "Retry" : "Install"}</Button>}
	</div>;
}
