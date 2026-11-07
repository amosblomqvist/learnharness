"use client";
/**
 * Settings → Providers → Dictation → Local (on this device): the rows that appear
 * once Local is the engine. Preferred languages, the transcription language, the
 * Chinese script, and the model list with its downloads.
 *
 * Adapted from pi-voice src/model-picker.ts, src/model-cells.ts, src/settings-menu.ts
 * and src/model-ratings-help.md (MIT, Copyright (c) 2026 Earendil Works contributors):
 * https://github.com/earendil-works/pi-voice. The terminal pickers became rows in the
 * Settings dialog; the rules (what Auto needs, which picks to show, how a grade or
 * the speed bars read) are pi-voice's, in src/core/local-stt-*.ts and
 * ./dictation-local-model.ts.
 *
 * Everything saves through the dictation store's one section PUT (saveLocal). The
 * model list is the server's: GET /api/stt/local/models, polled while a download runs.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
	ACCURACY_GRADE_HELP, CATALOG_MODELS, GROQ_DICTATION_HEADER, LANGUAGE_DETECTION_MODEL, LOCAL_AUTO_LANGUAGE,
	LOCAL_CHINESE_OUTPUTS, LOCAL_STT_MODELS_URL, NO_LOCAL_MODEL, SPEED_METER_BANDS, SPEED_METER_HELP,
	defaultLocalPreferredLanguages, displayLanguage, formatBinarySize, getCatalogModel, isLocalChineseOutput,
	languageForModel, requiresLanguageDetector, autoLanguagePolicy,
	type CatalogModel, type LocalChineseOutput, type LocalModelStatus, type LocalModelsResponse, type MachineTier,
	type ModelRecommendation,
} from "@/src/core";
import { cn } from "@/lib/utils";
import { SettingsMenuTrigger, SettingsRow, ThinSelect } from "@/components/settings/controls";
import { DictationLanguageSetting } from "@/components/dictation-language";
import { useDictationActive } from "@/components/dictation-state";
import { useDictationLanguage } from "@/components/dictation-preference";
import {
	ROLE_LABELS, buildModelListing, formatWait, licenseInfo, modelRowInfo, pickCaveat, pickNotice,
	preferredLanguageChoices, showsChineseOutput, summarizeLanguages, transcriptionChoices,
	type ModelListing,
} from "./dictation-local-model.ts";

// ── the server's model list ─────────────────────────────────────────────────

const POLL_MS = 750;
const sameOrigin = { [GROQ_DICTATION_HEADER]: "1" };

async function messageOf(res: Response, fallback: string): Promise<string> {
	try {
		const body = await res.json() as { message?: unknown };
		if (typeof body.message === "string" && body.message) return body.message;
	} catch { /* not JSON: use the fallback */ }
	return fallback;
}

type ModelAction = "download" | "cancel" | "delete";
const ACTION_FAILED: Record<ModelAction, string> = {
	download: "Could not start the download. Try again.",
	cancel: "Could not cancel the download. Try again.",
	delete: "Could not delete the model. Try again.",
};

const isRunning = (status: LocalModelStatus) => status.download?.state === "downloading" || status.download?.state === "verifying";

/** The model list, kept fresh while a download runs. Polling stops with the component. */
export function useLocalModels() {
	const [data, setData] = useState<LocalModelsResponse | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [actionErrors, setActionErrors] = useState<Readonly<Record<string, string>>>({});
	const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
	const [tick, setTick] = useState(0);
	const alive = useRef(true);
	// A newer answer (a poll or an action's reply) outranks a read still in flight.
	const latest = useRef(0);

	useEffect(() => {
		alive.current = true;
		return () => { alive.current = false; };
	}, []);

	const refresh = useCallback(async () => {
		const mine = ++latest.current;
		try {
			const res = await fetch(LOCAL_STT_MODELS_URL, { headers: sameOrigin });
			if (!res.ok) throw new Error(await messageOf(res, "Could not load the model list. Try again."));
			const body = await res.json() as LocalModelsResponse;
			if (alive.current && mine === latest.current) { setData(body); setLoadError(null); }
		} catch {
			if (alive.current && mine === latest.current) setLoadError("Could not load the model list. Try again.");
		} finally {
			// Every attempt, good or bad, schedules the next look while a download runs.
			if (alive.current) setTick((value) => value + 1);
		}
	}, []);

	useEffect(() => { void refresh(); }, [refresh]);

	const running = data !== null && [...data.models, data.languageDetector].some(isRunning);
	useEffect(() => {
		if (!running) return;
		const timer = setTimeout(() => void refresh(), POLL_MS);
		return () => clearTimeout(timer);
	}, [running, tick, refresh]);

	const run = useCallback(async (id: string, action: ModelAction): Promise<boolean> => {
		const url = `${LOCAL_STT_MODELS_URL}/${encodeURIComponent(id)}`;
		setBusy((ids) => new Set(ids).add(id));
		setActionErrors(({ [id]: _dropped, ...rest }) => rest);
		try {
			const res = action === "delete"
				? await fetch(url, { method: "DELETE", headers: sameOrigin })
				: await fetch(url, {
					method: "POST", headers: { ...sameOrigin, "Content-Type": "application/json" },
					body: JSON.stringify({ action }),
				});
			if (!res.ok) throw new Error(await messageOf(res, ACTION_FAILED[action]));
			const { model } = await res.json() as { model: LocalModelStatus };
			if (!alive.current) return true;
			latest.current++;
			setData((previous) => previous && (model.id === previous.languageDetector.id
				? { ...previous, languageDetector: model }
				: { ...previous, models: previous.models.map((entry) => entry.id === model.id ? model : entry) }));
			setTick((value) => value + 1);
			return true;
		} catch (error) {
			if (alive.current) setActionErrors((errors) => ({ ...errors, [id]: error instanceof Error ? error.message : ACTION_FAILED[action] }));
			return false;
		} finally {
			if (alive.current) setBusy((ids) => { const next = new Set(ids); next.delete(id); return next; });
		}
	}, []);

	return { data, loadError, actionErrors, busy, refresh, run };
}

type LocalModels = ReturnType<typeof useLocalModels>;

// ── small pieces ────────────────────────────────────────────────────────────

const FOCUS_RING = "outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring";
const BUTTON = cn(
	"h-7 max-w-full shrink-0 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground transition-colors",
	"hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:text-muted-foreground/40", FOCUS_RING,
);
const LINK = "underline underline-offset-2 hover:text-foreground";

function Notice({ children, testid, tone = "muted" }: { children: ReactNode; testid?: string; tone?: "muted" | "warning" }) {
	return <p data-testid={testid} className={cn("break-words px-1 text-[11px] leading-relaxed", tone === "warning" ? "text-foreground/80" : "text-muted-foreground/70")}>{children}</p>;
}

/** "Speed: ▮▮▮▮▮ ~1.2 s wait per 30 s of speech". Five bars, fuller the quicker, then the number
 * they stand for: the benchmark time to transcribe 30 seconds of speech on the machine's tier.
 * The label and the bars never part, nor do the bars and the time, so a narrow dialog wraps only
 * before the closing words. Read aloud it is the same sentence the eye sees. */
function SpeedMeter({ level, steps, waitSeconds, tier }: { level: number; steps: number; waitSeconds: number; tier: MachineTier }) {
	const wait = formatWait(waitSeconds);
	return (
		<span
			data-testid="local-model-speed"
			data-level={level}
			title={`Estimated time to transcribe 30 seconds of speech, from a benchmark on a reference laptop ${tier === "accelerated" ? "using its graphics hardware" : "using only its processor"}. Your computer may be faster or slower.`}
		>
			<span className="inline-flex items-center gap-1 whitespace-nowrap">
				<span>Speed:</span>
				<span role="img" aria-label={`${level} of ${steps} bars`} className="inline-flex items-end gap-px">
					{Array.from({ length: steps }, (_, i) => <i key={i} aria-hidden className={cn("block h-2.5 w-1 rounded-[1px]", i < level ? "bg-foreground" : "bg-border")} />)}
				</span>
				<span>{wait}</span>
			</span>
			{" "}wait per 30 s of speech
		</span>
	);
}

// ── preferred languages ─────────────────────────────────────────────────────

function PreferredLanguagesRow({ selected, disabled, dimmed, onChange }: {
	selected: readonly string[];
	disabled: boolean;
	/** A dictation run is live (not just a save in flight): the whole row dims, as the engine row does. */
	dimmed: boolean;
	onChange: (next: string[]) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelId = useId();
	const choices = useMemo(() => preferredLanguageChoices(selected), [selected]);
	const needle = query.trim().toLowerCase();
	const shown = needle ? choices.filter((code) => `${displayLanguage(code)} ${code}`.toLowerCase().includes(needle)) : choices;
	const close = () => { setOpen(false); setQuery(""); triggerRef.current?.focus(); };
	const toggle = (code: string, on: boolean) => {
		if (disabled) return;
		if (on) onChange([...selected, code]);
		// The model list needs at least one language to recommend for, and the server refuses an empty list.
		else if (selected.length > 1) onChange(selected.filter((language) => language !== code));
	};

	return <>
		<SettingsRow label="Preferred languages" hint="Used to recommend models" testid="row-local-languages" dimmed={dimmed} wrap>
			<SettingsMenuTrigger
				ref={triggerRef}
				value={summarizeLanguages(selected)}
				data-testid="local-languages-toggle"
				aria-label={`Preferred languages: ${summarizeLanguages(selected)}`}
				aria-expanded={open}
				aria-controls={open ? panelId : undefined}
				disabled={disabled}
				onClick={() => setOpen((value) => !value)}
				className="min-w-20 max-w-full"
			/>
		</SettingsRow>
		{open && !disabled && (
			<div
				id={panelId}
				role="group"
				aria-label="Preferred languages"
				data-testid="local-languages-panel"
				className="flex min-w-0 flex-col gap-1.5 rounded-sm border border-border/60 p-2"
				onKeyDown={(event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					event.stopPropagation();
					close();
				}}
			>
				<input
					type="search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
					aria-label="Search preferred languages"
					placeholder="Search languages…"
					data-testid="local-languages-search"
					autoFocus
					className={cn("h-7 w-full min-w-0 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground placeholder:text-muted-foreground/60", FOCUS_RING)}
				/>
				<ul data-testid="local-languages-list" className="flex max-h-56 flex-col overflow-y-auto">
					{shown.map((code) => {
						const checked = selected.includes(code);
						const last = checked && selected.length === 1;
						return <li key={code}>
							<label className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1 py-1 font-ui text-xs text-foreground hover:bg-accent/50">
								<input
									type="checkbox"
									checked={checked}
									aria-disabled={last || undefined}
									data-testid={`local-language-${code}`}
									onChange={(event) => toggle(code, event.target.checked)}
									className={cn("size-3.5 shrink-0 rounded-sm accent-foreground", FOCUS_RING)}
								/>
								<span className="min-w-0 flex-1 break-words">{displayLanguage(code)}</span>
								<span className="shrink-0 text-[11px] text-muted-foreground">{code}</span>
							</label>
						</li>;
					})}
				</ul>
				{shown.length === 0 && <p className="px-1 text-xs text-muted-foreground">No languages match.</p>}
				<p className="px-1 text-[11px] text-muted-foreground/70">Keep at least one. Esc closes the list.</p>
			</div>
		)}
	</>;
}

// ── downloads ───────────────────────────────────────────────────────────────

/** What a model's row can be doing, which decides its buttons (and where focus goes next). */
type Phase = "idle" | "downloading" | "verifying" | "installed" | "in-use" | "confirm-delete";

/** Download, progress, Cancel, Resume and Retry for one file: a model or the language detector.
 * An installed file renders nothing here; the model row adds Use and Delete. */
function DownloadControls({ name, size, status, busy, onAction, onIntent, testid }: {
	name: string;
	/** The file's full size, so a resumable download can say how much is left. */
	size: number;
	status: LocalModelStatus;
	busy: boolean;
	onAction: (action: "download" | "cancel") => void;
	/** Tells the owner a button is about to vanish, so it can move focus to the next one. */
	onIntent?: () => void;
	testid: string;
}) {
	const download = status.download;
	if (status.installed) return null;
	const act = (action: "download" | "cancel") => { onIntent?.(); onAction(action); };

	if (download?.state === "downloading" || download?.state === "verifying") {
		const verifying = download.state === "verifying";
		const percent = download.total > 0 ? Math.min(100, Math.floor((download.bytes / download.total) * 100)) : 0;
		return <>
			{/* Announced when the state changes, not on every percent: polling is twice a second. */}
			<span role="status" className="sr-only">{verifying ? `Verifying ${name}` : `Downloading ${name}`}</span>
			<div className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
				<div
					role="progressbar"
					aria-label={`${verifying ? "Verifying" : "Downloading"} ${name}`}
					aria-valuemin={0}
					aria-valuemax={100}
					{...(verifying ? {} : { "aria-valuenow": percent })}
					aria-valuetext={verifying ? "Verifying" : `${percent}%`}
					data-testid={`${testid}-progress`}
					className="h-1.5 w-full overflow-hidden rounded-full bg-border"
				>
					<div className={cn("h-full bg-foreground transition-[width]", verifying && "animate-pulse")} style={{ width: verifying ? "100%" : `${percent}%` }} />
				</div>
				<span data-testid={`${testid}-progress-text`} className="text-[11px] text-muted-foreground">
					{verifying ? "Verifying…" : `${formatBinarySize(download.bytes)} of ${formatBinarySize(download.total)}`}
				</span>
			</div>
			{!verifying && <button type="button" data-testid={`${testid}-cancel`} data-focus="primary" disabled={busy} onClick={() => act("cancel")} className={BUTTON}>Cancel</button>}
		</>;
	}
	const label = download?.state === "error" ? "Retry" : status.partialBytes > 0 ? "Resume" : "Download";
	return <>
		<button type="button" data-testid={`${testid}-download`} data-focus="primary" disabled={busy} onClick={() => act("download")} className={BUTTON}>{label}</button>
		{/* Beside the button, not inside it: a button that cannot wrap would overflow a narrow dialog. */}
		{status.partialBytes > 0 && <span data-testid={`${testid}-left`} className="text-[11px] text-muted-foreground">{formatBinarySize(Math.max(0, size - status.partialBytes))} left</span>}
	</>;
}

const phaseOf = (status: LocalModelStatus, inUse: boolean, confirming: boolean): Phase =>
	status.installed ? (confirming ? "confirm-delete" : inUse ? "in-use" : "installed")
		: status.download?.state === "verifying" ? "verifying"
			: status.download?.state === "downloading" ? "downloading" : "idle";

// ── one model ───────────────────────────────────────────────────────────────

function ModelRow({ model, status, listing, tier, roles, caveat, inUse, models, locked, onUse, onDeleted }: {
	model: CatalogModel;
	status: LocalModelStatus;
	listing: ModelListing;
	tier: MachineTier;
	roles?: string;
	caveat?: string;
	inUse: boolean;
	models: LocalModels;
	/** A dictation run is live, or a settings write is in flight: Use and Delete wait. */
	locked: boolean;
	onUse: (model: CatalogModel) => Promise<boolean>;
	onDeleted: (model: CatalogModel) => Promise<void>;
}) {
	const info = useMemo(() => modelRowInfo(model, listing.languages, tier, listing.benchmarks.get(model.id)), [model, listing, tier]);
	const license = licenseInfo(model);
	const [confirming, setConfirming] = useState(false);
	const rowRef = useRef<HTMLLIElement>(null);
	const refocus = useRef<string | null>(null);
	const busy = models.busy.has(model.id);
	const phase = phaseOf(status, inUse, confirming);
	const error = models.actionErrors[model.id] ?? (status.download?.state === "error" ? status.download.message ?? "The download failed. Try again." : undefined);

	// A button that was just pressed often becomes another (Download -> Cancel -> Use), and
	// a removed element drops focus to the page. Put it on the successor instead.
	useEffect(() => {
		const target = refocus.current;
		if (!target) return;
		refocus.current = null;
		rowRef.current?.querySelector<HTMLElement>(`[data-focus="${target}"]`)?.focus();
	}, [phase]);
	const expectFocus = (target = "primary") => { refocus.current = target; };

	const act = async (action: "download" | "cancel") => { if (!(await models.run(model.id, action))) refocus.current = null; };
	const remove = async () => {
		expectFocus();
		// The confirmation stays up until the file is gone, so focus lands on what replaces it.
		if (await models.run(model.id, "delete")) { setConfirming(false); await onDeleted(model); } else refocus.current = null;
	};

	return (
		<li ref={rowRef} data-testid={`local-model-${model.id}`} data-phase={phase} className="flex min-w-0 flex-col gap-1.5 rounded-sm border border-border/60 p-2">
			<div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
				<span className="min-w-0 break-words font-ui text-xs text-foreground">{model.name}</span>
				{roles && <span data-testid="local-model-roles" className="font-ui text-[11px] text-foreground/80">{roles}</span>}
				{info.manual && <span className="text-[11px] text-muted-foreground">set the language by hand</span>}
			</div>
			<p className="break-words text-[11px] leading-relaxed text-muted-foreground">{model.description}</p>

			{(info.grades.length > 0 || info.speed) && <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
				{info.grades.length > 0 && (
					<span data-testid="local-model-accuracy" className="break-words">
						{/* The no-break space keeps the label with its value. With several languages each grade is
						    tagged by its language code (the codes in the preferred-languages list): a full name
						    would not fit beside the label in a narrow dialog. The name is there for screen readers. */}
						Accuracy:{"\u00a0"}
						{info.grades.map((grade, index) => (
							<span key={grade.language} data-testid="local-model-grade" data-letter={grade.letter} title={`${grade.name}: ${grade.help}`}>
								{index > 0 && " "}
								{info.grades.length > 1 && <><span aria-hidden>{grade.language}</span><span className="sr-only">{grade.name}</span>{"\u00a0"}</>}
								<span className={cn("font-mono text-xs", grade.letter === "D" || grade.letter === "F" ? "text-destructive" : "text-foreground")}>{grade.label}</span>
							</span>
						))}
					</span>
				)}
				{info.speed && <SpeedMeter {...info.speed} tier={tier} />}
			</div>}
			<p className="min-w-0 break-words text-[11px] text-muted-foreground">
				<span data-testid="local-model-size">{formatBinarySize(model.size)}</span>
				{" · "}
				<span data-testid="local-model-license">
					{license.href
						? <a href={license.href} target="_blank" rel="noreferrer" className={LINK}>{license.label}</a>
						: license.label}
				</span>
			</p>

			{caveat && <Notice tone="warning">{caveat}</Notice>}
			{info.missing.length > 0 && <Notice tone="warning" testid="local-model-missing">Doesn't cover {new Intl.ListFormat("en", { type: "conjunction" }).format(info.missing)}.</Notice>}
			{info.autoNotice && <Notice>{info.autoNotice}</Notice>}
			{error && <p role="alert" data-testid={`local-model-${model.id}-error`} className="break-words text-[11px] text-destructive">{error}</p>}

			<div className="flex min-w-0 flex-wrap items-center gap-2" onKeyDown={(event) => {
				if (confirming && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); expectFocus("delete"); setConfirming(false); }
			}}>
				<DownloadControls
					name={model.name}
					size={model.size}
					status={status}
					busy={busy}
					onIntent={() => expectFocus()}
					onAction={(action) => void act(action)}
					testid={`local-model-${model.id}`}
				/>
				{phase === "installed" && <button type="button" data-testid={`local-model-${model.id}-use`} data-focus="primary" disabled={locked || busy} onClick={() => { expectFocus(); void onUse(model).then((ok) => { if (!ok) refocus.current = null; }); }} className={BUTTON}>Use</button>}
				{phase === "in-use" && <button type="button" data-testid={`local-model-${model.id}-in-use`} data-focus="primary" aria-disabled="true" className={cn(BUTTON, "cursor-default border-transparent px-1 text-foreground hover:border-transparent")}><span aria-hidden>✓ </span>In use</button>}
				{(phase === "installed" || phase === "in-use") && <button type="button" data-testid={`local-model-${model.id}-delete`} data-focus="delete" disabled={locked || busy} onClick={() => { expectFocus("keep"); setConfirming(true); }} className={cn(BUTTON, "text-muted-foreground hover:text-destructive")}>Delete</button>}
				{phase === "confirm-delete" && <>
					<span data-testid={`local-model-${model.id}-confirm`} className="min-w-0 break-words text-[11px] text-foreground">Delete {model.name}?{inUse && " Dictation will have no model until you choose another."}</span>
					<button type="button" data-testid={`local-model-${model.id}-delete-confirm`} disabled={busy} onClick={() => void remove()} className={cn(BUTTON, "text-destructive")}>Delete</button>
					<button type="button" data-testid={`local-model-${model.id}-delete-keep`} data-focus="keep" onClick={() => { expectFocus("delete"); setConfirming(false); }} className={BUTTON}>Keep</button>
				</>}
			</div>
		</li>
	);
}

// ── the list ────────────────────────────────────────────────────────────────

function RatingsHelp({ tier }: { tier: MachineTier }) {
	const [open, setOpen] = useState(false);
	const panelId = useId();
	return <div className="flex min-w-0 flex-col gap-1.5 px-1">
		<p className="break-words text-[11px] leading-relaxed text-muted-foreground/70">
			Accuracy is a grade for how few mistakes a model made on a benchmark in your languages. Speed is the estimated wait for 30 seconds of speech.{" "}
			<button
				type="button"
				data-testid="local-ratings-toggle"
				aria-expanded={open}
				aria-controls={open ? panelId : undefined}
				onClick={() => setOpen((value) => !value)}
				className={cn("rounded-sm underline underline-offset-2 hover:text-foreground", FOCUS_RING)}
			>{open ? "Hide the rating guide" : "How to read the ratings"}</button>
		</p>
		{open && <div id={panelId} data-testid="local-ratings-help" className="flex flex-col gap-2 rounded-sm border border-border/60 p-2 text-[11px] leading-relaxed text-muted-foreground">
			<div>
				<p className="font-ui text-xs text-foreground">Accuracy</p>
				<p>You don't always need the most accurate model: the assistant can often understand you even when a few words are wrong.</p>
				<ul className="mt-1 flex flex-col gap-0.5">
					{(Object.keys(ACCURACY_GRADE_HELP) as (keyof typeof ACCURACY_GRADE_HELP)[]).map((letter) => <li key={letter}><span className="font-mono text-foreground">{letter}</span> {ACCURACY_GRADE_HELP[letter]}</li>)}
				</ul>
				<p className="mt-1">A + or − hints at where a model sits within its grade; small differences may not be noticeable.</p>
			</div>
			<div>
				<p className="font-ui text-xs text-foreground">Speed</p>
				<p>{SPEED_METER_HELP} {tier === "accelerated" ? "This computer has graphics acceleration, so the figures use the accelerated runs." : "This computer has no graphics acceleration, so the figures use the processor-only runs."}</p>
				<ul className="mt-1 flex flex-col gap-0.5">
					{SPEED_METER_BANDS.map((band, i) => <li key={band}><span className="font-mono text-foreground">{5 - i} of 5 bars</span> {band}</li>)}
				</ul>
			</div>
			<div>
				<p className="font-ui text-xs text-foreground">Recommended models</p>
				<p>The picks are for your preferred languages. <span className="text-foreground">Best</span> is our suggested balance of speed and accuracy. <span className="text-foreground">Fast</span> prioritizes quick transcription while keeping accuracy usable. <span className="text-foreground">Accurate</span> prioritizes fewer mistakes without an excessive wait.</p>
			</div>
		</div>}
	</div>;
}

function Heading({ children }: { children: ReactNode }) {
	return <h3 className="px-1 text-xs uppercase tracking-widest text-muted-foreground">{children}</h3>;
}

function ModelList({ models, preferred, tier, currentId, locked, onUse, onDeleted }: {
	models: LocalModels;
	preferred: readonly string[];
	tier: MachineTier;
	currentId: string;
	locked: boolean;
	onUse: (model: CatalogModel) => Promise<boolean>;
	onDeleted: (model: CatalogModel) => Promise<void>;
}) {
	const [query, setQuery] = useState("");
	const [showFolded, setShowFolded] = useState(false);
	const data = models.data!;
	const statusOf = useMemo(() => new Map(data.models.map((entry) => [entry.id, entry])), [data]);
	const listing = useMemo(() => buildModelListing({
		preferred, installed: new Set(data.models.filter((entry) => entry.installed).map((entry) => entry.id)), currentId, query,
	}), [preferred, data, currentId, query]);
	const row = (model: CatalogModel, pick?: ModelRecommendation) => {
		const status = statusOf.get(model.id);
		if (!status) return null;
		return <ModelRow
			key={model.id}
			model={model}
			status={status}
			listing={listing}
			tier={tier}
			roles={pick?.roles.map((role) => ROLE_LABELS[role]).join(" · ")}
			caveat={pick ? pickCaveat(pick) : undefined}
			inUse={model.id === currentId && status.installed}
			models={models}
			locked={locked}
			onUse={onUse}
			onDeleted={onDeleted}
		/>;
	};
	const names = listing.languages.map(displayLanguage).join(" + ");
	const notice = pickNotice(listing);
	const filtering = listing.results !== null;
	const heading = listing.pickStatus === "experimental" ? `Experimental option for ${names}` : `Recommended for ${names}`;

	return <>
		{listing.picks.length > 0 && <section aria-label={heading} data-testid="local-recommended" className="flex min-w-0 flex-col gap-1.5">
			<Heading>{heading}</Heading>
			{notice && <Notice testid="local-pick-notice" tone="warning">{notice}</Notice>}
			<ul className="flex min-w-0 flex-col gap-1.5">{listing.picks.map((pick) => row(pick.model, pick))}</ul>
		</section>}
		{listing.picks.length === 0 && notice && <Notice testid="local-pick-notice" tone="warning">{notice}</Notice>}

		<section aria-label="All models" data-testid="local-all-models" className="flex min-w-0 flex-col gap-1.5">
			<Heading>{listing.picks.length > 0 ? "Other models" : "All models"}</Heading>
			<input
				type="search"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.preventDefault();
					if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); }
				}}
				aria-label="Filter models"
				placeholder={`Filter ${CATALOG_MODELS.length} models by name or family…`}
				data-testid="local-model-filter"
				className={cn("h-7 w-full min-w-0 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground placeholder:text-muted-foreground/60", FOCUS_RING)}
			/>
			{filtering && <p role="status" data-testid="local-model-count" className="px-1 text-[11px] text-muted-foreground">
				{listing.results!.length} of {CATALOG_MODELS.length} models match
			</p>}
			{filtering
				? (listing.results!.length === 0
					? <p className="px-1 text-xs text-muted-foreground">No models match.</p>
					: <ul className="flex min-w-0 flex-col gap-1.5">{listing.results!.map((model) => row(model, listing.picks.find((pick) => pick.model.id === model.id)))}</ul>)
				: <>
					<ul className="flex min-w-0 flex-col gap-1.5">{listing.others.map((model) => row(model))}</ul>
					{listing.folded.length > 0 && <>
						<button
							type="button"
							data-testid="local-folded-toggle"
							aria-expanded={showFolded}
							onClick={() => setShowFolded((value) => !value)}
							className={cn("self-start rounded-sm px-1 text-left text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground", FOCUS_RING)}
						>
							{showFolded ? "Hide" : "Show"} {listing.folded.length} more models that lack one of your languages or a benchmark for it
						</button>
						{showFolded && <ul data-testid="local-folded-models" className="flex min-w-0 flex-col gap-1.5">{listing.folded.map((model) => row(model))}</ul>}
					</>}
				</>}
		</section>
	</>;
}

// ── the rows ────────────────────────────────────────────────────────────────

/** The language rows for the selected engine: the single Language row for Deepgram and Groq,
 * the Local rows for Local (they replace it: Local transcribes the preferred languages). */
export function DictationLanguageRows() {
	const { provider } = useDictationLanguage();
	return provider === "local" ? <DictationLocalSettings /> : <DictationLanguageSetting />;
}

/** The setup note for Local. It shows right under the Engine select, ahead of the rows below it. */
function LocalSetupHint() {
	return (
		<p data-testid="dictation-setup-hint" data-engine="local" className="px-1 text-[11px] leading-relaxed text-muted-foreground/70">
			Local transcribes on this computer with a speech model you download once, so your audio never leaves
			it and no key or internet connection is needed to dictate. The first dictation after choosing a model
			takes a little longer while it loads.
		</p>
	);
}

export function DictationLocalSettings() {
	const preference = useDictationLanguage();
	const active = useDictationActive();
	const models = useLocalModels();
	const [failed, setFailed] = useState(false);
	const { language, saving, error, saveLocal } = preference;
	const locked = active || saving || language === undefined;

	if (language === undefined) return null;
	const preferred = preference.localPreferredLanguages ?? defaultLocalPreferredLanguages(language);
	const modelId = preference.localModel ?? NO_LOCAL_MODEL;
	const model = getCatalogModel(modelId);
	const chosenLanguage = preference.localLanguage ?? LOCAL_AUTO_LANGUAGE;
	const chineseOutput = preference.localChineseOutput ?? "simplified";
	const tier = models.data?.hardwareTier ?? "cpu";

	const save = async (patch: Parameters<typeof saveLocal>[0]) => { const ok = await saveLocal(patch); setFailed(!ok); return ok; };

	return <>
		<LocalSetupHint />
		<PreferredLanguagesRow
			selected={preferred}
			disabled={locked}
			dimmed={active}
			onChange={(next) => void save({
				localPreferredLanguages: next,
				// Auto and the chosen language only make sense for these preferences.
				...(model ? { localLanguage: languageForModel(chosenLanguage, model, next) } : {}),
			})}
		/>

		{/* A model with one language has nothing to choose. Use stores that language (languageForModel), and a stored "auto" resolves to it on the server. */}
		{model && transcriptionChoices(model, preferred).choices.length > 1 && <TranscriptionLanguageRow
			model={model}
			preferred={preferred}
			value={chosenLanguage}
			disabled={locked}
			dimmed={active}
			models={models}
			onChange={(next) => void save({ localLanguage: next })}
		/>}

		{showsChineseOutput(preferred, chosenLanguage) && <SettingsRow label="Chinese output" hint="Character style for Chinese text" testid="row-local-chinese" dimmed={active} wrap>
			<ThinSelect
				value={chineseOutput}
				ariaLabel="Chinese output"
				testid="select-local-chinese"
				disabled={locked}
				onChange={(next) => { if (isLocalChineseOutput(next)) void save({ localChineseOutput: next }); }}
			>
				{LOCAL_CHINESE_OUTPUTS.map((output) => <option key={output} value={output}>{output === "simplified" ? "Simplified" : "Traditional (Taiwan)"}</option>)}
			</ThinSelect>
		</SettingsRow>}

		{failed && error && <p role="alert" data-testid="dictation-local-error" className="px-1 text-xs text-destructive">{error}</p>}

		<LocalModelSection
			models={models}
			preferred={preferred}
			tier={tier}
			currentId={modelId}
			locked={locked}
			onUse={(next) => save({
				localModel: next.id,
				localLanguage: languageForModel(chosenLanguage, next, preferred),
			})}
			// Deleting the model in use leaves settings pointing at a file that is gone.
			onDeleted={async (gone) => { if (gone.id === modelId) await save({ localModel: NO_LOCAL_MODEL }); }}
		/>
	</>;
}

function TranscriptionLanguageRow({ model, preferred, value, disabled, dimmed, models, onChange }: {
	model: CatalogModel;
	preferred: readonly string[];
	value: string;
	disabled: boolean;
	dimmed: boolean;
	models: LocalModels;
	onChange: (next: string) => void;
}) {
	const { choices, autoOffered, detects } = transcriptionChoices(model, preferred);
	const detector = models.data?.languageDetector;
	// Auto only needs the detector for models that cannot detect for themselves, and only
	// where it will actually run (Auto chosen, and allowed for these languages).
	const needsDetector = value === LOCAL_AUTO_LANGUAGE && requiresLanguageDetector(model) && autoLanguagePolicy(model, preferred).kind === "detect";
	const shown = choices.some((choice) => choice.value === value) ? value : choices[0]?.value ?? value;
	const hint = autoOffered && detects.length > 1
		? `Auto picks ${new Intl.ListFormat("en", { type: "disjunction" }).format(detects)} for each recording.`
		: undefined;
	const detectorError = detector && (models.actionErrors[detector.id] ?? (detector.download?.state === "error" ? detector.download.message ?? "The download failed. Try again." : undefined));

	return <>
		<SettingsRow label="Transcription language" hint={hint} testid="row-local-language" dimmed={dimmed} wrap>
			<ThinSelect value={shown} ariaLabel="Transcription language" testid="select-local-language" disabled={disabled} onChange={onChange}>
				{choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
			</ThinSelect>
		</SettingsRow>
		{needsDetector && detector && !detector.installed && (
			<div data-testid="local-detector" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-1">
				<p className="min-w-0 flex-1 basis-48 break-words text-[11px] leading-relaxed text-muted-foreground/70">
					Auto detect needs a small language detector ({formatBinarySize(LANGUAGE_DETECTION_MODEL.size)}). Until it is downloaded, dictation uses {displayLanguage(preferred[0]!)}.
				</p>
				<DownloadControls
					name="the language detector"
					size={LANGUAGE_DETECTION_MODEL.size}
					status={detector}
					busy={models.busy.has(detector.id)}
					onAction={(action) => void models.run(detector.id, action)}
					testid="local-detector"
				/>
				{detectorError && <p role="alert" data-testid="local-detector-error" className="w-full break-words text-[11px] text-destructive">{detectorError}</p>}
			</div>
		)}
	</>;
}

function LocalModelSection({ models, preferred, tier, currentId, locked, onUse, onDeleted }: {
	models: LocalModels;
	preferred: readonly string[];
	tier: MachineTier;
	currentId: string;
	locked: boolean;
	onUse: (model: CatalogModel) => Promise<boolean>;
	onDeleted: (model: CatalogModel) => Promise<void>;
}) {
	const { data, loadError, refresh } = models;
	return (
		<div data-testid="local-models" className="mt-1 flex min-w-0 flex-col gap-3">
			<RatingsHelp tier={tier} />
			{!data && !loadError && <p role="status" className="px-1 text-xs text-muted-foreground/70">Loading models…</p>}
			{loadError && <div role="alert" data-testid="local-models-error" className="flex flex-wrap items-center gap-2 px-1 text-xs text-destructive">
				<span className="min-w-0 break-words">{loadError}</span>
				<button type="button" data-testid="local-models-retry" onClick={() => void refresh()} className={BUTTON}>Retry</button>
			</div>}
			{data && !data.engineAvailable && <p role="alert" data-testid="local-engine-error" className="break-words px-1 text-xs text-destructive">
				On-device dictation can't run on this computer{data.engineError ? `: ${data.engineError}` : "."}
			</p>}
			{data && currentId && data.models.some((entry) => entry.id === currentId && !entry.installed && !entry.download) && (
				<Notice tone="warning" testid="local-missing-model">The model you chose, {getCatalogModel(currentId)?.name ?? currentId}, isn't downloaded. Download it below to dictate.</Notice>
			)}
			{data && <ModelList models={models} preferred={preferred} tier={tier} currentId={currentId} locked={locked} onUse={onUse} onDeleted={onDeleted} />}
		</div>
	);
}
