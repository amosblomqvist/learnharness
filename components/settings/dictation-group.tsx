"use client";
/**
 * Settings → Providers → Dictation (issue #15, PR #50): rendered inside the Providers
 * section's Dictation group, under the Deepgram key row (keys-section.tsx).
 *
 *  - METHOD: every configured method (Deepgram with a key, each
 *    downloaded model) as a pick-one list. Dictate uses only the picked
 *    one — no fallback. A new download never steals the pick.
 *  - RUN ON: WebGPU or CPU for local models, default
 *    WebGPU; when WebGPU can't start the same model runs on CPU.
 *  - MODELS: the curated on-device catalog, smallest first, each row
 *    "size · WER". Remove deletes the files (a removed pick falls to the
 *    first configured method).
 *
 * API: GET/PUT /api/stt/methods, POST/DELETE /api/stt/models/:id
 * (src/server/dictation.ts). Every change notifies "dictation" so the
 * Dictate button re-reads its methods.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	DEEPGRAM_METHOD_ID,
	dictationMethodLabel,
	formatModelSize,
	formatWer,
	localModelOf,
	type DictationDevice,
	type DictationStatus,
	type LocalModelStatus,
} from "@/src/core";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { cn } from "@/lib/utils";
import { Hint } from "@/components/ui/hint";

const MUTATION_HEADERS = { "Content-Type": "application/json" };
const linkBtn =
	"shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";
const quietBtn = "shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline";

/** The settings deep-link row the Dictate button's setup chooser lands
 *  on (Providers → Dictation): KeysSection's initialRow. */
export const DICTATION_SETTINGS_ROW = "dictation";

/** What "WER" means, on hover — the settings stay prose-free (the
 *  settings-dialog rule: hints earn their place). Exported for the copy pin. */
export const WER_HINT =
	"Word error rate on the Open ASR Leaderboard; lower is better. Bigger models are more accurate but slower.";
export const WER_NA_HINT = "No published Open ASR Leaderboard score for this model.";

/** The method row's second line. */
function methodDetail(id: string): string {
	if (id === DEEPGRAM_METHOD_ID) return "Cloud · Deepgram key";
	const m = localModelOf(id);
	return m ? `On device · ${formatModelSize(m.sizeMb)}` : "";
}

export function DictationSettings({ focus }: { focus?: boolean }) {
	const [status, setStatus] = useState<DictationStatus | null>(null);
	const [readFailed, setReadFailed] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/stt/methods");
			if (!res.ok) throw new Error("read");
			setStatus((await res.json()) as DictationStatus);
			setReadFailed(false);
		} catch {
			setReadFailed(true);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);
	useSettingsSaved((section) => {
		if (section === "keys") void load();
	});
	// Deep-linked from the Dictate card: bring the group into view once its
	// rows have rendered (the column above settles first).
	const scrolled = useRef(false);
	const loaded = status !== null;
	useEffect(() => {
		if (!focus || !loaded || scrolled.current) return;
		scrolled.current = true;
		// The whole Providers → Dictation group (heading + Deepgram key row
		// above these controls), not just this body.
		const group = rootRef.current?.closest("[data-testid=group-dictation]") ?? rootRef.current;
		group?.scrollIntoView({ block: "start" });
	}, [focus, loaded]);

	// Poll while anything downloads; a finished download can change the
	// choices (and the pick, on first setup), so tell the Dictate button.
	const downloading = status?.models.some((m) => m.state === "downloading") ?? false;
	// Downloaded set: a finished download changes it.
	const readyKey =
		status?.models
			.filter((m) => m.state === "ready")
			.map((m) => m.id)
			.join(",") ?? "";
	const lastReady = useRef(readyKey);
	useEffect(() => {
		if (readyKey !== lastReady.current) {
			lastReady.current = readyKey;
			notifySettingsSaved("dictation");
		}
	}, [readyKey]);
	// Can this machine run WebGPU at all? Drives the picker's hint line.
	const [gpuOk, setGpuOk] = useState<boolean | null>(null);
	useEffect(() => {
		const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
		if (!gpu) return setGpuOk(false);
		gpu.requestAdapter().then(
			(a) => setGpuOk(!!a),
			() => setGpuOk(false),
		);
	}, []);
	useEffect(() => {
		if (!downloading) return;
		const timer = setInterval(() => void load(), 1000);
		return () => clearInterval(timer);
	}, [downloading, load]);

	async function mutate(method: string, url: string, body?: unknown) {
		setError(null);
		try {
			const res = await fetch(url, {
				method,
				headers: MUTATION_HEADERS,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			const data = (await res.json().catch(() => null)) as (DictationStatus & { error?: string }) | null;
			if (!res.ok) {
				setError(data?.error ?? "Something went wrong. Try again.");
				return;
			}
			if (data && Array.isArray(data.configured)) setStatus(data);
			else await load();
			notifySettingsSaved("dictation");
		} catch {
			setError("Request failed. Check your connection and try again.");
		}
	}

	function setDevice(device: DictationDevice) {
		setStatus((s) => (s ? { ...s, device } : s)); // instant; the PUT returns the truth
		void mutate("PUT", "/api/stt/methods", { device });
	}

	function select(id: string) {
		setStatus((s) => (s ? { ...s, selected: id } : s)); // instant; the PUT returns the truth
		void mutate("PUT", "/api/stt/methods", { selected: id });
	}

	const configured = status?.configured ?? [];

	return (
		<div ref={rootRef} className="mt-2 flex scroll-mt-4 flex-col gap-2" data-testid="dictation-settings">
			{readFailed && (
				<p role="alert" className="text-xs text-red-400">
					Could not read dictation settings.{" "}
					<button type="button" onClick={() => void load()} className={linkBtn}>
						Retry
					</button>
				</p>
			)}
			{error && (
				<p role="alert" className="text-xs text-red-400" data-testid="dictation-error">
					{error}
				</p>
			)}

			<p className="text-xs text-muted-foreground/70">Dictation method; Dictate uses the one you pick.</p>
			{status && configured.length === 0 && (
				<p className="text-xs text-muted-foreground" data-testid="dictation-method-empty">
					Nothing set up yet. Add a Deepgram key above, or download a model below.
				</p>
			)}
			<div role="radiogroup" aria-label="Dictation method" className="flex flex-col gap-1" data-testid="dictation-methods">
				{configured.map((id) => {
					const picked = status?.selected === id;
					return (
						<button
							key={id}
							type="button"
							role="radio"
							aria-checked={picked}
							onClick={() => !picked && select(id)}
							data-testid={`dictation-method-${id}`}
							className={cn(
								"flex items-center gap-2 rounded-sm border bg-background px-2 py-1.5 text-left outline-none transition-colors focus-visible:border-muted-foreground/60",
								picked ? "border-muted-foreground/60" : "border-border hover:border-muted-foreground/40",
							)}
						>
							<span
								aria-hidden
								className={cn(
									"flex size-3 shrink-0 items-center justify-center rounded-full border",
									picked ? "border-foreground" : "border-muted-foreground/60",
								)}
							>
								{picked && <span className="size-1.5 rounded-full bg-foreground" />}
							</span>
							<span className="min-w-0 flex-1 font-ui text-xs text-foreground">{dictationMethodLabel(id)}</span>
							<span className="text-xs text-muted-foreground">{methodDetail(id)}</span>
						</button>
					);
				})}
			</div>

			<div className="mt-3 flex items-center justify-between gap-4 py-1" data-testid="dictation-device">
				<span className="min-w-0">
					<span className="block font-ui text-xs text-foreground">Run local models on</span>
					<span className="block text-xs text-muted-foreground/70">
						{gpuOk === false
							? "WebGPU isn't available on this device, so CPU is used."
							: "WebGPU is faster. If it can't start, CPU is used."}
					</span>
				</span>
				<div role="radiogroup" aria-label="Run local models on" className="flex shrink-0 rounded-sm border border-border p-0.5">
					{(
						[
							["webgpu", "WebGPU"],
							["cpu", "CPU"],
						] as const
					).map(([value, label]) => {
						const on = (status?.device ?? "webgpu") === value;
						return (
							<button
								key={value}
								type="button"
								role="radio"
								aria-checked={on}
								onClick={() => !on && setDevice(value)}
								data-testid={`dictation-device-${value}`}
								className={cn(
									"rounded-[3px] px-2.5 py-1 font-ui text-xs transition-colors",
									on ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
								)}
							>
								{label}
							</button>
						);
					})}
				</div>
			</div>
			<div className="flex flex-col" data-testid="dictation-models">
				{(status?.models ?? []).map((m) => (
					<ModelRow
						key={m.id}
						model={m}
						onDownload={() => void mutate("POST", `/api/stt/models/${m.id}`)}
						onRemove={() => void mutate("DELETE", `/api/stt/models/${m.id}`)}
					/>
				))}
			</div>
		</div>
	);
}

function ModelRow({
	model,
	onDownload,
	onRemove,
}: {
	model: LocalModelStatus;
	onDownload: () => void;
	onRemove: () => void;
}) {
	return (
		<div className="flex items-center gap-3 py-1.5" data-testid={`dictation-model-${model.id}`}>
			<span className="min-w-0 flex-1">
				<span className="block font-ui text-xs text-foreground">{model.name}</span>
				<span className="block text-xs text-muted-foreground">
					{formatModelSize(model.sizeMb)} ·{" "}
					<Hint label={model.werPct === null ? WER_NA_HINT : WER_HINT} side="top">
						<span className="cursor-help">{formatWer(model.werPct)}</span>
					</Hint>
				</span>
				{model.error && <span className="block text-xs text-red-400">{model.error}</span>}
			</span>
			{model.state === "absent" && (
				<button type="button" onClick={onDownload} className={linkBtn} data-testid={`dictation-download-${model.id}`}>
					Download
				</button>
			)}
			{model.state === "downloading" && (
				<>
					<span className="text-xs tabular-nums text-muted-foreground">
						{Math.round((model.progress ?? 0) * 100)}%
					</span>
					<button type="button" onClick={onRemove} className={quietBtn}>
						Cancel
					</button>
				</>
			)}
			{model.state === "error" && (
				<button type="button" onClick={onDownload} className={linkBtn}>
					Retry
				</button>
			)}
			{model.state === "ready" && (
				<>
					<span className="text-xs text-muted-foreground">Downloaded</span>
					<button type="button" onClick={onRemove} className={quietBtn} data-testid={`dictation-remove-${model.id}`}>
						Remove
					</button>
				</>
			)}
		</div>
	);
}
