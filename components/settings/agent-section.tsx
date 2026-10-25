"use client";
/**
 * The Agent section (settings-app wave): the THREE MODEL SLOTS, the tool
 * toggles + the search-engine preference, and the prompt override
 * switches — three GROUPS (owner, 2026-09-20: clear separation — Models /
 * Tools / System prompts).
 *
 * Model slots (model-slots wave, 2026-09-20, owner ruling: SLOTS ONLY —
 * the six per-role rows disappeared; per-role overrides remain in the
 * schema for a future advanced surface): Strong = Prober + Teacher, Cheap
 * = the five workhorse roles, Vision = Visual maker + PDF reader. Each
 * slot row carries the shared dropdown (fuzzy search, arrow-walk, Enter
 * pick — ModelMenuList/ThinkingMenuList from ./model-menu.tsx) over the
 * FEDERATED catalog (/api/models serves only keyed providers, fresh per
 * call — saving a key in Keys immediately widens this picker). The
 * vision slot filters to image-capable models (Model.input). The slots
 * live in the `models` settings section (PUT /api/settings/models — slot
 * pins are engine-level, not per-chat); the rest of the section writes
 * the `agent` section as before. Resolution per tier: slot override →
 * factory pin (GET /api/models' `slots` — resolved, cannot drift from
 * what runs). The Default row clears the slot override; a stored id stays
 * VISIBLE even when its provider's key lapsed out of the catalog — a
 * trigger showing "Default" over a live override would lie about the
 * record.
 *
 * Search engine (search wave, 2026-09-20, owner: no default — an engine
 * is live iff its key is present; with a key the engine AUTO-activates,
 * the explicit choice is only a preference between live engines): a row
 * in the Tools group, Tavily / Brave via the same shared-menu look, with
 * the live reason line from /api/search. No engine key at all → the row
 * grays whole-row (a choice without a key would only BLOCK the other
 * engine's auto-activation).
 *
 * Tools — the owner's final list (2026-09-19): research, demo, visual, pdf.
 * Absent key = enabled in the schema; the UI writes explicit booleans for
 * all four (simpler to reason about, sanitize-equivalent).
 *
 * Prompts: GET /api/settings/prompts segments — THREE SECTIONS in the
 * owner's ruled order (2026-09-26 overhaul): Teacher first, Prober, then
 * Shared LAST. The server returns per-agent lists that each INCLUDE the
 * shared segments; sectionedSegments deduplicates them (shared chunks
 * once, in prompt-assembly order). The row rulings: only the TOGGLE
 * grays when there's no override file (the file name is always
 * full-contrast); NO description line when there's no override (the empty
 * state is clean — toggle + name); the indicator ("Your version is
 * saved") appears ONLY when an override exists. The switch requires an
 * override FILE (route-enforced), so a file-less toggle is disabled.
 * The segments view re-reads on the 'lh:settings-saved' signal for the
 * agent section — the view's enabled flags derive from the record's
 * switches, and the 2026-09-26 state-echo bug was exactly this reader
 * missing (the toggle painted its old state until a remount re-fetched).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { MenuShell } from "@/components/menu-shell";
import { useSettingsSaved } from "@/components/settings-signal";
import { defaultOrderLevel, populateLevel } from "@/components/thinking-default";
import type React from "react";
import {
	COMPACTION_THRESHOLD_FLOOR,
	MODEL_SLOTS,
	resolveSettings,
	type AgentSettings,
	type CompactionSettings,
	type GraphSettings,
	type ModelCatalogEntry,
	type ModelSlotName,
	type ModelsSettings,
} from "@/src/core";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { prettyModel } from "@/components/usage-format";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow, Toggle, CommitInput } from "./controls.tsx";
import { ModelMenuList, ThinkingMenuList } from "./model-menu";
import { ChatGPTBackgroundAccess } from "./chatgpt-connection";
import { NativeSubscriptionBackgroundAccess } from "./subscription-connections";

/** One slot's display identity — the tier's roster as the row hint rides
 *  with the resolved default (owner: the hint ALWAYS names the default). */
const SLOT_META: Record<ModelSlotName, { label: string; roster: string }> = {
	strong: { label: "Strong", roster: "The main model for your sessions" },
	cheap: { label: "Cheap", roster: "The assistants that research, build demos, and grade your work" },
	vision: { label: "Vision", roster: "The assistants that draw and read PDFs" },
};

/** The search engines this wave ships (src/core/search.ts) + their labels. */
const SEARCH_ENGINES = ["tavily", "brave"] as const;

/** The owner's final toggleable-tool list (confirm with the user before
 *  changing — the Teacher stream settled this 2026-09-19). */
export const TOGGLE_TOOLS = ["research", "demo", "visual", "pdf"] as const;

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** SegmentInfo as GET /api/settings/prompts returns it. */
interface SegmentInfo {
	path: string;
	sourceText: string;
	overrideText: string | null;
	enabled: boolean;
	shared: boolean;
}

/** The GET /api/models response fields this section consumes. */
interface ModelsBody {
	models: ModelCatalogEntry[];
	/** The three tiers' RESOLVED pins (BYOK: NULL per unset tier — no
	 *  factory floor) — machinery only (the thinking list fallback); the
	 *  rows' displays read the record override, never a phantom pin. */
	slots: Record<ModelSlotName, { model: { provider: string; id: string }; thinkingLevel?: string } | null>;
}

/** Compose: one tool toggled, the rest of the section carried verbatim.
 *  Pure — exported for tests. */
export function composeTool(agent: AgentSettings | undefined, id: string, on: boolean): AgentSettings {
	return { ...agent, tools: { ...agent?.tools, [id]: on } };
}

/** The quizzing mechanics (owner 2026-09-27): a segmented control, not a
 *  toggle — exactly one mechanic is ever active. `explain: true` arms
 *  free-recall (explain in, quiz out); anything else is multiple choice.
 *  `quiz` itself is never written (mechanics-managed — see quizMechanics
 *  in agent/tools.ts). Pure — exported for tests. */
export function composeQuizMechanics(agent: AgentSettings | undefined, mechanics: "choice" | "free"): AgentSettings {
	return { ...agent, tools: { ...agent?.tools, explain: mechanics === "free" } };
}

/** Compose the prober graph-tools toggle (wave 7): its own key in the
 *  agent section — never in the tool-toggles map (owner ruling). Absent =
 *  ON (the toggle discipline); the write is explicit either way, so an
 *  explicit-off record stays visible as stored. Pure — exported for tests. */
export function composeGraphTools(agent: AgentSettings | undefined, on: boolean): AgentSettings {
	return { ...agent, graphTools: { enabled: on } };
}

/** Compose: one slot's model/thinking override. Empty model = absent
 *  override (Default — falls to the factory pin); empty thinking = the
 *  tier keeps its resolved thinking budget. Per-field independence, same
 *  as the schema's ModelSlot. Pure — exported for tests. */
export function composeSlotModel(
	models: ModelsSettings | undefined,
	slot: ModelSlotName,
	provider: string,
	id: string,
	thinking: string,
): ModelsSettings {
	const prev = models?.[slot];
	const next = { ...models };
	if (!provider && !id && !thinking) {
		delete next[slot];
		return next;
	}
	next[slot] = {
		...(provider && id ? { model: { provider, id } } : prev?.model ? { model: prev.model } : {}),
		...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
	};
	return next;
}

/** Compose: the search-engine preference. null = the explicit pin is
 *  REMOVED (auto-activation takes over — the schema's resting state).
 *  Pure — exported for tests. */
export function composeSearchEngine(
	agent: AgentSettings | undefined,
	engine: (typeof SEARCH_ENGINES)[number] | null,
): AgentSettings {
	if (engine === null) {
		if (!agent?.search) return { ...agent };
		const { search: _drop, ...rest } = agent;
		return { ...rest } as AgentSettings;
	}
	return { ...agent, search: { engine } };
}

/** The indicator under a row whose override IS the version in use (owner
 *  ruling, refined 2026-09-26: the small text states WHICH VERSION IS
 *  IN USE — "Your version is in use" when the switch is on, and NOTHING
 *  when the default composes, even if a saved override sits on disk
 *  unused. The switch's meaning becomes legible: it visibly controls
 *  this line). Exported for the pin. */
export const PROMPT_IN_USE_HINT = "Your version is in use";

/** One section of the prompt view — the owner's ruled order: Teacher,
 *  Prober, then Shared last. */
export interface PromptSection {
	id: "teacher" | "prober" | "shared";
	label: string;
	/** The one header that earns a hint: "Shared" alone is not
	 *  self-evident. Teacher/Prober are. */
	hint?: string;
	segments: SegmentInfo[];
}

/** Split the server's per-agent segment lists into the owner's three
 *  sections. The server contract returns the shared segments in BOTH
 *  lists (same paths, same content) — the shared chunks are listed ONCE
 *  here (taken from the teacher list; identical by construction), in
 *  assembly order: the base file, then the shared fragments sorted. The
 *  agents' own chunks keep their lists' order — which IS the prompt
 *  assembly order (numeric-prefix filename sort). Pure — exported for
 *  tests. */
export function sectionedSegments(view: { prober: SegmentInfo[]; teacher: SegmentInfo[] }): PromptSection[] {
	const own = (who: "prober" | "teacher") => view[who].filter((s) => !s.shared);
	return [
		{ id: "teacher", label: "Teacher", segments: own("teacher") },
		{ id: "prober", label: "Prober", segments: own("prober") },
		{
			id: "shared",
			label: "Shared",
			hint: "Used by both agents",
			segments: view.teacher.filter((s) => s.shared),
		},
	];
}

/** Compose: one prompt switch. on = explicit true; off = key REMOVED
 *  (absent = off is the schema's resting state; explicit false is the
 *  same thing but noisier). Pure — tests. */
export function composePromptSwitch(agent: AgentSettings | undefined, path: string, on: boolean): AgentSettings {
	const prompts = { ...agent?.prompts };
	if (on) prompts[path] = true;
	else delete prompts[path];
	return { ...agent, prompts };
}

/** The collapsed select look (owner: "the look of the collapsed menu is
 *  good") — now a button that opens the shared model-picker dropdown. */
function MenuTrigger({
	value,
	emptyLabel,
	ariaLabel,
	testid,
	open,
	onClick,
	widthClass,
	disabled,
}: {
	value: string;
	/** What the trigger shows when there is no override ("Default"). */
	emptyLabel: string;
	ariaLabel: string;
	testid: string;
	open: boolean;
	onClick: () => void;
	/** Owner (2026-09-20): the thinking trigger is FIXED at the width the
	 *  Default state needs (values shifting it mid-edit shifted the row);
	 *  the model trigger takes the same width as a MINIMUM — its values
	 *  genuinely vary in length. */
	widthClass: string;
	/** The no-key search state grays the whole row; the trigger follows. */
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			aria-label={ariaLabel}
			aria-expanded={open}
			data-testid={testid}
			onClick={() => {
				if (!disabled) onClick();
			}}
			className={`flex h-7 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors ${
				disabled ? "cursor-not-allowed" : "hover:border-muted-foreground/50"
			} ${widthClass}`}
		>
			<span className="min-w-0 flex-1 truncate">{value || emptyLabel}</span>
			<span aria-hidden className="text-muted-foreground">
				▾
			</span>
		</button>
	);
}

/* The section's dropdowns all mount the shared MenuShell (fix wave chunk
 * B): portaled to document.body, fixed-anchored to the open trigger by
 * testid (the section's one-ref pattern), opening DOWN with the shell's
 * viewport cap and auto-flip. data-lh-menu rides the shell — the
 * outside-click contract's exemption mark. */

export function AgentSection({
	agent,
	models,
	graph,
	compaction,
	onSectionChange,
	onModelsChange,
	onCompactionChange,
}: {
	agent: AgentSettings | undefined;
	/** The `models` section (slot pins — engine-level, PUT /api/settings/models). */
	models: ModelsSettings | undefined;
	/** The `graph` section — READ ONLY here: the graphTools row composes its
	 *  master switch (graph.enabled off dims + disables the row; the
	 *  effective gate is server-side, per-turn fresh). */
	graph: GraphSettings | undefined;
	/** The `compaction` section — its own PUT (the threshold is engine
	 *  behavior, not an agent-section key; owner round 14, Agent tab). */
	compaction: CompactionSettings | undefined;
	/** Writes the composed WHOLE agent section (replace-PUT discipline). */
	onSectionChange: (next: AgentSettings) => void;
	/** Writes the composed models section (slots — replace-PUT discipline). */
	onModelsChange: (next: ModelsSettings) => void;
	/** Writes the whole compaction section (replace-PUT discipline). */
	onCompactionChange: (next: CompactionSettings) => void;
}) {
	const [catalog, setCatalog] = useState<ModelCatalogEntry[] | null>(null);
	/** The three tiers' resolved pins — GET /api/models `slots`. The rows'
	 *  Default hints and thinking lists resolve from it. */
	const [slots, setSlots] = useState<ModelsBody["slots"] | null>(null);
	/** The live search state (/api/search) — the row's reason line. */
	const [search, setSearch] = useState<{ available: boolean; engine: string | null; reason: string } | null>(null);
	/** Which search engines have a key (/api/keys) — the no-keys-anywhere
	 *  state grays the row; per-engine marks ride the menu rows. */
	const [engineKeys, setEngineKeys] = useState<Partial<Record<(typeof SEARCH_ENGINES)[number], boolean>>>({});
	const [prompts, setPrompts] = useState<{ prober: SegmentInfo[]; teacher: SegmentInfo[] } | null>(null);
	const [openSegment, setOpenSegment] = useState<string | null>(null);
	const [segmentDraft, setSegmentDraft] = useState<Record<string, string>>({});
	const [segmentStatus, setSegmentStatus] = useState<string | null>(null);
	/** One open dropdown for the whole section: which slot (or the search
	 *  row), which kind. */
	const [openMenu, setOpenMenu] = useState<{ target: ModelSlotName | "search"; kind: "model" | "thinking" | "engine" } | null>(null);
	const menuAnchorRef = useRef<HTMLSpanElement>(null);

	const refreshSearch = () =>
		fetch("/api/search")
			.then((r) => r.json())
			.then((body: { available: boolean; engine: string | null; reason: string }) => setSearch(body))
			.catch(() => setSearch(null));

	/** Re-read the prompt-segment view — the signal seam for the
	 *  2026-09-26 state-echo fix: the view's `enabled` flags DERIVE from
	 *  the settings record's agent switches (the toggle's truth lives
	 *  here, not in the `agent` prop), so an agent-section write must
	 *  re-read it or the toggle keeps painting its pre-write state until
	 *  a remount. Keeps the last-good view on a failed re-read (the
	 *  initial mount fetch below owns the loading/null state). */
	const readPrompts = useCallback(() => {
		fetch("/api/settings/prompts")
			.then((r) => r.json())
			.then((body: { prober: SegmentInfo[]; teacher: SegmentInfo[] }) => setPrompts(body))
			.catch(() => {});
	}, []);

	// The catalog (federated: keyed providers only), the resolved slots,
	// the prompt segments, and the search engines' key presence — one
	// fetch each per section mount. The models read ALSO re-runs on the
	// cross-surface signal (fix wave: another surface's write re-reads
	// into the slot rows live).
	const modelsRequest = useRef(0);
	const modelsMounted = useRef(false);
	const readModels = useCallback((connectionChanged = false) => {
		const request = ++modelsRequest.current;
		if (connectionChanged) setCatalog(null);
		fetch("/api/models")
			.then((r) => { if (!r.ok) throw new Error("Catalog unavailable"); return r.json(); })
			.then((body: ModelsBody) => {
				if (!modelsMounted.current || request !== modelsRequest.current) return;
				setCatalog(body.models);
				setSlots(body.slots);
			})
			.catch(() => { if (modelsMounted.current && request === modelsRequest.current) setCatalog(null); });
	}, []);

	useSettingsSaved((section) => {
		if (section === "models" || section === "keys") readModels(section === "keys");
		// THE state-echo root cause: the prompt switches write through the
		// agent section, but this view (the toggles' truth) never re-read —
		// the settings-saved law (every reader re-reads) was missing this
		// one reader.
		if (section === "agent") readPrompts();
	});

	useEffect(() => {
		modelsMounted.current = true;
		readModels();
		fetch("/api/settings/prompts")
			.then((r) => r.json())
			.then((body: { prober: SegmentInfo[]; teacher: SegmentInfo[] }) => setPrompts(body))
			.catch(() => setPrompts(null));
		fetch("/api/keys")
			.then((r) => r.json())
			.then((body: { keys: { id: string; present: boolean }[] }) => {
				const present: Partial<Record<(typeof SEARCH_ENGINES)[number], boolean>> = {};
				for (const id of SEARCH_ENGINES) {
					const envVar = id === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY";
					present[id] = body.keys.some((k) => k.id === envVar && k.present);
				}
				setEngineKeys(present);
			})
			.catch(() => {});
		return () => { modelsMounted.current = false; modelsRequest.current++; };
	}, []);

	// The reason line re-reads /api/search AFTER an engine write lands —
	// the write updates the `agent` prop (the dialog's record mirror), so
	// keying on the pin avoids the race where the fetch beat the PUT and
	// the hint contradicted the trigger it sits under.
	useEffect(() => {
		refreshSearch();
	}, [agent?.search?.engine]);

	// The dropdown contract (the chat model selector's, mirrored): any
	// click outside the open menu — or an Esc — closes it. Esc is CLAIMED
	// with stopPropagation so the settings dialog behind does NOT also
	// close. A pointerdown on the backdrop is left for the dialog (its own
	// click closes everything); a click inside the dialog just closes us.
	useEffect(() => {
		if (openMenu === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (menuAnchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) {
				setOpenMenu(null);
			}
			// else: outside the dialog — the dialog's own close handles it.
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpenMenu(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [openMenu]);

	async function saveSegment(path: string, text: string) {
		setSegmentStatus(null);
		const res = await fetch(`/api/settings/prompts/${path}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text }),
		});
		if (!res.ok) {
			setSegmentStatus(`Save failed: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
			return;
		}
		readPrompts();
		setSegmentStatus("Saved");
		// Auto-on (owner ruling, refined 2026-09-26): writing an override and
		// putting it to work are ONE action — a save with the switch off was
		// the "did something, changed nothing" trap (the composed prompt
		// stayed the default). The file exists now, so the ON switch the
		// agent-section validation requires is legal; the order (file, then
		// switch) is the safe one. Saving an edit while already on rides
		// through — the switch write is idempotent at the record level.
		if (agent?.prompts?.[path] !== true) {
			onSectionChange(composePromptSwitch(agent, path, true));
		}
	}

	async function deleteSegment(path: string) {
		setSegmentStatus(null);
		const res = await fetch(`/api/settings/prompts/${path}`, { method: "DELETE" });
		if (!res.ok) {
			setSegmentStatus(`Delete failed: ${res.status}`);
			return;
		}
		// Auto-off — the mirror of save's auto-on: deleting the file while
		// the switch is on would orphan an ON record switch (the agent-section
		// validation 400s every later write while the UI's toggle can no
		// longer reach the OFF escape hatch — the trap found in live verify
		// 2026-09-26). Composing the OFF here keeps the record clean.
		if (agent?.prompts?.[path] === true) {
			onSectionChange(composePromptSwitch(agent, path, false));
		}
		readPrompts();
		setSegmentStatus("Deleted");
	}

		/** The search-engine menu row — label + the quiet live-key mark. */
	const engineOption = (
		id: (typeof SEARCH_ENGINES)[number] | "auto",
		label: string,
		active: boolean,
		live: boolean | null,
		onPick: () => void,
	) => (
		<button
			key={id}
			type="button"
			data-testid={`engine-option-${id}`}
			onClick={onPick}
			className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted ${
				active ? "bg-muted/60 text-card-foreground" : "text-card-foreground"
			}`}
		>
			<span>{label}</span>
			<span className="text-muted-foreground">
				{live === null ? (active && <span aria-hidden>✓</span>) : live ? <span aria-hidden>✓ key</span> : <span aria-hidden>· no key</span>}
			</span>
		</button>
	);

	const segmentRow = (info: SegmentInfo) => {
		const fileExists = info.overrideText !== null;
		const open = openSegment === info.path;
		// The Save affordance (owner ruling, refined 2026-09-26): clickable
		// only when there's something to save — the draft differs from
		// what's on disk. An unchanged editor shows a grayed, inert Save
		// (the always-active button was the "doesn't feel like it does
		// anything" half of the report).
		const draft = segmentDraft[info.path] ?? info.overrideText ?? "";
		const dirty = draft !== (info.overrideText ?? "");
		return (
			<div key={info.path} data-testid={`prompt-segment-${info.path}`}>
				<SettingsRow
					label={info.path}
					// Overhaul rulings (2026-09-26, refined): the small text
					// states WHICH VERSION IS IN USE — nothing when the
					// default composes (even with a saved override sitting
					// on disk unused), "Your version is in use" when the
					// switch is on. The switch's meaning becomes legible
					// through this line.
					hint={info.enabled ? PROMPT_IN_USE_HINT : undefined}
					testid={`prompt-row-${info.path}`}
				>
					{/* Graying ruling: ONLY the toggle dims without an
					    override file — the file name above stays
					    full-contrast (the whole-row dim is dead). */}
					<span className={fileExists ? undefined : "opacity-40"}>
						<Toggle
							checked={info.enabled}
							disabled={!fileExists}
							label={`prompt ${info.path}`}
							onChange={(on) => onSectionChange(composePromptSwitch(agent, info.path, on))}
						/>
					</span>
				</SettingsRow>
				<button
					type="button"
					onClick={() => {
						setOpenSegment(open ? null : info.path);
						setSegmentStatus(null);
					}}
					className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
				>
					{open ? "Hide text" : "Show text"}
				</button>
				{open && (
					<div className="mt-1 flex flex-col gap-2">
						<div>
							<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">Source</p>
							<textarea
								readOnly
								value={info.sourceText}
								aria-label="The original instructions"
								className="h-24 w-full resize-y rounded-sm border border-border bg-muted p-2 font-ui text-xs text-muted-foreground"
							/>
						</div>
						<div>
							<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">Override</p>
							<textarea
								value={segmentDraft[info.path] ?? info.overrideText ?? ""}
								onChange={(e) => setSegmentDraft({ ...segmentDraft, [info.path]: e.target.value })}
								aria-label="Your version of the instructions"
								placeholder="Add your own instructions…"
								className="h-24 w-full resize-y rounded-sm border border-border bg-background p-2 font-ui text-xs text-foreground outline-none"
							/>
						</div>
						<div className="flex items-center gap-3">
							<button
								type="button"
								disabled={!dirty}
								onClick={() => void saveSegment(info.path, segmentDraft[info.path] ?? "")}
								className={
									dirty
										? "text-xs text-foreground underline-offset-2 hover:underline"
										: "cursor-not-allowed text-xs text-muted-foreground/40 underline-offset-2"
								}
							>
								Save
							</button>
							{fileExists && (
								<button
									type="button"
									onClick={() => void deleteSegment(info.path)}
									className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
								>
									Delete
								</button>
							)}
							{/* The quiet inline confirmation — next to the
							    action, not the old path-echoing line at the
							    section's bottom (production-copy: no file
							    paths in user-facing status). One editor is
							    open at a time (openSegment), so one shared
							    status reads unambiguously. */}
							{segmentStatus && (
								<p className="text-xs text-muted-foreground/70" data-testid="segment-status">
									{segmentStatus}
								</p>
							)}
						</div>
					</div>
				)}
			</div>
		);
	};



	// Resolved through the SAME core resolver the server's effective
	// settings use (the GraphSection precedent): the hint and placeholder
	// report exactly the number the trigger waits for.
	const resolvedCompaction = resolveSettings(
		compaction === undefined ? null : { version: 1, compaction },
	).compaction;

	return (
		<>
			<SettingsGroup label="Models" testid="group-models">
				{MODEL_SLOTS.map((slot) => {
					const override = models?.[slot];
					const modelId = override?.model?.id ?? "";
					const provider = override?.model?.provider ?? "";
					const thinking = override?.thinkingLevel ?? "";
					// The tier's resolved pin is machinery only now (owner, fix
					// wave): the UI never names the factory fallback — the hint
					// carries the roster, the triggers read "—" when unpicked — but
					// the pin still governs the thinking level LIST when no override
					// names a model to read levels from.
					const pin = slots?.[slot];
					// The model whose levels govern the thinking list: the
					// override, else the resolved pin (when it's in the federated
					// catalog); the standard ladder as the last fallback.
					const coord = override?.model ?? pin?.model;
					const chosen = coord ? catalog?.find((m) => m.id === coord.id && m.provider === coord.provider) : undefined;
					const levels = chosen ? chosen.supportedLevels : THINKING_LEVELS;
					const thisMenuOpen = openMenu?.target === slot ? openMenu.kind : null;
					// Vision slots pick from image-capable models only.
					const slotCatalog =
						slot === "vision" ? catalog?.filter((m) => m.input.includes("image")) : catalog;
					return (
						<SettingsRow
							key={slot}
							label={SLOT_META[slot].label}
							hint={SLOT_META[slot].roster}
							testid={`slot-row-${slot}`}
						>
							{/* The anchor for the outside-click contract is the
							    span holding BOTH triggers of the open menu. */}
							<span
								ref={thisMenuOpen ? menuAnchorRef : undefined}
								className="relative flex items-center gap-2"
							>
								{slot !== "strong" && <><ChatGPTBackgroundAccess provider={coord?.provider} /><NativeSubscriptionBackgroundAccess provider={coord?.provider} /></>}
								<MenuTrigger
									value={modelId ? prettyModel(modelId) : ""}
									emptyLabel="—"
									ariaLabel={`${SLOT_META[slot].label} model`}
									testid={`slot-model-${slot}`}
									open={thisMenuOpen === "model"}
									onClick={() => setOpenMenu(thisMenuOpen === "model" ? null : { target: slot, kind: "model" })}
									widthClass="min-w-20"
								/>
								<MenuTrigger
									// Legacy display (chunk 2 item 4): no stored level + a known
									// model → the RESOLVED level (the ordering's first supported —
									// what the engine build runs). Display-only until a pick writes.
									value={thinking || (chosen ? defaultOrderLevel(levels) : "")}
									emptyLabel="—"
									ariaLabel={`${SLOT_META[slot].label} thinking`}
									testid={`slot-thinking-${slot}`}
									open={thisMenuOpen === "thinking"}
									onClick={() => setOpenMenu(thisMenuOpen === "thinking" ? null : { target: slot, kind: "thinking" })}
									widthClass="w-20"
								/>
								{thisMenuOpen === "model" && (
									<MenuShell
										preferredSide="down"
											anchorTestid={`slot-model-${slot}`}
										testid={`slot-model-menu-${slot}`}
										menuClass="flex w-[22rem] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
									>
										<ModelMenuList
											models={slotCatalog ?? undefined}
											effectiveId={modelId}
											effectiveProvider={provider}
											onPick={(entry) => {
												// Auto-populate (chunk 2, owner: "populate everywhere"): the
												// fresh pick writes a level — the stored one rides as-is
												// (the write clamps server-side), else the ordering's level.
												const next = populateLevel(thinking || undefined, entry.supportedLevels);
												onModelsChange(composeSlotModel(models, slot, entry.provider, entry.id, next));
												setOpenMenu(null);
											}}
											footer={
												catalog && catalog.length === 0
													? "No models — add a provider key in Keys"
													: "Runs every agent of this tier"
											}
										/>
									</MenuShell>
								)}
								{thisMenuOpen === "thinking" && (
									<MenuShell
										preferredSide="down"
											anchorTestid={`slot-thinking-${slot}`}
										testid={`slot-thinking-menu-${slot}`}
										menuClass="flex w-44 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
									>
										<ThinkingMenuList
											levels={levels.map(String)}
											// The ✓ sits on the RESOLVED level for legacy unset records —
											// the same one the trigger shows.
											effectiveLevel={thinking || (chosen ? defaultOrderLevel(levels) : undefined)}
											onPick={(level) => {
												onModelsChange(composeSlotModel(models, slot, provider, modelId, level));
												setOpenMenu(null);
											}}
										/>
									</MenuShell>
								)}
							</span>
						</SettingsRow>
					);
				})}
			</SettingsGroup>

			<SettingsGroup label="Tools" testid="group-tools">
				{/* The prober's graph tools (wave 7, owner ruling 2026-09-23):
				    FIRST row of the group — its subject is the map, its
				    mechanism is agent capability, so it lives in Tools but
				    NOT in the tool-toggles list. Its own agent-section key
				    (agent.graphTools), the search-row hint discipline: a
				    smaller line under it explaining what it is — this
				    connects prior sessions' knowledge into new ones. */}
				{(() => {
					const graphOn = graph?.enabled ?? true;
					return (
						<SettingsRow
							label="Graph tools"
							hint={graphOn ? "Lets the tutor consult your knowledge map between sessions" : "Graph is disabled"}
							testid="graph-tools-row"
							dimmed={!graphOn}
						>
							<Toggle
								checked={agent?.graphTools?.enabled ?? true}
								disabled={!graphOn}
								label="graph tools"
								onChange={(on) => onSectionChange(composeGraphTools(agent, on))}
							/>
						</SettingsRow>
					);
				})()}
				{/* The quizzing mechanic (owner 2026-09-27): segmented — exactly one
				    of Multiple choice / Free recall is active; the choice swaps which
				    quizzing tool BOTH agents carry (prober checks + teach checks).
				    Persisted as agent.tools.explain; absent = Multiple choice. */}
				{(() => {
					const free = agent?.tools?.explain === true;
					return (
						<SettingsRow
							label="Quizzing"
							hint="How both tutors check your understanding"
							testid="quiz-mechanics-row"
						>
							<div
								role="radiogroup"
								aria-label="Quizzing mechanics"
								className="flex rounded-lg border border-border/60 bg-muted/30 p-0.5"
								>
								{(["choice", "free"] as const).map((m) => {
									const active = m === "free" ? free : !free;
									return (
										<button
											key={m}
											type="button"
											role="radio"
											aria-checked={active}
											data-testid={`quiz-mechanics-${m}`}
											onClick={() => onSectionChange(composeQuizMechanics(agent, m))}
											className={cn(
												"h-8 rounded-md px-3 text-sm font-medium transition-colors",
												active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
											)}
										>
											{m === "choice" ? "Multiple choice" : "Free recall"}
										</button>
									);
								})}
							</div>
						</SettingsRow>
					);
				})()}
				{TOGGLE_TOOLS.map((id) => (
					<SettingsRow
						key={id}
						label={`Tool · ${id}`}
						testid={`tool-row-${id}`}
					>
						<Toggle
							checked={agent?.tools?.[id] ?? true}
							label={`tool ${id}`}
							onChange={(on) => onSectionChange(composeTool(agent, id, on))}
						/>
					</SettingsRow>
				))}
				{(() => {
					const engine = agent?.search?.engine ?? null;
					const anyKey = engineKeys.tavily === true || engineKeys.brave === true;
					const open = openMenu?.target === "search";
					return (
						<SettingsRow
							label="Search engine"
							hint={search?.reason ?? undefined}
							testid="search-engine-row"
							dimmed={!anyKey}
						>
							<span ref={open ? menuAnchorRef : undefined} className="relative flex items-center gap-2">
								<MenuTrigger
									value={engine === "tavily" ? "Tavily" : engine === "brave" ? "Brave" : ""}
									emptyLabel="Automatic"
									ariaLabel="Search engine"
									testid="search-engine-trigger"
									open={open}
									onClick={() => setOpenMenu(open ? null : { target: "search", kind: "engine" })}
									widthClass="min-w-20"
									disabled={!anyKey}
								/>
								{open && (
									<MenuShell
										preferredSide="down"
											anchorTestid="search-engine-trigger"
										testid="search-engine-menu"
										menuClass="flex w-44 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
									>
										{engineOption("auto", "Automatic", engine === null, null, () => {
											onSectionChange(composeSearchEngine(agent, null));
											setOpenMenu(null);
										})}
										{SEARCH_ENGINES.map((id) =>
											engineOption(id, id === "tavily" ? "Tavily" : "Brave", engine === id, engineKeys[id] ?? false, () => {
												onSectionChange(composeSearchEngine(agent, id));
												setOpenMenu(null);
											}),
										)}
									</MenuShell>
								)}
							</span>
						</SettingsRow>
					);
				})()}
			</SettingsGroup>

			<SettingsGroup label="Context" testid="group-context">
				<SettingsRow
					label="Compaction threshold"
					hint={`${resolvedCompaction.thresholdTokens} tok`}
					testid="compaction-row-threshold"
				>
					<CommitInput
						type="number"
						value={String(compaction?.thresholdTokens ?? "")}
						placeholder={String(resolvedCompaction.thresholdTokens)}
						ariaLabel="compaction threshold"
						testid="input-compaction-threshold"
						onCommit={(v) => {
							// Empty = factory default (the budget row's discipline):
							// absence is the unset for numbers.
							if (v === "") {
								onCompactionChange({ ...compaction, thresholdTokens: undefined });
								return;
							}
							const n = Number(v);
							if (!Number.isFinite(n) || n <= 0) return; // bad input: no write
							// Mirror the server floor (anti-churn: each compaction
							// keeps a ~20k-token tail); no ceiling — the effective
							// trigger is min(threshold, contextWindow − 16k) anyway.
							onCompactionChange({
								...compaction,
								thresholdTokens: Math.max(COMPACTION_THRESHOLD_FLOOR, Math.round(n)),
							});
						}}
					/>
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup label="System prompts" testid="group-prompts">
				{prompts === null ? (
					<p className="text-xs text-muted-foreground/70">Loading prompt segments…</p>
				) : (
					<div className="flex flex-col gap-4">
						{/* The owner's ruled order (2026-09-26): Teacher first,
						    then Prober, then Shared LAST — shared chunks once
						    (deduplicated), each section in prompt-assembly
						    order. */}
						{sectionedSegments(prompts).map((section) => (
							<div key={section.id} data-testid={`prompt-section-${section.id}`}>
								<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">
									{section.label}
								</p>
								{section.hint && (
									<p className="mb-1 text-xs text-muted-foreground/60">{section.hint}</p>
								)}
								<div className="flex flex-col gap-2">
									{section.segments.map((info) => segmentRow(info))}
								</div>
							</div>
						))}
					</div>
				)}
			</SettingsGroup>
		</>
	);
}
