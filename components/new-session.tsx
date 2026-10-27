"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Composer } from "@/components/composer";
import { DictationBar, joinDictation, useDictation } from "@/components/dictation";
import { useFieldCycle } from "@/components/field-cycle";
import { SidebarToggle } from "@/components/sidebar";
import { SetupDialog } from "@/components/setup-dialog";
import { useModelSetup, selectedModelUnavailable, openModelPicker, ZeroKeysPill } from "@/components/setup-cta";
import { StatsBar } from "@/components/stats-bar";
import { ChainTableOverlay } from "@/components/chain-table.tsx";
import { ComposerActions, NodePickerControl } from "@/components/composer-actions";
import { OPENING_PROMPT_FAILURE } from "@/components/opening-prompt";
import { SessionStarter } from "@/components/start-session";
import type { ChatSettings, GraphSnapshot } from "@/src/core";

/** The draft's pick set (owner round 10): the SAME shape the home pick
 *  bar lifts — resolved nodes as the learner SAW them at pick time. */
export type DraftPick = { id: string; name: string; statement: string };

/**
 * The sessionless draft view at /chat/new (owner, 2026-09-13): "+ New
 * session" opens THIS, never a created record — a session comes to exist
 * only when the learner sends the first message, and that message becomes
 * the session's title (the exact create-then-redirect contract the home
 * composer established). Visually identical to a fresh chat: same header
 * (title + probe chip), the same empty state, the same composer blob +
 * stats dock. The draft's model control binds the strong slot (the
 * new-session default); the created session is stamped from it
 * server-side (per-session models, owner 2026-09-28).
 */

const DOCK = "mx-auto w-full max-w-[46rem] px-4";

/**
 * Create, safely hand over the full opening text, then return a short
 * /chat/<id> target. Storage/creation failures leave the caller's draft
 * intact. A per-composer starter reuses an already-created session on an
 * unchanged retry. The server stamps settings at birth; no settings PUT.
 */
export async function startDraftSession(
	text: string,
	fetchLike: typeof fetch,
	mode?: "practice",
	picks?: readonly DraftPick[],
	starter = new SessionStarter(),
	settingsIdentity?: string,
): Promise<string | null> {
	const t = text.trim();
	if (!t) return null;
	// THE PICKS RIDE THE CREATE (owner round 10): a practice draft seeded
	// from the pick bar creates its session WITH the graph context — the
	// same contract as the home screen's practice send (the marker with
	// [id] name: statement lines, target validation's truth set).
	return starter.start(
		mode === "practice"
			? { title: t, kind: "practice", ...(picks && picks.length > 0 ? { graphContext: { propositions: picks } } : {}) }
			: { title: t },
		fetchLike,
		settingsIdentity,
	);
}

/** The pure shell (no router) — the render-test seam: the draft view's
 *  visible surface, assembled from the same pieces a fresh chat shows. */
/* FINISH-FIRST SEND + RUN-END FOCUS live in the shell (it owns the
 * dictation instance); the truth of the text stays in the parent, whose
 * send reads a REF mirror — see NewSession below. */
export function DraftShell({
	busy,
	text,
	onChange,
	onSend,
	startError = false,
	setupCta,
	mode = "teach",
	picks = [],
	onOpenPicker,
	onClearPicks,
	overlay,
}: {
	busy: boolean;
	text: string;
	onChange: (v: string) => void;
	onSend: () => void;
	startError?: boolean;
	/** The practice draft (owner, 2026-10-04): ?mode=practice — the
	 *  created session carries kind:"practice" and the copy changes
	 *  (the practice agent opens; no probing). */
	mode?: "teach" | "practice";
	/** The first-run CTA (fix wave chunk B): the same "Set up your models"
	 *  affordance home carries, rendered above the draft shell — passed by
	 *  NewSession, which owns the configured state and the SetupDialog. */
	setupCta?: ReactNode;
	/** THE PICK BAR (owner round 10): the SAME pill the home screen
	 *  carries above its composer — dashed "Pick nodes" when empty,
	 *  count + Clear when picked. The draft screen has
	 *  no graph behind it, so the picker opens the standalone chain-table
	 *  overlay over fetched snapshot data (owned by NewSession). */
	picks?: DraftPick[];
	onOpenPicker?: () => void;
	onClearPicks?: () => void;
	/** THE PICKER SLOT (owner round 10b): the chain-table overlay hosts
	 *  INSIDE the content column's relative container — the same law as
	 *  the graph view (the overlay fills its column, never the sidebar).
	 *  Passed as a node so the pick state stays in NewSession. */
	overlay?: ReactNode;
}) {
	// Voice dictation (STT wave, 2026-09-17): finals append at the end of the
	// draft text (via the parent's onChange — the truth lives there); the
	// strip lives in the stats bar's middle slot.
	// Tab navigates INTO the composer (owner, keyboard round 2026-10-06):
	// the only text field on this surface — the cycle's whole chain.
	const cycleComposer = useCallback((): readonly HTMLElement[] =>
		Array.from(document.querySelectorAll<HTMLElement>('[data-testid="composer"] textarea')),
		[]);
	useFieldCycle(cycleComposer);
	const dictation = useDictation({
		append: (t) => onChange(joinDictation(text, t)),
	});
	// A LIVE dictation keeps the composer sendable ("nothing gets lost"
	// round, owner 2026-10-01): the spoken text is deferred in the run's
	// buffer — Enter must reach the finish-first send, not be gated out by
	// an empty textarea. Nothing said → the send no-ops.
	const canSend = text.trim().length > 0 || dictation.active;
	/* FINISH DICTATION FIRST (owner, 2026-10-01): stop the run, let the
	 * last finals land through onChange, THEN call the parent's send —
	 * which reads its REF mirror, so the post-await timing of React's
	 * re-render cannot eat the dictated tail. */
	const handleSend = () => {
		if (dictation.active) {
			void dictation.finish().then(onSend);
			return;
		}
		onSend();
	};
	/* Run end focuses the composer (owner, 2026-10-01): the hands are on
	 * the keyboard from the stop — falling edge of `active` only. */
	const composerInputRef = useRef<HTMLTextAreaElement>(null);
	const dictationWasActiveRef = useRef(false);
	useEffect(() => {
		if (dictation.active) {
			dictationWasActiveRef.current = true;
		} else if (dictationWasActiveRef.current) {
			dictationWasActiveRef.current = false;
			composerInputRef.current?.focus();
		}
	}, [dictation.active]);
	return (
		/* CHROME-LESS CREATION SURFACE (owner round 11, 2026-10-05): the
		 * drafts join home's register — no TopBar, no title (the serif title
		 * always names a session; a draft has none). Home's proven pattern
		 * verbatim: a drag mask first in the DOM, a floating reopen toggle
		 * (the only pointer-events-auto spot), the empty state carrying the
		 * orientation. The chain picker then owns the column top exactly
		 * like the graph view's — no stacked bars. */
		<div className="relative flex h-dvh">
			{/* Window-drag strip — deliberately FIRST in the DOM (the mask
			    law: no-drag subtraction resolves by DOM order, so every
			    carved control later in the tree subtracts correctly). */}
			<div className="lh-drag absolute inset-x-0 top-0 h-13" aria-hidden="true" />
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="relative flex min-h-0 flex-1">
					{/* The pointer-events pattern (953b22b): the sticky wrapper is
					    pointer-events-none so nothing here blocks the empty-state
					    area; the blob and the stats row re-enable it themselves. */}
					<div className="pointer-events-none sticky bottom-0 mt-auto w-full">
						<Conversation className="h-full min-w-0 flex-1" initial="instant">
							<ConversationContent className="min-h-full gap-0 p-0">
								<ConversationEmptyState
									title={mode === "practice" ? "New practice session" : "New session"}
									description={
										mode === "practice"
											? "Pick nodes from your knowledge graph, describe what you want to practice, or bring your own problem."
											: "The teacher will open by probing what you already know."
									}
								/>
							</ConversationContent>
						</Conversation>
						<div className="h-24 bg-gradient-to-t from-background via-background/85 to-transparent" />
						<div className="bg-background pb-4">
							<div className={DOCK}>
								<ComposerActions
									picker={(picks.length > 0 || mode === "practice") && (
										<NodePickerControl count={picks.length} onOpen={onOpenPicker} onClear={onClearPicks} />
									)}
									setup={setupCta}
								/>
								{startError && <p role="alert" className="pointer-events-auto mb-2 text-sm text-destructive">{OPENING_PROMPT_FAILURE}</p>}
								<div className="pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg">
									<Composer
										busy={busy}
										value={text}
										onChange={onChange}
										onSend={handleSend}
										onStop={() => {}}
										canSend={canSend}
										inputRef={composerInputRef}
										autoFocus
										onEscape={dictation.active ? dictation.cancel : undefined}
										// The opening question, same as the graph view's new-session
										// input (owner refinement round, 2026-09-24) — no lesson has
										// started yet, so the composer must not read like one is in
										// flight.
										placeholder={mode === "practice" ? "What do you want to practice?" : "What do you want to learn?"}
									/>
								</div>
								<StatsBar
									dictationSlot={<DictationBar dictation={dictation} />}
									turns={[]}
								/>
							</div>
						</div>
					</div>
					{overlay}
				</div>
			</div>
			{/* The floating reopen toggle — pointer-events-none except the
			    toggle itself (home's pattern), painted AFTER the overlay's
			    column so nothing of it blocks the canvas area. */}
			<header className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 px-3 py-2">
				<div className="pointer-events-auto">
					<SidebarToggle />
				</div>
			</header>
		</div>
	);
}

export function NewSession({ initialConfigured, mode = "teach" }: { initialConfigured: boolean; mode?: "teach" | "practice" }) {
	const router = useRouter();
	const [text, setText] = useState("");
	/* The draft MIRROR ("nothing gets lost" round, 2026-10-01): the shell's
	 * finish-first send calls THIS send after the dictation flush — which
	 * landed via setState and may not have re-rendered yet. The send reads
	 * the mirror; every write keeps it current. */
	const textRef = useRef("");
	const applyText = (v: string) => {
		textRef.current = v;
		setText(v);
	};
	const [busy, setBusy] = useState(false);
	const startingRef = useRef(false);
	const starterRef = useRef(new SessionStarter());
	const [startError, setStartError] = useState(false);
	// THE PICK BAR (owner round 10): the draft's lifted pick set + the
	// snapshot the standalone chain-table picker reads. Lazy — the graph
	// is fetched on FIRST open only, then reused.
	const [picks, setPicks] = useState<DraftPick[]>([]);
	const picksRef = useRef<DraftPick[]>([]);
	const applyPicks = (next: DraftPick[]) => {
		picksRef.current = next;
		setPicks(next);
	};
	const [pickerOpen, setPickerOpen] = useState(false);
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const openPicker = () => {
		if (snapshot) {
			setPickerOpen(true);
			return;
		}
		void fetch("/api/graph")
			.then((r) => r.json() as Promise<GraphSnapshot>)
			.then((snap) => {
				setSnapshot(snap);
				setPickerOpen(true);
			})
			.catch(() => {
				/* an unreachable graph leaves the draft usable — pickless */
			});
	};

	// First-run gate (model-slots wave, owner 2026-09-20): the send
	// INTERCEPTS into the setup flow while unconfigured — no defaults for
	// 33 providers, chats cannot start. The draft stays in the textarea;
	// Save stores the slots and never sends (owner ruling 2026-10-09) —
	// the learner sends the draft themselves.
	const { catalog, configured, zeroKeys } = useModelSetup(initialConfigured);
	const [setupOpen, setSetupOpen] = useState(false);

	const send = useCallback(() => {
		const draft = textRef.current.trim();
		if (!draft || startingRef.current) return;
		if (!configured) {
			setSetupOpen(true);
			return;
		}
		// The pre-send KEY guards (owner interlude, no-orphan-chats): guard
		// BEFORE startDraftSession creates the record — a refused first
		// send would otherwise leave an orphan error-shell chat in the
		// sidebar. Zero providers opens connection setup; an unavailable
		// selection with another provider opens the ordinary Strong picker.
		// The server's admission gate remains the belt.
		if (zeroKeys) {
			setSetupOpen(true);
			return;
		}
		const strong = catalog?.slots.strong?.model;
		if (selectedModelUnavailable(catalog, strong ? `${strong.provider}:${strong.id}` : undefined)) {
			openModelPicker();
			return; // The learner replaces it explicitly, then sends again.
		}
		startingRef.current = true;
		setBusy(true);
		setStartError(false);
		void startDraftSession(draft, fetch, mode === "practice" ? "practice" : undefined, mode === "practice" ? picksRef.current : undefined,
			starterRef.current, JSON.stringify(catalog?.slots.strong))
			.then((target) => {
				if (target) router.push(target);
				else { startingRef.current = false; setBusy(false); }
			})
			.catch(() => {
				startingRef.current = false;
				setBusy(false);
				setStartError(true);
			});
	}, [router, configured, zeroKeys, catalog, mode]);

	return (
		<>
			<DraftShell
				busy={busy}
				startError={startError}
				text={text}
				onChange={applyText}
				onSend={send}
				mode={mode}
				picks={picks}
				onOpenPicker={openPicker}
				onClearPicks={() => applyPicks([])}
				overlay={
					// THE PICKER (owner round 10b): hosted INSIDE the content
					// column — absolute inset-0 resolves to the column's relative
					// container, the same confinement the graph view gives it;
					// never over the sidebar or the traffic lights.
					<ChainTableOverlay
						open={pickerOpen}
						nodes={snapshot?.propositions ?? []}
						chains={snapshot?.chains ?? []}
						sessions={snapshot?.sessions ?? {}}
						fileSources={snapshot?.fileSources ?? {}}
						onClose={() => setPickerOpen(false)}
						selectMode
						controlledSelection={new Set(picks.map((p) => p.id))}
						onSelectionChange={(ids) => {
							const byId = new Map((snapshot?.propositions ?? []).map((n) => [n.id, n]));
							const next: DraftPick[] = [];
							for (const id of ids) {
								const n = byId.get(id);
								if (n) next.push({ id: n.id, name: n.name, statement: n.statement });
							}
							applyPicks(next);
						}}
					/>
				}
				setupCta={
					zeroKeys ? (
						<ZeroKeysPill inline onOpen={() => setSetupOpen(true)} />
					) : (
						!configured && (
							<button
								type="button"
								data-testid="setup-cta"
								onClick={() => setSetupOpen(true)}
								className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent cursor-pointer"
							>
								Set up your models
							</button>
						)
					)
				}
			/>
			{/* First-run setup: the send interception's landing surface — stage
			    1 is the self-contained first-key screen (zero-keys wave). */}
			<SetupDialog
				open={setupOpen}
				onClose={() => setSetupOpen(false)}
				onDone={() => {
					setSetupOpen(false);
					// Save only saves (owner ruling 2026-10-09): the draft
					// waits in the composer; the learner sends it.
				}}
				/>
		</>
	);
}