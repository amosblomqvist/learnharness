"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PauseIcon, PlayIcon, SquareIcon, Volume2Icon } from "lucide-react";
import { NarrationController, teacherNarrationSources, type LhMessage, type NarrationSource } from "@/src/core";
import { useDictationActive, isDictationActive } from "@/components/dictation-state";
import { onSettingsSaved } from "@/components/settings-signal";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Button } from "@/components/ui/button";
import { useNotifyHub, useServerEvent, useServerResync } from "@/components/server-events";

interface Preferences { voice?: string; automaticReading?: boolean; playbackRate?: number }
type Controller = NarrationController<Blob>;
interface NarrationContextValue { controller: Controller; ready: boolean; sources: ReadonlyMap<string, NarrationSource> }
const NarrationContext = createContext<NarrationContextValue | null>(null);

function NarrationServerEvents({ refresh }: { refresh: { current: () => void } }) {
	useServerEvent("speech-changed", () => refresh.current());
	useServerResync(() => refresh.current());
	return null;
}
let activeController: Controller | null = null;
let previewAbort: AbortController | null = null;
let previewElement: HTMLAudioElement | null = null;
let claimPlayback: (() => void) | null = null;
type PreviewState = { voiceId: string | null; status: "idle" | "loading" | "playing" | "paused" };
let previewState: PreviewState = { voiceId: null, status: "idle" };
const previewListeners = new Set<() => void>();
const serverPreviewState: PreviewState = { voiceId: null, status: "idle" };
function updatePreview(next: PreviewState) { previewState = next; for (const listener of previewListeners) listener(); }
export function useSpeechPreview() {
	return useSyncExternalStore(listener => { previewListeners.add(listener); return () => { previewListeners.delete(listener); }; }, () => previewState, () => serverPreviewState);
}
export function stopSpeechPreview() { previewAbort?.abort(); previewElement?.pause(); updatePreview({ voiceId: null, status: "idle" }); }
export function pauseSpeechPreview() {
	if (previewState.status !== "playing") return;
	previewElement?.pause();
	updatePreview({ ...previewState, status: "paused" });
}
export async function resumeSpeechPreview() {
	if (previewState.status !== "paused" || !previewElement) return;
	const audio = previewElement;
	await audio.play();
	if (previewElement !== audio || previewState.status !== "paused") { audio.pause(); return; }
	updatePreview({ ...previewState, status: "playing" });
}

async function synthesize(voiceId: string, text: string, signal: AbortSignal): Promise<Blob> {
	const response = await fetch("/api/speech/synthesize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voiceId, text }), signal });
	if (!response.ok) {
		const body = await response.json().catch(() => null) as { error?: string } | null;
		throw new Error(body?.error ?? "Speech synthesis failed.");
	}
	return response.blob();
}

/** Settings preview takes the same single playback ownership as manual lesson reading. */
export async function previewSpeech(voiceId: string, playbackRate = 1): Promise<void> {
	if (isDictationActive()) throw new Error("Finish dictation before previewing a voice.");
	activeController?.halt();
	previewAbort?.abort();
	previewElement?.pause();
	claimPlayback?.();
	const abort = new AbortController();
	previewAbort = abort;
	updatePreview({ voiceId, status: "loading" });
	const channel = !claimPlayback && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("learnharness-speech") : null;
	channel?.addEventListener("message", () => abort.abort());
	channel?.postMessage(crypto.randomUUID());
	try {
	// The preview is a bundled sample: it plays before installation and never touches the runtime.
	const sample = await fetch(`/speech/samples/${encodeURIComponent(voiceId)}.wav`, { signal: abort.signal });
	if (!sample.ok) throw new Error("This voice's preview sample is missing.");
	const blob = await sample.blob();
	abort.signal.throwIfAborted();
	const url = URL.createObjectURL(blob);
	const audio = new Audio(url);
	audio.playbackRate = playbackRate;
	audio.preservesPitch = true;
	previewElement = audio;
	updatePreview({ voiceId, status: "playing" });
	try {
		await new Promise<void>((resolve, reject) => {
			const finish = (error?: Error) => { audio.onended = null; audio.onerror = null; abort.signal.removeEventListener("abort", cancel); error ? reject(error) : resolve(); };
			const cancel = () => { audio.pause(); audio.removeAttribute("src"); finish(new DOMException("Playback stopped", "AbortError")); };
			audio.onended = () => finish();
			audio.onerror = () => finish(new Error("Voice preview could not be played."));
			abort.signal.addEventListener("abort", cancel, { once: true });
			if (abort.signal.aborted) cancel();
			else void audio.play().catch(error => finish(error));
		});
	} finally { URL.revokeObjectURL(url); if (previewElement === audio) previewElement = null; }
	} finally { channel?.close(); if (previewAbort === abort) { previewAbort = null; updatePreview({ voiceId: null, status: "idle" }); } }
}

export function NarrationSessionProvider({ sessionId, messages, running, failed = false, children }: { sessionId: string; messages: readonly LhMessage[]; running: boolean; failed?: boolean; children: React.ReactNode }) {
	const notifyHub = useNotifyHub();
	const refreshSpeech = useRef<() => void>(() => {});
	const preferences = useRef<Preferences>({});
	const player = useRef<HTMLAudioElement | null>(null);
	const paused = useRef(false);
	const claim = useRef<() => void>(() => {});
	const [ready, setReady] = useState(false);
	const [controller] = useState(() => new NarrationController<Blob>({
		async synthesize(text, signal) {
			if (!preferences.current.voice) throw new Error("Choose and install a voice in Speech settings.");
			return synthesize(preferences.current.voice, text, signal);
		},
		play(blob, signal) {
			// Claim ownership once per sentence that actually starts, never while merely synthesizing.
			claim.current();
			const url = URL.createObjectURL(blob);
			const audio = new Audio(url);
			audio.playbackRate = preferences.current.playbackRate ?? 1;
			audio.preservesPitch = true;
			player.current = audio;
			return new Promise<void>((resolve, reject) => {
				const finish = (error?: Error) => {
					audio.onended = null; audio.onerror = null;
					signal.removeEventListener("abort", cancel);
					URL.revokeObjectURL(url);
					if (player.current === audio) player.current = null;
					error ? reject(error) : resolve();
				};
				const cancel = () => { audio.pause(); audio.removeAttribute("src"); finish(new DOMException("Playback stopped", "AbortError")); };
				audio.onended = () => finish();
				audio.onerror = () => finish(new Error("Speech audio could not be played."));
				signal.addEventListener("abort", cancel, { once: true });
				if (signal.aborted) cancel();
				else if (!paused.current) void audio.play().catch(error => finish(error));
			});
		},
		pause() { paused.current = true; player.current?.pause(); },
		resume() { paused.current = false; void player.current?.play().catch(() => controller.halt()); },
		stop() { paused.current = false; player.current?.pause(); },
	}));
	const sources = useMemo(() => teacherNarrationSources(messages, running, failed), [messages, running, failed]);
	const sourceMap = useMemo(() => new Map(sources.map(source => [source.viewPartId, source])), [sources]);
	const dictating = useDictationActive();
	const initial = useRef(true);
	useLayoutEffect(() => controller.setDictating(dictating), [controller, dictating]);
	// Teacher prose enters the queue during layout, before a revealed question
	// registers in a descendant passive effect from the same committed snapshot.
	useLayoutEffect(() => {
		if (initial.current) { controller.baseline(sources); initial.current = false; }
		else controller.update(sources, running);
	}, [controller, sources, running]);
	useLayoutEffect(() => { if (failed) controller.stop(); }, [controller, failed]);
	useEffect(() => {
		activeController?.halt();
		activeController = controller;
		const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("learnharness-speech");
		const owner = crypto.randomUUID();
		channel?.addEventListener("message", event => { if (event.data !== owner) { controller.yieldPlayback(); previewAbort?.abort(); } });
		claim.current = () => { previewAbort?.abort(); channel?.postMessage(owner); };
		claimPlayback = claim.current;
		let alive = true;
		let refreshGeneration = 0;
		let loadedPreferences = false;
		const refresh = async () => {
			const generation = ++refreshGeneration;
			try {
				const [settingsResponse, statusResponse] = await Promise.all([fetch("/api/settings"), fetch("/api/speech/status")]);
				if (!settingsResponse.ok || !statusResponse.ok || !alive || generation !== refreshGeneration) return;
				const settings = await settingsResponse.json() as { settings?: { speech?: Preferences } };
				const status = await statusResponse.json() as { voices?: { id: string; state: string }[] };
				if (!alive || generation !== refreshGeneration) return;
				const next = settings.settings?.speech ?? {};
				if (loadedPreferences && preferences.current.voice !== next.voice) controller.halt();
				preferences.current = next;
				const installed = status.voices?.some(voice => voice.id === next.voice && voice.state === "ready") === true;
				setReady(installed);
				controller.setAutomatic(installed && next.automaticReading === true, !loadedPreferences);
				loadedPreferences = true;
				if (player.current) player.current.playbackRate = next.playbackRate ?? 1;
			} catch { /* A missing desktop service leaves the installation affordance available. */ }
		};
		void refresh();
		refreshSpeech.current = () => void refresh();
		const unsubscribe = onSettingsSaved(section => { if (String(section) === "speech") void refresh(); });
		return () => { alive = false; refreshSpeech.current = () => {}; unsubscribe(); channel?.close(); controller.dispose(); previewAbort?.abort(); if (activeController === controller) { activeController = null; claimPlayback = null; } };
	}, [controller, sessionId]);
	return <NarrationContext.Provider value={{ controller, ready, sources: sourceMap }}>{notifyHub && <NarrationServerEvents refresh={refreshSpeech} />}{children}</NarrationContext.Provider>;
}

/** One size and inset for every read-aloud control: flush with the prose edge, quiet until hovered. */
// Inside the bordered control group: no negative offsets, so nothing is clipped at the column edge.
const readAloudButton = "h-7 gap-1.5 px-2 text-xs font-normal text-muted-foreground hover:text-foreground";

/** Spacing belongs to the caller: `className` adds the margins its surrounding layout needs. */
export function ReadAloud({ partId, source, className }: { partId?: string; source?: NarrationSource; className?: string }) {
	const context = useContext(NarrationContext);
	const settings = useSettingsDialog();
	const subscribe = context?.controller.subscribe ?? (() => () => {});
	const empty = useRef({ sourceId: null, status: "idle" as const, readAgain: [] as readonly string[] });
	const state = useSyncExternalStore(subscribe, context?.controller.getSnapshot ?? (() => empty.current), () => empty.current);
	// Playback resumes only after dictation ends, so Resume is unavailable while recording.
	const dictating = useDictationActive();
	const resolved = source ?? (partId ? context?.sources.get(partId) : undefined);
	if (!context || !resolved || !resolved.markdown.trim()) return null;
	const active = state.sourceId === resolved.id && state.status !== "idle" && state.status !== "error";
	const readAgain = state.readAgain.includes(resolved.id);
	return <div className={`mt-2 flex flex-wrap items-center gap-2 ${className ?? ""}`} data-narration-controls="" onKeyDown={event => event.stopPropagation()}>
		<div className="inline-flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5">
		{active ? <>
			<Button type="button" variant="ghost" size="sm" className={readAloudButton} disabled={dictating && state.status === "paused"} title={dictating && state.status === "paused" ? "Resumes when dictation ends" : undefined} aria-label={state.status === "paused" ? "Resume reading" : "Pause reading"} onClick={() => state.status === "paused" ? context.controller.resume() : context.controller.pause()}>
				{state.status === "paused" ? <PlayIcon className="size-3.5" /> : <PauseIcon className="size-3.5" />}
			</Button>
			<Button type="button" variant="ghost" size="sm" className={readAloudButton} aria-label="Stop reading" onClick={() => context.controller.stop()}><SquareIcon className="size-3.5" /></Button>
		</> : <Button type="button" variant="ghost" size="sm" className={readAloudButton} onClick={() => { if (!context.ready) settings.open("speech"); else context.controller.manual(resolved); }}>
			<Volume2Icon className="size-3.5" />{readAgain ? "Read again" : "Read aloud"}
		</Button>}
		</div>
		{state.sourceId === resolved.id && state.error && <span role="status" className="text-xs text-muted-foreground">{state.error}</span>}
	</div>;
}

/** Collapsing leaves the form mounted: its reveal eligibility is registered once. */
export function useQuestionNarration(source: NarrationSource, revealed: boolean) {
	const context = useContext(NarrationContext);
	const initiallyRevealed = useRef(revealed);
	const registered = useRef(false);
	const latest = useRef(source);
	latest.current = source;
	useEffect(() => {
		if (!revealed || !context) return;
		registered.current = true;
		context.controller.updateSource(latest.current);
	}, [context?.controller, revealed, source.id, source.markdown]);
	const live = useRef(false);
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
			// StrictMode runs cleanup and setup back to back; only a real unmount retires the question.
			queueMicrotask(() => { if (!live.current) context?.controller.retire(latest.current.id); });
		};
	}, [context?.controller, source.id]);
	return () => context?.controller.retire(source.id);
}
