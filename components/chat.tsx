"use client";

import { createContext, Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChatSession } from "@/components/session";
import { visibleQueuedSteers } from "@/components/session-core";
import { SetupDialog } from "@/components/setup-dialog";
import { Hint } from "@/components/ui/hint";
import { useZeroKeys, ZeroKeysPill } from "@/components/setup-cta";
import { useStickToBottomContext, type StickToBottomContext } from "use-stick-to-bottom";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { BrailleSpinner } from "@/components/braille-spinner";
import { LiveToolCard } from "@/components/artifacts/live-tool-card";
import { Separator } from "@/components/ui/separator";
import { AnsweredCard } from "@/components/answered-card";
import { artifactRenderers } from "@/components/artifacts";
import { SubagentSteerCard } from "@/components/artifacts/steer-card";
import { Composer } from "@/components/composer";
import { useEnterSubmits } from "@/components/enter-submits";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { dockStateKey } from "@/components/dock-state-key";
import { QueuedSteersBody, type QueuedSteerLine } from "@/components/queued-steers";
import { DictationBar, finishDictation, joinDictation, useDictation } from "@/components/dictation";
import { useFieldCycle } from "@/components/field-cycle";
import { JobsContext } from "@/components/jobs-context";
import { StatsBar } from "@/components/stats-bar";
import { useServerEvent, useServerResync } from "@/components/server-events";
import {
	isProviderKeyRefusal,
	firstSourceTextParts,
	messageAnchorId,
	textPartMessageId,
	kbdEventForAction as kbdEventForChat,
	type ChatInput,
	type ChatSettings,
	type LhMessage,
	type ModelSlotName,
} from "@/src/core";
import { PlanBlock, PlanPopup, latestTree } from "@/components/plan-block";
import { PlanMarginalia, planExists } from "@/components/plan-window";
import { MermaidOverlay, SessionMermaidContext } from "@/components/session-overlay";
import { AbortTurnDialog, type AbortMode } from "@/components/abort-turn-dialog";
import { ArrowRightIcon, DumbbellIcon, WaypointsIcon } from "lucide-react";
import type { PlanBlockData } from "@/src/core";
import { QuestionDock } from "@/components/question-dock";
import { SessionFind } from "@/components/session-find";
import { SessionMessageNavigation } from "@/components/session-navigation";
import { PracticeDock } from "@/components/practice-dock";
import { ThinkingCard, type PracticeThinkingData } from "@/components/practice-cards";
import { GraphContextCard, type GraphContextData } from "@/components/graph-context-card";
import { TopBar } from "@/components/top-bar";
import type { ArtifactPartProps, JobRecord, Phase3, QuestionAnswerData, QuestionFormDraft, TurnUsage, SessionPricing } from "@/src/core";
import type { LhViewMessage } from "@/src/core";
import { PhaseChip, PhaseDivider } from "@/components/phase-divider";
import {
	CompactionCutDivider,
	CompactionMomentDivider,
	type CompactionDividerData,
} from "@/components/compaction-divider";
import { CoverageRing } from "@/components/extraction-coverage";
import {
	activeProblemOf,
	dismissedAnswer,
	findPendingToolCall,
	phaseAt3,
	phaseTimeline,
	teachStepIndex,
	toolQuestionKind,
	questionNeedsReveal,
} from "@/src/core";
import { ReadingThinkingField } from "@/components/reading-thinking";
import { currentUserThinkingOpen, setAllUserThinkingOpen } from "@/components/thinking-block";
import { slotsConfigured, type ModelsSettings } from "@/src/core";
import { useSettingsSaved } from "@/components/settings-signal";

/** One width for everything: transcript, cards, and the bottom blob share this column. */
/**
 * Width tokens (wave-5 reskin, owner decision): the teaching PROSE spans the
 * full session width with a thin px-6 margin; the composer/question DOCK is
 * deliberately narrower (~46rem centered) per the reference. Same ELEMENT,
 * same place — width polish only.
 */
const COLUMN = "mx-auto w-full max-w-none px-6";
const DOCK = "mx-auto w-full max-w-[46rem] px-4";
// The DOCK container's fixed width (46rem) and the plan marginalia's
// geometry (owner, plan-placement round): the bare diagram sits in the
// dock band's RIGHT flank — MARGIN_GAP from the DOCK container's edge and
// the same from the column's right edge. The box width is pure CSS, so
// the diagram shrinks CONTINUOUSLY with the flank; MARGIN_MIN_W is only
// the fade floor (owner, resize round) — below it the marginalia fades
// out over the normal transition instead of popping away, and it stays
// mounted while the question owns the band so widening fades it back.
const DOCK_W = 46 * 16;
const MARGIN_GAP = 16;
const MARGIN_MIN_W = 220;
// The dock overlay's gradient band (h-24) — part of the reserved tail.
const GRADIENT_H = 96;
// Fold thresholds (owner, scroll round 1, tuned round 3): pixel distance
// from the bottom — position, not velocity. Leave the bottom → the box
// folds (visual only); reach it again → it re-opens. 96 (was 64, owner
// round 3) tolerates a small peek upward without folding; the dead band
// vs EXPAND_DIST absorbs trackpad drift.
const COLLAPSE_DIST = 96;
const EXPAND_DIST = 16;

/**
 * Server-sync channel for artifact renderers: the CENTRAL jobs poll in Chat
 * calls syncFromServer() when a background job settles — the wake turn's
 * steer + response are already persisted by then, so fresh messages replace
 * local state in one pull. sendText feeds the demo error-fix loop.
 * (contracts.ts "THE ASYNC PROTOCOL" §4.)
 */
export const ChatActionsContext = createContext<{
	chatId: string;
	syncFromServer: () => Promise<void>;
	/** Send a user message into the session (demo error-fix loop, W6). */
	sendText: (text: string) => void;
	/** Opens the model setup dialog (BYOK, 2026-09-22): refused job cards
	 *  deep-link into the same SetupDialog the send interception uses. */
	openSetup: () => void;
} | null>(null);

/** The BYOK refusal envelope from the transport's error text: the
 *  DefaultChatTransport throws the 503 body VERBATIM as the error message,
 *  so the machine-readable {code, missing} shape survives to here. Real
 *  errors (any other text) read as null and keep the honest banner.
 *  Exported pure for tests. */
export function parseModelsRefusal(message: string | undefined): ModelSlotName[] | null {
	if (!message) return null;
	try {
		const body = JSON.parse(message) as { code?: unknown; missing?: unknown };
		if (body.code === "models_not_configured" && Array.isArray(body.missing)
			&& body.missing.every((s) => typeof s === "string")) {
			return body.missing as ModelSlotName[];
		}
		return null;
	} catch {
		return null;
	}
}

/** The provider-key refusal's transport seam (zero-keys wave, Platform's
 *  66dbea9): same discipline as parseModelsRefusal — the 503 body rides
 *  the thrown error message verbatim, so the envelope's own matcher
 *  (core, invariant-tail) decides; the wording can never drift client-
 *  side. Exported pure for tests. */
export function parseProviderKeyRefusal(message: string | undefined): boolean {
	if (!message) return false;
	try {
		const body = JSON.parse(message) as { code?: unknown; error?: unknown };
		return body.code === "provider_key_missing" && typeof body.error === "string" && isProviderKeyRefusal(body.error);
	} catch {
		return false;
	}
}

/** useLayoutEffect that is silent during SSR (client components still render on the server in Next). */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** A wake-pipeline steer message: user-role delivery whose metadata marks it
 * as a sub-agent result — rendered as an artifact card, never a bubble. */
/** The quiet system line (custom-message scheme rendering): centered, muted,
 *  small — the transcript's voice for events that are not speech (wake
 *  scaffolding). */
function SystemLine({ children, testId }: { children: React.ReactNode; testId?: string }) {
	return (
		<div
			data-testid={testId}
			className="flex items-center justify-center gap-1.5 py-1 text-xs text-muted-foreground"
		>
			{children}
		</div>
	);
}

function isSubagentSteer(m: LhViewMessage): boolean {
	return (m.metadata as { subagentResult?: unknown } | undefined)?.subagentResult != null;
}

/**
 * The teaching session. All chat state lives in useChat; the server persists
 * the canonical transcript after every turn.
 *
 * The bottom blob is ONE persistent shell whose contents swap (chat composer ↔
 * question dock ↔ collapsed bar). The shell is sticky INSIDE the scroller —
 * never overlapping the transcript at rest, never covering the scrollbar —
 * and DockOverlay animates its height on variant changes.
 */
export function Chat({
	chatId,
	title,
	initialMessages,
	initialError,
	initialPrompt,
	initiallyInFlight,
	initiallyCompacting = false,
	initialConfigured = false,
	kind = "teach",
}: {
	chatId: string;
	title: string;
	initialMessages: LhMessage[];
	/** Memory-only settlement notice supplied on reopening. */
	initialError?: string;
	/** The session kind (practice sessions, owner 2026-10-04): practice
	 *  renders no phase chip (no probe→teach arc applies) and a Practice
	 *  tag rides the header instead. */
	kind?: "teach" | "practice";
	initialPrompt?: string;
	/** A teacher turn is running server-side but attached to no client
	 * (navigated away mid-turn, returned while in flight). */
	initiallyInFlight?: boolean;
	/** A compaction holds the chat's model gate at mount (navigated away
	 * mid-compaction — the registry is live server state, the
	 * compaction-changed event already fired). The transcript spinner
	 * and send gates key on it. */
	initiallyCompacting?: boolean;
	/** slotsConfigured(server record) — the persistent setup CTA keys on
	 *  it (BYOK, owner 2026-09-22). The server gate stays the truth; this
	 *  only decides whether the pill rides the composer. */
	initialConfigured?: boolean;
}) {
	// Reattach plumbing (background-turn runner wave): the hook holds the
	// settled terminal's callback — a stable ref assigned below, once
	// syncFromServer exists (refs, not closures: no stale capture).
	const reattachSettledRef = useRef<() => void>(() => {});

	// THE SESSION HOOK (Wave D, owner-approved 2026-09-26): the app-owned
	// replacement for useChat + the AI-SDK transport. The record is native
	// history; the VIEW (grouped, golden-master) is derived client-side
	// (core/view.ts projectView); sends are ONE explicit input event each
	// ({chatId, input} — the stash indirection died with the SDK), and the
	// turn stream is the VERBATIM AgentEvent passthrough the server emits.
	const { messages, nativeMessages, contextTokens, send, continueIfOwed, steer, steerQueue, submitAnswer, dismissQuestion, dismissProblem, questionDraft, saveQuestionDraft, setMessages, adoptRecord, status, error, stop, clearError, resumeStream, setReattachSettled } =
		useChatSession({ chatId, initialMessages, initialError, initiallyInFlight });

	const sessionFindScopeRef = useRef<HTMLDivElement | null>(null);
	const scrollContextRef = useRef<StickToBottomContext | null>(null);
	const sourceTextParts = useMemo(() => firstSourceTextParts(messages), [messages]);

	// The reattach settled terminal → the sync-and-continue seam (below).
	setReattachSettled(() => reattachSettledRef.current());

	// New chat with a topic: send the first message exactly once
	// (initialPromptOwed — the pure gate, pinned in the test suite).
	const sentInitial = useRef(false);
	useEffect(() => {
		if (!sentInitial.current && initialPromptOwed(initialMessages, initialPrompt)) {
			sentInitial.current = true;
			void send({ type: "text", text: initialPrompt! });
		}
	}, [initialPrompt, initialMessages, send]);

	// A turn running server-side, attached to no live view of ours (navigate
	// away mid-turn, or a wake turn discovered mid-session): the reattach
	// stream is the primary channel (resumeStream — the same rendering path
	// as a live turn); this flag is the FALLBACK liveness source — it gates
	// the composer, shows the pre-first-chunk shimmer, and drives the 1500ms
	// record poll that adopts at settle if the stream can't attach.
	const [turnInFlight, setTurnInFlight] = useState(initiallyInFlight ?? false);

	// Session title: click-to-rename (owner, 2026-09-17). Clicking the header
	// title opens edit mode with everything selected — typing replaces, arrows
	// move inside. Enter or a click away commits (PUT /api/chats/:id); Escape
	// discards. The server never bumps updatedAt on a rename (sidebar order
	// must not churn), and the sidebar patch is instant via the window event —
	// its 2.5s poll is only a backstop.
	const [titleText, setTitleText] = useState(title);
	const [renaming, setRenaming] = useState(false);
	const [titleDraft, setTitleDraft] = useState("");
	const titleInputRef = useRef<HTMLInputElement | null>(null);

	const commitRename = useCallback(
		async (next: string) => {
			setRenaming(false);
			const t = next.trim();
			if (t === "" || t === titleText) return; // empty commit = discard
			try {
				const res = await fetch(`/api/chats/${chatId}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: t }),
				});
				if (!res.ok) throw new Error(`rename failed: ${res.status}`);
				setTitleText(t);
				window.dispatchEvent(
					new CustomEvent("lh:chat-renamed", { detail: { id: chatId, title: t } }),
				);
			} catch (err) {
				console.error("rename failed:", err); // keep the old title
			}
		},
		[chatId, titleText],
	);

	// Select-all when edit mode opens: the click means "replace", so the
	// whole title highlights on entry (owner ask, 2026-09-17).
	useEffect(() => {
		if (renaming) {
			const el = titleInputRef.current;
			if (el) {
					el.focus();
					el.select();
			}
		}
	}, [renaming]);

	// ── Keyboard seams (shortcut wave A, 2026-09-17) ──
	// F2 opens the title rename (the chat header owns the editing state).
	useEffect(() => {
		const onRename = () => {
			setTitleDraft(titleText);
			setRenaming(true);
		};
		window.addEventListener("lh:kbd-rename-session", onRename);
		return () => window.removeEventListener("lh:kbd-rename-session", onRename);
	}, [titleText]);

	// The OTHER rename surface (wave 6: the sidebar's inline rename): its
	// commit dispatches the same lh:chat-renamed event this header's rename
	// does — if it renamed THIS chat, patch the header title in place (the
	// event is the single source of truth; the header is one more listener).
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			if (id === chatId) setTitleText((prev) => (title !== prev ? title : prev));
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, [chatId]);

	// The Esc chain's last link: abort the turn. The background runner
	// decoupled turns from views, so the abort is ALWAYS the remote kill
	// (POST /api/activity/abort — any in-flight turn dies server-side, our
	// view renders the aborted-partial close when the finish arrives). A
	// LOCAL view also detaches first — stop() settles the client instantly
	// and keeps the partial; the server-side partial persists via the
	// abort's own onFinish. Inert when nothing runs (busyRef gate).
	const abortInFlightTurn = useCallback(() => {
		if (localStreamRef.current) stop();
		void fetch("/api/activity/abort", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind: "turn", id: chatId }),
		}).catch(() => {
			/* transient — the turn settles on its own; the record poll adopts */
		});
		// 409 not_running is the benign raced-settle: the stream's finish
			// already settled the view (or the poll fallback adopts) — nothing owed.
	}, [chatId, stop]);
	// ESC-abort guard (owner, 2026-10-02): the abort chain opens a confirm
	// popup EVERYWHERE (streams and pending questions alike). Both window
	// listeners fire per Esc, so the state gate here — not stopPropagation
	// ordering — is what keeps the popup's own Esc from chaining.
	// LAYERED ESC (owner, 2026-10-04): an open overlay CLAIMS Esc — closing
	// itself — before the abort chain may open its confirm. A mermaid focus,
	// the plan popup, or the setup dialog over a pending question must not
	// dismiss the question underneath.
	const [abortAsk, setAbortAsk] = useState<AbortMode | null>(null);
	const abortAskRef = useRef<AbortMode | null>(null);
	abortAskRef.current = abortAsk;
	useEffect(() => {
		const onAbort = () => {
			const target = escAbortTarget({
				abortAsk: abortAskRef.current !== null,
				mermaidFocus: mermaidFocusRef.current !== null || figureFocusRef.current !== null,
				planOpen: planOpenRef.current,
				setupOpen: setupOpenRef.current,
				pending: pendingRef.current !== null,
				problem: activeProblemRef.current !== null,
				busy: busyRef.current,
			});
			if (target === "question") setAbortAsk("question");
			else if (target === "problem") setAbortAsk("problem");
			else if (target === "turn") setAbortAsk("turn");
			else if (target === "mermaid") setMermaidFocus(null);
			else if (target === "plan") setPlanOpen(false);
			// setup closes itself; null = nothing to do — both claimed.
		};
		window.addEventListener("lh:kbd-abort-turn", onAbort);
		return () => window.removeEventListener("lh:kbd-abort-turn", onAbort);
	}, []);
	const confirmAbort = useCallback(
		(mode: AbortMode) => {
			setAbortAsk(null);
			if (mode === "turn") {
				abortInFlightTurn();
				return;
			}
			// From a pending question the dismiss is silent (A2, 2026-10-03):
			// the skipped toolResult lands via the SILENT route, no turn, no
			// wake — the next plain send is the wake. MID-TURN (owner,
			// 2026-10-04 — the GLM loop): the question can only dangle because a
			// turn is STILL RUNNING, so the discard ALSO kills that turn; the
			// route parks the dismissal (202) and the settle applies it.
			const p = pendingRef.current;
			if (p) {
				const question = (p.input as { question?: string } | null)?.question ?? "";
				const reading = readingThinkingRef.current.trim() || undefined;
				clearReadingThinking();
				const answer = dismissedAnswer(toolQuestionKind(p.tool), question);
				void dismissQuestion(
					p.toolCallId,
					reading ? { ...answer, readingThinking: reading } : answer,
				);
				if (busyRef.current) abortInFlightTurn();
				return;
			}
			// The practice discard (owner, 2026-10-04): ask-style — the
			// silent marker route; the conclude synthesis rides the user's
			// next input. The composer returns immediately. Mid-turn the
			// discard also kills the running turn (same park + settle law).
			const problem = activeProblemRef.current;
			if (problem) {
				void dismissProblem(problem.toolCallId);
				if (busyRef.current) abortInFlightTurn();
			}
		},
		[abortInFlightTurn, dismissQuestion, dismissProblem],
	);
	// Mount continuation: if the stored transcript ends with a fulfilled tool
	// (a job result landed while no client was open), resume the lesson — the
	// SDK's sendAutomaticallyWhen only fires inside addToolOutput, so reloads
	// need this nudge. Once per mount; the turn that follows ends in text (or
	// a pending question), so no loop. NEVER while a turn is already running
	// server-side — that would double-run the teacher (the server would 409
	// it; the poll below resumes instead).
	const mountContinuation = useRef(false);
	useEffect(() => {
		if (mountContinuation.current) return;
		mountContinuation.current = true;
		if (!turnInFlight) continueIfOwed(initialMessages);
		// mount-only by design (turnInFlight read at initial value)
	}, []);

	const pending = findPendingToolCall(messages);
	// The abort handler reads the pending question from a ref (the window
	// listener is mount-scoped; the value it needs is render-scoped).
	const pendingRef = useRef(pending);
	pendingRef.current = pending;

	// THE ACTIVE PRACTICE PROBLEM (practice sessions, 2026-10-04): the
	// same dock-ownership rule as a pending question — an active problem
	// replaces the composer. Computed from the NATIVE record (the fold is
	// the gate the tools themselves read), not the projected view.
	const activeProblem = activeProblemOf(nativeMessages);
	const activeProblemRef = useRef(activeProblem);
	activeProblemRef.current = activeProblem;

	const localStream = status === "submitted" || status === "streaming";
	const busy = localStream || turnInFlight;
	const busyRef = useRef(busy);
	busyRef.current = busy;

	// The attach handoff (stream-reattach wave): the moment a resumed
	// stream takes over the rendering — the SDK left "ready", so
	// submitted/streaming means chunks are flowing — localStream covers
	// busy/shimmer/gates on its own. Keeping turnInFlight set would only
	// double-render the shimmer and keep the 1500ms fallback poll fighting
	// the live stream it was a fallback FOR.
	useEffect(() => {
		if (turnInFlight && (status === "submitted" || status === "streaming")) setTurnInFlight(false);
	}, [status, turnInFlight]);

	// Mid-session discovery (jobs poll, handoff watch): a server-side turn
	// exists that none of our views holds — attach to it through the same
	// resume path as mount reattach (live rendering, instant catch-up). The
	// flag stays as the fallback until the stream attaches (watcher above);
	// concurrent resume calls are SDK-guarded (a newer one aborts the older
	// request), so discovery ticks re-firing this are harmless.
	const turnInFlightRef = useRef(turnInFlight);
	turnInFlightRef.current = turnInFlight;
	const attachToRunningTurn = useCallback(() => {
		setTurnInFlight(true);
		void resumeStream();
	}, [resumeStream]);

	// The practice dock's send (ONE lane, owner 2026-10-05): POSTs the
	// thinking against the ACTIVE problem — whether it claims an answer is
	// read from the text by the agent, not declared here. Starts a turn;
	// the dock stays mounted (the problem is still active until the agent
	// concludes).
	const submitThinking = useCallback(
		(text: string) => {
			const problem = activeProblemRef.current;
			if (!problem) return;
			void send({ type: "thinking", problemCallId: problem.toolCallId, text });
		},
		[send],
	);

	// Teach-phase check (W5, vision §2): a pending QUIZ that lands once a
	// plan node is OCCUPIED (phaseAt3 "teach") starts collapsed behind a
	// "Check your understanding" reveal button; probe- and plan-phase
	// questions auto-open as today. Both teach quizzing tools obey the
	// law (owner, 2026-10-09: explain checks join quiz checks behind the
	// reveal); predictions of either mechanic and ask always arrive open.
	// A pending question can never precede its phase's seam in the transcript (the teacher's turn
	// ends at the question call), so the session's current phase IS the
	// question's phase.
	const requiresReveal = pending !== null && questionNeedsReveal(pending.tool, pending.input, phaseAt3(messages));

	/* The READING-THINKING channel (owner 2026-10-03): a draft field for
	 * thinking while reading the teaching prose, mounted while a check waits
	 * behind its reveal, riding the check answer (or its dismissal) as the
	 * separate `readingThinking` field. Reset per pending question. */
	const [readingThinking, setReadingThinking] = useState("");
	const readingThinkingRef = useRef("");

	// ⌘T (toggle-user-thinking, owner round 2026-10-07): set EVERY user
	// thinking row to one state — transcript rows default open, so the
	// first press collapses everything, the second re-expands.
	useEffect(() => {
		const onToggle = () => setAllUserThinkingOpen(!currentUserThinkingOpen());
		window.addEventListener(kbdEventForChat("toggle-user-thinking"), onToggle);
		return () => window.removeEventListener(kbdEventForChat("toggle-user-thinking"), onToggle);
	}, []);
	const applyReadingThinking = useCallback((v: string) => {
		readingThinkingRef.current = v;
		setReadingThinking(v);
	}, []);
	const clearReadingThinking = useCallback(() => {
		readingThinkingRef.current = "";
		setReadingThinking("");
	}, []);
	const pendingQuestionId = pending?.toolCallId ?? null;
	useEffect(() => {
		// Different calls never share a draft; a failed submission of THIS
		// call restores the reading channel alongside the form's snapshot.
		const reading = pendingQuestionId ? questionDraft(pendingQuestionId)?.readingThinking ?? "" : "";
		readingThinkingRef.current = reading;
		setReadingThinking(reading);
	}, [pendingQuestionId, questionDraft]);

	// The phase at every message (one linear fold): the transcript draws a
	// color-coded dotted divider at each boundary; the header chip reads the
	// session's current phase.
	const phases = useMemo(() => phaseTimeline(messages), [messages]);

	const [text, setText] = useState("");
	/* The composer's value MIRROR ("nothing gets lost" round, owner
	 * 2026-10-01): a dictation flush lands via setState, which a closure
	 * waiting through `await finish()` cannot observe in time. Kept
	 * current at every write site via applyText. */
	const textRef = useRef("");
	const applyText = useCallback((v: string) => {
		textRef.current = v;
		setText(v);
	}, []);
	// The BYOK setup flow (owner, 2026-09-22): the persistent CTA and the
	// refusal interception share one SetupDialog mount. `configured` is
	// seeded server-side (slotsConfigured on the record) and flips on Save.
	const [configured, setConfigured] = useState(initialConfigured);
	// The zero-keys truth (zero-keys wave): no provider key = the pill
	// takes precedence over the models CTA (keys come first in the chain).
	// Reads once on mount, re-reads on the "keys" signal.
	const zeroKeys = useZeroKeys();
	// Cross-surface freshness (fix wave): another surface's models write —
	// setup save, composer pick, a settings write — re-reads the record so
	// the setup CTA appears/disappears live (it used to lag until reload).
	useSettingsSaved((section) => {
		if (section !== "models") return;
		fetch("/api/settings")
			.then((r) => r.json() as Promise<{ settings?: { models?: ModelsSettings } | null } | null>)
			.then((body) => setConfigured(slotsConfigured(body?.settings?.models)))
			.catch(() => {});
	});
	const [setupOpen, setSetupOpen] = useState(false);
	/** The last explicitly-sent draft (composer send): the
	 *  refusal flow restores it into the composer, where it waits for the
	 *  learner to re-send (Save never auto-sends, owner 2026-10-09).
	 *  Auto-continuations (probe answers) never set it — their refusal
	 *  opens the dialog with no replay. */
	const draftRef = useRef<string | null>(null);

	// THE BYOK REFUSAL (owner, 2026-09-22): a send that lands the server's
	// 503 models_not_configured envelope renders as the SETUP FLOW, never
	// the error banner. The gate refuses BEFORE the write-ahead persist,
	// so the server record is the truth minus the refused send — the
	// optimistic message is an orphan that goes HOME: refetch the record,
	// drop the orphan, put the draft back in the composer, open the
	// dialog (the prefilled tiers carry their picks, the unpinned ones the
	// "needed" marks). The draft stays in the composer until the learner
	// re-sends it (owner ruling 2026-10-09).
	useEffect(() => {
		if (!error) return;
		const missing = parseModelsRefusal(error.message);
		// The key-refusal twin (zero-keys wave): a pinned model whose
		// provider key is gone gets the SAME treatment — revert-draft and
		// open setup (the dialog derives to its first-key stage on its own).
		const keyRefused = parseProviderKeyRefusal(error.message);
		if (!missing && !keyRefused) return; // a real error keeps the honest banner
		// ORDER MATTERS: clearError() flips this effect's own dep (`error`)
		// and would cancel the in-flight work below — so the banner dismiss,
		// the draft restore, and the dialog open all land TOGETHER after the
		// record refetch (the honest truth minus the refused send).
		let cancelled = false;
		void (async () => {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}`);
			if (!cancelled && res.ok) {
				const record = (await res.json().catch(() => null)) as { messages?: LhMessage[] } | null;
				if (Array.isArray(record?.messages)) setMessages(record.messages);
			}
			if (cancelled) return;
			if (draftRef.current !== null) {
				applyText(draftRef.current);
				draftRef.current = null;
			}
			clearError();
			setSetupOpen(true);
		})();
		return () => {
			cancelled = true;
		};
		// (setMessages/clearError are stable per useChat instance — the
		//  dep pair [error, chatId] is what the flow actually keys on.)
	}, [error, chatId]);
	// Voice dictation (STT wave, 2026-09-17): finals append at the end of
	// the current text (the page owns the separator, dictate-flush style);
	// interims ghost in the stats bar's middle slot next to the meter.
	// TAB CYCLES THE CHAT'S FIELDS (owner, keyboard round 2026-10-06):
	// reading-thinking → the active dock's field → the composer, in
	// visual order, forward-only with wrap; Tab from anywhere else
	// focuses the first live field (navigate IN). Gathered from live
	// DOM at event time — the docks mount and unmount, refs would go
	// stale. The quiz dock's rows↔thinking claim never reaches here.
	const cycleChatFields = useCallback((): readonly HTMLElement[] => {
		const pick = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
		return [
			...pick('[data-testid="reading-thinking-field"] textarea'),
			...pick('[data-testid="question-dock"] textarea'),
			...pick('[data-testid="practice-dock"] textarea'),
			...pick('[data-testid="composer"] textarea'),
		];
	}, []);
	useFieldCycle(cycleChatFields);
	const dictation = useDictation({
		// Ref-first (see textRef): the join is computed from the mirror so a
		// send resuming after `await finish()` reads the dictated tail.
		append: (t) => applyText(joinDictation(textRef.current, t)),
	});
	/* When a dictation run ends, the bare composer takes focus (owner
	 * 2026-10-01) — the hands are already on the keyboard from the stop.
	 * Falling edge of `active` only (idle→idle never focuses), and ONLY the
	 * composer: with a question pending the Composer is unmounted, the ref
	 * is null, and the thinking field is left alone by design. */
	const dictationWasActiveRef = useRef(false);
	const composerInputRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (dictation.active) {
			dictationWasActiveRef.current = true;
		} else if (dictationWasActiveRef.current) {
			dictationWasActiveRef.current = false;
			composerInputRef.current?.focus();
		}
	}, [dictation.active]);

	// Jobs never gate the composer (contracts.ts "THE ASYNC PROTOCOL" §4): job
	// tools resolve with an ack mid-turn, so the learner can interject while
	// sub-agents run — a feature, not a race: the wake pipeline queues steers
	// until the current turn ends. Only a QUESTION pending or a turn in
	// flight (client or server-side wake turn) gates sending.
	// A LIVE dictation also makes the composer sendable (owner 2026-10-01):
	// the spoken text is deferred in the run's buffer — Enter must be able
	// to trigger the finish-first send (see onSend), not be gated out by an
	// empty textarea. If nothing was said, the send is a harmless no-op.
	// Steering (2026-10-03): a turn in flight no longer gates the composer —
	// Enter while a turn runs STEERS it (the quiet queue above the composer);
	// a pending question still owns the interaction (the dock replaces the
	// composer, and there is no live turn to steer anyway — questions end
	// turns).
	// Compaction (owner round 14): the RUNNING state — compaction-changed
	// flips it; the send paths, canSend, and the docks gate on it (the
	// server's registry mutex is the structural gate; this is the
	// affordance).
	const [compacting, setCompacting] = useState(initiallyCompacting);
	const canSend =
		(text.trim().length > 0 || dictation.active) && !pending && !activeProblem && !compacting;

	/* THE PRACTICE PAUSE (owner round 16): between problems — practice
	 * kind, nothing active, nothing in flight, and at least one problem
	 * has ever been posed (the fresh session's opening turn is owed, not
	 * the move-on). Enter-on-empty and the Next chip both key on it. */
	const nextReady =
		kind === "practice" &&
		!pending &&
		!activeProblem &&
		!compacting &&
		!busy &&
		nativeMessages.some(
			(m) => (m as { role?: string }).role === "assistant" &&
				Array.isArray((m as { content?: unknown[] }).content) &&
				(m as { content: Array<{ type?: string; name?: string }> }).content.some(
					(b) => b.type === "toolCall" && b.name === "problem",
				),
		);
	const sendNext = useCallback(() => {
		if (!nextReady) return;
		void send({ type: "next" });
	}, [nextReady, send]);

	/* ENTER FROM ANYWHERE (owner round 16 refinement, 2026-10-06 —
	 * keyboard-first): the move-on must not require composer focus. The
	 * window-level Enter (typing surfaces and buttons excluded — a
	 * focused composer/button keeps its own lane, so no double fire)
	 * fires the signal from body focus, a scroll, anywhere. sendNext
	 * self-guards on nextReady, so the listener is inert outside the
	 * pause — the dock-mounted listeners are gone by then (docks unmount
	 * when nothing is active; the two never overlap). */
	useEnterSubmits(sendNext);

	const syncFromServer = useCallback(async () => {
		const res = await fetch(`/api/chats/${chatId}`);
		if (!res.ok) return;
		const record = (await res.json()) as { messages?: LhMessage[]; turns?: TurnUsage[]; pricing?: SessionPricing; turnError?: string };
		if (Array.isArray(record.turns)) setTurns(record.turns);
		setPricing(record.pricing);
		if (!Array.isArray(record.messages)) return;
		setMessages(record.messages, record.turnError);
		// The continuation seam (contracts.ts protocol §4): a job result
		// landing in the record leaves the agent owing a continuation — the
		// record ENDS on un-consumed results, the dock owns no question, and
		// nothing runs. The native fold (needsContinuation) is the old SDK
		// lastAssistantMessageIsCompleteWithToolCalls check.
		// Current model truth also guards retained/live failures: canonical
		// sync must never automatically replace a reply that failed to save.
		continueIfOwed(record.messages);
	}, [chatId, setMessages, continueIfOwed]);

	// The settled terminal's other half (stream-reattach wave): the
	// transport resolved turn-settled — no turn running, the record is
	// current. Drop the fallback busy state and adopt the record (its
	// continuation check fires the owed next turn, exactly as the poll's
	// settle branch always did).
	reattachSettledRef.current = () => {
		setTurnInFlight(false);
		void syncFromServer();
	};

	// ── Append-only record adoption (owner ground rules, 2026-09-15) ──
	// Content delivered into the record server-side — sub-agent
	// artifacts, abort notes — must become visible the
	// moment it persists, mid-turn included: it sits between messages, and
	// nothing about a running turn should hide it. The full snapshot sync
	// mid-stream is forbidden (it breaks the SDK's in-place continuation
	// merge — the stale-snapshot lesson), so adoption here is APPEND-ONLY
	// (the session hook's adoptRecord): insert the record's new ids in their canonical
	// order, never rewrite a local one, keep the in-flight tail last. The
	// full syncFromServer stays the net at idle (reorder, plan blocks, turns).
	const adoptAppendOnly = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}`);
			if (!res.ok) return;
			const record = (await res.json()) as { messages?: LhMessage[] };
			if (!Array.isArray(record.messages)) return;
			adoptRecord(record.messages);
		} catch {
			/* transient — the idle full sync is the net */
		}
	}, [chatId, adoptRecord]);

	// Turn-start window: the server inserts claimed steers right after our
	// outgoing message, BEFORE the stream produces anything — so a bounded,
	// self-terminating window of three record fetches (400ms/1s/2s) catches
	// the insert and shows the marker during the turn, then stops. No
	// standing poll — the window exists only for these seconds. (The dock
	// nudges that lived here died at S5: dispatch writes announce jobs-changed
	// from the store, extraction announces activity-changed at setPhase.)
	const turnStartStatusRef = useRef(status);
	// The window must survive the submitted→streaming flip (the stream starts
	// in well under 400ms), so the timers are guarded by this ref — dropped at
	// unmount, left alone otherwise: the window self-terminates after 2s.
	const adoptionWindowOpenRef = useRef(false);
	const turnStartTimerRefs = useRef<ReturnType<typeof setTimeout>[]>([]);
	useEffect(() => {
		const was = turnStartStatusRef.current;
		turnStartStatusRef.current = status;
		if (was === "submitted" || status !== "submitted") return;
		// A turn just started (status flipped ready → submitted): open the
		// bounded adoption window.
		adoptionWindowOpenRef.current = true;
		const timers = [400, 1000, 2000].map((ms) =>
			setTimeout(() => {
				if (adoptionWindowOpenRef.current) {
					void adoptAppendOnly();
				}
			}, ms),
		);
		// Deliberately no cleanup here: this effect re-runs on every status
		// flip, which would cancel the window at submitted→streaming.
		timers.forEach((t) => {
			turnStartTimerRefs.current.push(t);
		});
	}, [status, adoptAppendOnly]);
	useEffect(() => {
		const timers = turnStartTimerRefs;
		return () => {
			adoptionWindowOpenRef.current = false;
			timers.current.forEach(clearTimeout);
			timers.current = [];
		};
	}, []);

	// The live plan popup (wave 4): opened by any transcript plan block, the
	// top-bar plan chip, and the dock band's marginalia.
	const [planOpen, setPlanOpen] = useState(false);
	// Real plan presence — gates the marginalia's clickable flank. A JSX
	// element is always truthy; gating on the node alone mounted a phantom
	// (invisible, clickable) button in the bottom-right whenever a question
	// was pending with no plan yet (owner report, UI round 2026-10-01).
	const hasPlan = useMemo(() => planExists(messages), [messages]);
	// The coverage ring's refresh chain (extraction-UX redesign): bumped at
	// turn settle — the moment this session's uncovered mass changes.
	const [coverageTick, setCoverageTick] = useState(0);
	// The mermaid focus (chrome-melt wave, 2026-09-19): md-blocks' expand
	// button registers the chart source here; the overlay (and the plan
	// popup) mount INSIDE the session-area div — both are session-scoped, so
	// the drag bar stays sharp and draggable while a focus owns the area.
	const [mermaidFocus, setMermaidFocus] = useState<string | null>(null);
	// Figure focus (2026-10-07): the figure card's fullscreen button — same
	// overlay shell as mermaid, but carrying the raw svg + the card's invert
	// state so the fullscreen view stays faithful to the toggled card.
	const [figureFocus, setFigureFocus] = useState<{ svg: string; inverted: boolean } | null>(null);

	// Overlay mirrors for the layered-Esc gate (owner 2026-10-04): the
	// lh:kbd-abort-turn handler reads these at EVENT time — declared here
	// beside their states, consumed below wherever the states live.
	const mermaidFocusRef = useRef(mermaidFocus);
	mermaidFocusRef.current = mermaidFocus;
	// The figure focus rides the mermaid layer in the Esc gate — the same
	// overlay class (session-scoped diagram focus, Esc claimed at the
	// document level by the overlay itself); the window chain must stay out.
	const figureFocusRef = useRef(figureFocus);
	figureFocusRef.current = figureFocus;
	const planOpenRef = useRef(planOpen);
	planOpenRef.current = planOpen;
	const setupOpenRef = useRef(setupOpen);
	setupOpenRef.current = setupOpen;
	// The session's live plan (drives the top-bar chip; the marginalia
	// derives its own from the same transcript).
	const planTree = useMemo(() => latestTree(messages), [messages]);

	// ── Session usage (wave-4 stats bar) ──
	// The money channel: the record's turns log and read-time server Pi
	// pricing projection. Seeded once on mount (the page doesn't carry turns),
	// refreshed when the local stream settles (each turn appends to the log
	// server-side), and kept fresh by syncFromServer whenever it already
	// fetches the record. No turns yet → the bar renders "—" everywhere.
	const [turns, setTurns] = useState<TurnUsage[]>([]);
	const [pricing, setPricing] = useState<SessionPricing | undefined>();
	// The per-chat model control state (model-picker writes via PUT; the
	// record is the source of truth, lifted here so the stats bar re-renders).
	// The dock's reserved tail height (DockOverlay reports it; the spacer at
	// the end of the transcript renders it). Lives here because the spacer is
	// inside the scroller while the dock overlays OUTSIDE it — two parents.
	// 208 ≈ gradient(96) + composer block(~112): the SSR/pre-hydration
	// guess so the static paint has a sane tail. The first layout effect
	// replaces it with the measured truth before paint.
	const [dockReserve, setDockReserve] = useState(208);
	const syncTurns = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}`);
			if (!res.ok) return;
			const record = (await res.json()) as { turns?: TurnUsage[]; pricing?: SessionPricing };
			if (Array.isArray(record.turns)) setTurns(record.turns);
			setPricing(record.pricing);
		} catch {
			// transient blip: stats stay on the last known figures
		}
	}, [chatId]);
	useEffect(() => {
		void syncTurns();
	}, [syncTurns]);
	// After the learner's own turn ends the log has a fresh entry — and the
	// Post-turn settle (the SLIMMED watch — push-architecture S3,
	// 2026-10-02): our own stream just ended. Two instant LOCAL actions
	// only — the turns-only refetch lands the log entry while the server's
	// persist/endTurn lags by milliseconds, and the coverage ring re-reads
	// (this turn's messages just joined the uncovered mass). The ADOPTION
	// LOOP and the HANDOFF WATCH that lived here are RETIRED: a
	// server-initiated turn (the probe→teach handoff, a job wake, another
	// tab) is now ANNOUNCED on the events channel — the turn-started
	// subscription (below the jobs poll) attaches to it live. No polling
	// window can expire; the freeze class is gone.
	const prevStatusRef = useRef(status);
	useEffect(() => {
		const transitioned = prevStatusRef.current !== "ready" && status === "ready";
		// Every path (the old early-return skipped this on the transition
		// branch — the re-fire-on-dep-churn wart, fixed S3).
		prevStatusRef.current = status;
		if (!transitioned) return;
		// immediate: turns-only refetch — the stats bar updates even while
		// the server's persist/endTurn lags the client by milliseconds
		void syncTurns();
		// The coverage ring re-reads at turn settle too (extraction-UX
		// redesign, 2026-09-24); the ring's own running-poll handles runs.
		setCoverageTick((t) => t + 1);
		// CANONIZATION (fix B, the duplicate-previous-message bug, 2026-10-02):
		// turn-settled for OUR OWN turn arrives while the stream is still open
		// (endTurn emits from onFinish before the response terminates, so the
		// SSE frame reliably beats [DONE]) — the handler below cannot sync
		// there, it flags instead, and THIS flip consumes the flag: the record
		// reflects durable truth (a failed settlement retains its notice,
		// not its unsaved reply), so replacing the view absorbs the tail's
		// streamed c_-id copies into base under their server ids. Without
		// this the tail kept those copies forever and the next send's
		// steer-adoption window rendered them a second time. The wake handoff
		// cannot be missed by this sync: the wake fires only after the idle
		// gates + grace (≥750ms past this flip), so its turn-started event
		// lands at an idle, already-canonical view and attaches normally.
		if (settleAnnouncedRef.current) {
			settleAnnouncedRef.current = false;
			void syncFromServer();
		}
		// (The extraction-discovery nudges that lived here died at S5: the
		// pipeline announces every phase on the events channel.)
	}, [status, syncTurns, syncFromServer]);

	// A stream that died MID-FLIGHT (network): the runner decoupled the turn
	// from its view, so the server turn runs ON behind the error banner —
	// re-enter the in-flight watch (the 1500ms fallback poll adopts at
	// settle) instead of leaving the session blind until the next send's
	// 409 merge-retry heals it. One record check per error transition.
	const prevErrorStatusRef = useRef(status);
	useEffect(() => {
		const was = prevErrorStatusRef.current;
		prevErrorStatusRef.current = status;
		if (was === "error" || status !== "error") return;
		let cancelled = false;
		void (async () => {
			try {
				const res = await fetch(`/api/chats/${chatId}`);
				if (!res.ok || cancelled) return;
				const record = (await res.json()) as { turnInFlight?: boolean };
				if (cancelled) return;
				if (record.turnInFlight === true) setTurnInFlight(true);
				else void syncFromServer();
			} catch {
				/* transient — the banner stands; the next send's merge-retry heals */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [status, chatId, syncFromServer]);

	// ── Central job observability (contracts.ts "THE ASYNC PROTOCOL" §4) ──
	// ONE fetch of /api/jobs drives every job surface (transcript dispatch
	// cards, the sub-agents panel) and re-syncs the transcript exactly once
	// when a job settles. PUSH (architecture S4, 2026-10-02): the store
	// announces every job write on the events channel; the interval poll and
	// its pollMs/jobPartCount gating are RETIRED. The view fetches once on
	// mount, once per jobs-changed announcement (trailing-debounced — a
	// sub-agent run writes activity-line bursts; 250ms coalesces them at or
	// below the old 1s poll cadence), and once on channel resync.
	//
	// A settle no longer implies the record is complete: CONTINUATION
	// COALESCING flips the job done at claim time — while the learner's own
	// answer turn is still streaming (and a settle can race a second job's
	// wake turn). Syncing mid-turn would swap in a stale snapshot
	// mid-stream, which breaks the SDK's in-place continuation merge
	// (duplicate message ids). So: a settle during a busy turn defers the
	// sync; the next idle fetch adopts the finished record.
	const [jobs, setJobs] = useState<JobRecord[]>([]);
	const localStreamRef = useRef(false);
	localStreamRef.current = localStream;
	const jobStatusRef = useRef<Map<string, string>>(new Map());
	// A settle seen during a busy turn — the sync is owed, not dropped.
	const pendingSyncRef = useRef(false);
	// (The dispatch nudge effect that lived here — refreshActivity per new
	// dispatch tool part — died at S5: the store announces jobs-changed at
	// the dispatch write; the dock subscribes.)
	// First-fetch guard (the old first-tick guard): the initial read adopts
	// existing history (jobs recorded before mount) without nudging — a
	// nudge is only owed for a running job the feed hasn't seen THIS session.
	const firstFetchRef = useRef(true);
	// The trailing debounce for jobs-changed announcements (one timer), and
	// the ref the timer fires through (a stale closure must never fetch an
	// old chatId).
	const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const fetchJobsRef = useRef<() => void>(() => {});
	const fetchJobs = useCallback(async () => {
		try {
			const res = await fetch(`/api/jobs?chatId=${encodeURIComponent(chatId)}`);
			if (!res.ok) return;
			const data = (await res.json()) as { jobs?: JobRecord[]; turnInFlight?: boolean };
			const list = data.jobs ?? [];
			for (const j of list) {
				const prev = jobStatusRef.current.get(j.id);
				if (prev === "running" && j.status !== "running") {
					// A settle — the blob leaves the dock via the store's jobs-changed
					// announce at this very write (S5); this handler owns the RECORD.
					// The record is only guaranteed complete when no turn is in
					// flight — locally or server-side (a coalesced settle fires
					// mid-turn by design), so the FULL sync waits for idle.
					// Ground rule (2026-09-15): delivered content shows
					// immediately anyway — adopt append-only NOW; the idle
					// sync still settles the record properly.
					if (localStreamRef.current || data.turnInFlight === true) {
						pendingSyncRef.current = true;
						void adoptAppendOnly();
					} else {
						void syncFromServer();
					}
				}
				jobStatusRef.current.set(j.id, j.status);
			}
			firstFetchRef.current = false;
			if (
				pendingSyncRef.current &&
				!localStreamRef.current &&
				data.turnInFlight !== true
			) {
				pendingSyncRef.current = false;
				void syncFromServer();
			}
			setJobs(list);
			// (Wake-turn adoption that lived here — the turnInFlight attach
			// line — died at S3: turn-started on the events channel owns
			// discovery now. turnInFlight is STILL READ above: the settle
			// logic's idle check needs it.)
		} catch {
			/* transient fetch failure — the next jobs-changed announcement re-fetches */
		}
	}, [chatId, syncFromServer, adoptAppendOnly]);
	fetchJobsRef.current = () => void fetchJobs();
	// Mount + chat switch: the IMMEDIATE (non-debounced) initial read. The
	// firstFetch guard resets with the old rule — true only when this
	// session has never seen a job (a chat switch keeps the map: job ids
	// are unique per chat, and a newly-seen running job may still nudge).
	useEffect(() => {
		firstFetchRef.current = jobStatusRef.current.size === 0;
		void fetchJobs();
	}, [fetchJobs]); // identity changes exactly on chatId
	useServerEvent("jobs-changed", (p) => {
		if (p.chatId != null && p.chatId !== chatId) return; // ours or unattributed
		if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
		fetchDebounceRef.current = setTimeout(() => {
			fetchDebounceRef.current = undefined;
			fetchJobsRef.current();
		}, 250);
	});
	// Reconnect catch-up: events missed while the channel was down.
	useServerResync(() => fetchJobsRef.current());
	useEffect(
		() => () => {
			if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
		},
		[],
	);

	// ── Server-initiated turn discovery (push-architecture S3, 2026-10-02) ──
	// Every turn THIS chat runs is announced on the events channel — the
	// probe→teach handoff, a job wake, another tab's send, the
	// missed-on-mount case. This replaces the retired watch loop and the
	// 1500ms fallback record poll: discovery is no longer a polling window
	// that can expire. Handlers read REFS, not closure state — events fire
	// between renders, and a ref holds the live value at event time.
	const statusRef = useRef(status);
	statusRef.current = status;
	/** Fix B (2026-10-02): turn-settled arrived for OUR OWN turn — the
	 * record is durable (endTurn fires only after persistTurn); the ready
	 * flip consumes this flag to canonize the view onto the record. See the
	 * settle effect and the turn-settled handler below. */
	const settleAnnouncedRef = useRef(false);
	useServerEvent("turn-started", (p) => {
		// Known non-issue: beginTurn emits before registerTurn in the same
		// synchronous request flow; a GET /stream inside that sub-ms window
		// gets a settled response — unwinnable by a network round-trip,
		// self-healing via the eventual turn-settled. Do not engineer around.
		if (p.chatId !== chatId) return;
		if (localStreamRef.current) return; // our OWN turn — the 409-race guard
		if (turnInFlightRef.current) return; // already attached
		attachToRunningTurn();
	});
	useServerEvent("turn-settled", (p) => {
		if (p.chatId !== chatId) return;
		if (localStreamRef.current) {
			// Our own [DONE] path owns the BUSY settle — but not a no-op (fix B,
			// 2026-10-02): the event is the record-durable guarantee (endTurn
			// fires only after persistTurn), and it reliably beats [DONE] here
			// (endTurn emits from onFinish before the response terminates). Flag
			// it; the ready flip consumes the flag and canonizes the view onto
			// the record. (If [DONE] somehow won this race instead, this branch
			// didn't run and the fully-idle branch below already synced.)
			settleAnnouncedRef.current = true;
			return;
		}
		if (turnInFlightRef.current) {
			// The attached stream's terminal frame owns the normal settle —
			// syncing HERE would swap a stale snapshot mid-stream (the
			// continuation-coalescing law, see the jobs poll above). Only
			// the error case heals: the attached stream died, and the settle
			// says persistTurn has made the record durable truth.
			if (statusRef.current === "error") {
				setTurnInFlight(false);
				clearError();
				void syncFromServer();
			}
			return;
		}
		// Fully idle — a turn we never saw (every window missed): adopt now.
		void syncFromServer();
	});
	useServerEvent("compaction-changed", (p) => {
		// The settle-kick's background summary: while it runs, sends gate
		// (the next turn's server-side ensureCompacted awaits it anyway —
		// this only keeps the affordance honest). On finish, record-changed
		// (emitted by the compaction write itself) carries the marker in.
		if (p.chatId !== chatId) return;
		setCompacting(p.running);
	});
	useServerEvent("record-changed", (p) => {
		// The silent dismissal write (A2, 2026-10-03): no turn ever ran, so
		// only the record moved. Other tabs and post-error windows adopt;
		// our OWN dismissal already rendered its optimistic append — syncing
		// here too is harmless (the adoption law swaps local ids for the
		// server's). Busy states ignore it: a running turn owns the view,
		// and the write is 409-guarded against exactly that anyway.
		if (p.chatId !== chatId) return;
		if (localStreamRef.current || turnInFlightRef.current) return;
		void syncFromServer();
	});

	const onSend = () => {
		if (pending || compacting) return;
		/* FINISH DICTATION FIRST (owner, 2026-10-01): a learner who keeps
		 * talking right through Enter must not lose the tail — stop the run,
		 * let the last finals land in the composer, then send the REF value
		 * (the flush lands via setState, invisible to this closure). */
		if (!dictation.active) {
			doSteerOrSend();
			return;
		}
		void dictation.finish().then(doSteerOrSend);
	};
	const doSend = () => {
		if (busy || pending || compacting) return;
		const t = textRef.current.trim();
		if (!t) return;
		draftRef.current = t; // the refusal flow's preserve-and-replay seam
		applyText("");
		void send({ type: "text", text: t });
	};

	/* STEER VS SEND (owner arc 2026-10-03): a send while a turn runs steers
	 * it — the quiet queue + the live agent's steering rail; the turn's own
	 * stream lands the card when pi drains it. The branch is BUSY, not
	 * turnInFlight: the own-stream case CLEARS turnInFlight (the local
	 * dedup, chat.tsx ~370), so branching there swallowed Enter entirely
	 * during our own turn (owner live report, fixed same day). busy covers
	 * own stream AND foreign/wake turns — both have a live agent by the
	 * time the send's POST resolved, so the steer lands. Idle takes the
	 * plain send; a raced settle 409s and falls back to exactly that. */
	const doSteerOrSend = () => {
		if (pending || compacting) return;
		const t = textRef.current.trim();
		if (!t) return;
		if (busy) {
			applyText("");
			void steer(t);
			return;
		}
		doSend();
	};

	return (
		<ChatActionsContext.Provider
			value={{
				chatId,
				syncFromServer,
				sendText: (t: string) => {
					void send({ type: "text", text: t });
				},
				openSetup: () => setSetupOpen(true),
			}}
		>
		<SessionMermaidContext.Provider
			value={{
				openMermaid: setMermaidFocus,
				openFigure: (svg, inverted) => setFigureFocus({ svg, inverted }),
			}}
		>
		<JobsContext.Provider value={jobs}>
		{/* The session surface: the transcript column (header + scroller) and
		    the plan-tree panel as full-height SIBLINGS — the panel spans top to
		    bottom exactly like the left sidebar, and the header (name + phase
		    chip) spans from the left sidebar's edge to the panel's edge. The
		    dock overlays the column bottom (outside the scroller); a spacer in
		    the transcript reserves its height. */}
		<div className="flex h-dvh">
			<div className="flex min-w-0 flex-1 flex-col">
				{/* The top bar is its own block (owner, top-fade round 4): in flow
				    above the scroller on the plain page background — no gradient. Its
				    bottom outline (border-b border-border) matches the one that
				    separates the left sidebar — same width, same color (owner, r5).
				    h-15 (60px), not py-2: the toggle (a size-9 icon button) renders
				    only while the sidebar is CLOSED — an auto-height row would
				    collapse when it disappears and slide the title + chip up.
				    60px is an ALIGNMENT, not just a size: it equals the sidebar's
				    LH wordmark band, so the header's border-b continues that
				    band's bottom edge as one line across the app (owner, round 6). */}
				<TopBar
					// While renaming the bar is NOT a drag surface: app-region:drag
					// would eat the mousedown, so click-to-escape (below) could
					// never fire. Rename mode is interactive mode (owner ask) —
					// TopBar's one escape hatch.
					drag={!renaming}
					onMouseDown={(e) => {
						// Escape hitbox: any mousedown outside the input itself blurs
						// it, running the existing onBlur commit path. The input is
						// shrink-to-fit (field-sizing), so the rest of the bar is
						// this spacer + inert chips — all click-to-exit (owner ask).
						if (renaming && e.target !== titleInputRef.current) titleInputRef.current?.blur();
					}}
				>
					{renaming ? (
						<>
							<input
								ref={titleInputRef}
								value={titleDraft}
								onChange={(e) => setTitleDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") void commitRename(titleDraft);
									// stopPropagation claims the Esc (keyboard wave A):
									// closing rename must not also abort a turn.
									else if (e.key === "Escape") {
										e.stopPropagation();
										setRenaming(false);
									}
								}}
								onBlur={() => void commitRename(titleDraft)}
								spellCheck={false}
								aria-label="Session title"
								title="Rename this session"
								className="lh-no-drag min-w-[8ch] max-w-[70%] shrink-0 bg-transparent font-title text-3xl tracking-tight caret-current outline-none [field-sizing:content]"
							/>
							{/* flex-1 spacer during rename too, so the chips stay at
							    the right edge; clicks here commit via the header
							    mousedown handler. */}
							<div className="min-w-4 flex-1" aria-hidden="true" />
						</>
					) : (
					<>
						<Hint
							// F2 renames (registry) — surfaced on the hover.
							label="Rename session"
							action="rename-session"
							side="bottom"
						>
<button
							type="button"
														onClick={() => {
								setTitleDraft(titleText);
								setRenaming(true);
							}}
							className="lh-no-drag -mx-1.5 min-w-4 shrink cursor-text truncate rounded-md px-1.5 text-left font-title text-3xl tracking-tight transition-colors hover:bg-accent"
						>
							{titleText}
							</button>
						</Hint>
							{/* flex-1 spacer: keeps the chips at the right edge AND stays a
							    drag surface (no carve-out) — the freed bar is grippable. */}
							<div className="min-w-4 flex-1" aria-hidden="true" />
					</>
					)}
					{/* The plan chip (owner, plan-placement round): session-level
					    structure beside the phase chip — access to the full-DAG popup
					    at every width; the marginalia is the wide-screen glance view. */}
					{planTree && (
						<Hint label="Open the full plan" side="bottom">
<button
							type="button"
							data-testid="plan-chip"
							onClick={(e) => {
								blurAfterPointerClick(e);
								setPlanOpen(true);
							}}
							className="lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground"
						>
							<WaypointsIcon className="size-3.5 text-primary" aria-hidden />
							Plan
						</button>
</Hint>
					)}
					{/* The extraction ring (owner-locked redesign, 2026-09-24): fills
					    with uncovered vs the chunk threshold, pulses while a run is in
					    flight, vanishes when the graph is off. Click → the exact
					    numbers. Before the phase label — the chips cluster right. */}
					{/* Practice (owner, 2026-10-04): the coverage ring hides —
				    practice never extracts, so an ever-filling ring with no
				    run behind it would lie. */}
					{kind !== "practice" && <CoverageRing chatId={chatId} refreshKey={coverageTick} />}
					{/* Practice sessions: no phase arc — a quiet Practice tag
					    instead of the phase chip. */}
					{kind === "practice" ? (
						<span
							data-testid="phase-chip"
							data-phase="practice"
							aria-hidden="true"
							className="pointer-events-none flex shrink-0 select-none items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
						>
							<DumbbellIcon className="size-3" />
							Practice
						</span>
					) : (
						<PhaseChip phase={phases.at(-1) ?? "probe"} />
					)}
				</TopBar>

				<SessionFind scopeRef={sessionFindScopeRef} scrollContextRef={scrollContextRef} />
				<div ref={sessionFindScopeRef} className="relative flex min-h-0 flex-1">
				<Conversation className="h-full min-w-0 flex-1" initial="instant" contextRef={scrollContextRef}>
					<SessionMessageNavigation />
					<ConversationContent className="min-h-full gap-0 p-0">
						<div data-session-find-root="" className={`${COLUMN} flex flex-1 flex-col gap-4 pt-4`}>
							{messages.length === 0 && !busy && (
								<ConversationEmptyState
									title="New session"
									description="The teacher will open by probing what you already know."
								/>
							)}

							{messages.map((m, mi) =>
								m.role === "user" && isSubagentSteer(m) ? (
									// Sub-agent delivery (wake-pipeline steer): NO message bubble — the
									// artifact card sits in the transcript column directly, full width
									// and centered like the teacher's artifacts (contracts.ts "THE ASYNC
									// PROTOCOL" §4). Key fallback: legacy transcripts (pre id-hygiene)
									// can still hold empty ids — the index keeps keys unique for them.
									<SubagentSteerCard key={m.id || `m-${mi}`} message={m} />
								) : m.role === "user" && m.parts.some((p) => p.type === "data-probe-handoff") ? (
								// The probe→teach handoff wake (custom-message scheme): the
								// PLANNING DIVIDER IS the seam (owner ruling 2026-09-26 — it
								// replaced the "Preparing your plan…" system line; the marker
								// renders in the right spot by record construction, so the old
								// fold-based divider — which floated to the transcript top once
								// Wave D grouping merged the whole probe into one giant
								// assistant group — is gone). Never a user bubble: the wake is
								// scaffolding; the model-facing instruction lives in the adapter.
								<PhaseDivider key={m.id || `m-${mi}`} phase="plan" />
							) : m.role === "user" && m.parts.length > 0 && m.parts.every((p) => p.type.startsWith("data-")) ? (
								// Marker cards (custom messages, 2026-10-04): user-side
								// scaffolding — the graph-context pick, the practice
								// thinking trace — render as cards in the transcript
								// column directly, NO chat bubble (the subagent-steer
								// precedent). The user branch below renders text only;
								// without this hoist a data-only message read as an
								// EMPTY bubble (owner report, 2026-10-04).
								<Fragment key={m.id || `m-${mi}`}>
									{m.parts.map((part, pi) => {
										switch (part.type) {
											case "data-graph-context":
												return <GraphContextCard key={pi} data={part.data as GraphContextData} />;
											case "data-compaction":
												return <CompactionMomentDivider key={pi} data={part.data as CompactionDividerData} />;
											case "data-compaction-cut":
												return <CompactionCutDivider key={pi} data={part.data as CompactionDividerData} />;
											case "data-practice-thinking":
												return <ThinkingCard key={pi} data={part.data as PracticeThinkingData} />;
											case "data-practice-next":
												// The learner's move-on signal (owner round 16): a compact
												// centered mono-caps line — chrome, the dismissal register.
												return (
													<div
														key={pi}
														data-testid="practice-next-line"
														className="my-4 flex items-center justify-center gap-1.5 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground"
													>
														<ArrowRightIcon className="size-3" />
														Next problem
													</div>
												);
											default:
												return null;
										}
									})}
								</Fragment>
							) : (
									<Fragment key={m.id || `m-${mi}`}>
									{/* THE INFERRED TEACH SEAM (owner ruling 2026-09-26, the verdict
									death): teaching begins where the FIRST nodeId-tagged quiz is
									posed — the fold (phaseTimeline, the same derivation the phase chip
									reads) flips to teach exactly AT this assistant group. STEP-LEVEL
									since owner round 8 (2026-10-05 — the stacked-dividers bug): the
									plan presentation often lives in the SAME message, an earlier
									provider step than the quiz call, and the old message-level seam
									drew this divider before the plan too (Planning and Teaching
									stacked back-to-back, nothing between). teachStepIndex finds the
									step boundary governing the flip call: -1 = the message's first
									step → prepend before the whole block (this branch); a later
									index → the divider renders AT that part boundary in the loop
									below (replacing the plain step hairline — a labeled phase rule
									supersedes it). The boundary check (this index flips, the
									previous didn't) still guarantees exactly ONE divider per session.
									PREPENDED, never a replacement branch: the teach group is a real
									message with content — a replacement ternary swallowed the entire
									first lesson block (the Lacan session, 2026-09-27). */}
									{m.role === "assistant" &&
									mi > 0 &&
									phases[mi] === "teach" &&
									phases[mi - 1] !== "teach" &&
									teachStepIndex(m.parts) === -1 ? (
										<PhaseDivider key={`teach-${m.id || `m-${mi}`}`} phase="teach" />
									) : null}
									{m.role === "user" ? (
										/* THE DOCUMENT ROW (owner round, 2026-10-05): no right-aligned
										    bubble — the transcript reads as a document. User text is a
										    full-width quote block: muted "You" label, muted rail,
										    FULL-opacity text (learner words are content, not whisper).
										    Distinguished from user thinking at a glance: thinking is
										    collapsed + 50% italic; this is upright and present.
										    User text renders plain — the model's LaTeX pipeline is not
										    applied to learner-authored text ($ stays $, no surprises).
										    Rendered WITHOUT the Message wrapper — that is the bubble. */
											<div
										data-testid="user-message"
										/* THE DOCUMENT, ALL-IN (owner rounds two+three, 2026-10-07):
										    no chat side — the user message is a full-width card-color
										    BAND, the IDENTICAL geometry as the thinking rows: 5px band
										    padding, the left gap matches it, the rail fills the 3ch
										    inset (the band is the authorship mark against the agent's
										    transparent prose). The "You" label stays — one register
										    with the thinking labels. */
										className="my-2 w-full border-l-[calc(3ch-14px)] border-muted-foreground/30 bg-card py-1 pl-[14px] pr-4 font-ui text-xs"
									>
												{/* The rail GROUPS (owner round 4, 2026-10-05): the YOU heading
												    sits INSIDE the rail, same mono-xs register and same 1ch
												    rail as the thinking rows — one quote geometry. */}
												<div className="font-medium uppercase tracking-wide text-muted-foreground">You</div>
												<div className="lh-prose whitespace-pre-wrap text-foreground">
													{m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")}
												</div>
											</div>
									) : (
									<Message from="assistant" className="max-w-full">
									<MessageContent className="w-full">
											{m.parts.map((part, pi) => {
												const isLastPart = mi === messages.length - 1 && pi === m.parts.length - 1;
												// The step boundary where teaching begins (round 8): when
												// the teach flip happens in a LATER step, its PhaseDivider
												// replaces this boundary's plain hairline.
												const teachBoundary =
													m.role === "assistant" &&
													mi > 0 &&
													phases[mi] === "teach" &&
													phases[mi - 1] !== "teach" &&
													teachStepIndex(m.parts) === pi;
												// A tool call that errored BACK TO THE AGENT (validation
												// failure, malformed args) is invisible work — the agent
												// reads the error and retries. Owner ruling 2026-09-26:
												// surface the retry loop as one quiet line, any tool,
												// instead of silence (question tools used to render null,
												// so a flailing quiz loop read as a stall). Aborts are
												// terminal — nothing retries — so they stay silent.
												if (
													part.state === "output-error" &&
													part.type.startsWith("tool-") &&
													part.errorText !== "Operation aborted"
												) {
													return (
														<SystemLine key={`retry-${pi}`} testId="tool-retry">
															Retrying…
														</SystemLine>
													);
												}
												switch (part.type) {
													case "text": {
														const sourceId = textPartMessageId(part.id);
														const anchor = sourceId && sourceTextParts.get(sourceId) === part.id ? messageAnchorId(sourceId) : undefined;
														return (
															<div key={part.id || pi} id={anchor} data-source-message-id={sourceId ?? undefined} className="lh-source-passage">
																<MessageResponse>{part.text}</MessageResponse>
															</div>
														);
													}
													case "reasoning":
														return (
															<Reasoning key={pi} isStreaming={status === "streaming" && isLastPart} className="mb-2">
																<ReasoningTrigger />
																<ReasoningContent>{part.text ?? ""}</ReasoningContent>
															</Reasoning>
														);
													case "step-start":
														if (teachBoundary)
															return <PhaseDivider key={`teach-step-${pi}`} phase="teach" />;
														return pi > 0 ? <Separator key={pi} className="my-3" /> : null;
													case "data-plan-block":
														// The plan in the chat (wave 4): a frozen snapshot
														// block — rendered as carried, never re-derived.
														return (
															<PlanBlock
																key={pi}
																data={part.data as PlanBlockData}
																onOpen={() => setPlanOpen(true)}
															/>
														);
													case "tool-quiz":
													case "tool-probe":
													case "tool-ask_user_question":
													case "tool-explain":
													case "tool-recall": {
														// Pending/streaming questions live in the dock, not the
														// transcript; answered ones render as graded records.
														if (part.state === "output-available") {
															return (
																<AnsweredCard key={pi} answer={part.output as QuestionAnswerData} input={part.input} />
															);
														}
														return null;
													}
													default: {
														// A tool call being WRITTEN (owner, streaming round 2026-10-01):
														// input-streaming spans the whole execution, and the live card —
														// spinner + shimmered activity label, the input watchable on expand
														// — replaces the retired transcript bottom line. On settling, the
														// registry's card takes over below.
														if (part.type.startsWith("tool-") && part.state === "input-streaming") {
															return <LiveToolCard key={pi} part={part as ArtifactPartProps["part"]} />;
														}
														// Artifact extension point (contracts.ts): job
														// parts and future artifacts render via the
														// registry — add renderers there, not here.
														if (part.type.startsWith("tool-")) {
															const Renderer = artifactRenderers[part.type.slice("tool-".length)];
															if (Renderer) return <Renderer key={pi} part={part as ArtifactPartProps["part"]} />;
														}
														return null;
													}
												}
											})}
										</MessageContent>
									</Message>
									)}
								</Fragment>
							))}

							{/* THE placeholder, ACTION-gated (owner, optimistic round
							    3, 2026-10-02): spinner + shimmered Thinking… from the
							    instant of any action that produces tokens — send,
							    answer, session start, reattach (status flips to
							    submitted SYNCHRONOUSLY with the action) — until the
							    turn's first APPLIED event, where the stream takes over
							    with the same look: an arrived-but-empty message renders
							    the thinking ROW (view.ts projects one empty reasoning
							    part), so submitted ⟺ placeholder and streaming ⟺ a
							    rendered row, mutually exclusive by construction.
							    Protocol events (agent_start) apply nothing and release
							    nothing — the placeholder covers the whole
							    provider-connect gap. turnInFlight: the same state
							    entered by external discovery (wake) / the poll
							    fallback. Never collapsible itself. */}
							{/* Compaction (owner round 15): the same register as the
						    thinking placeholder — a visible session-wide state while
						    the summarizer holds the model gate. Mutually exclusive with
						    the THINKING placeholder by construction (the gate sits
						    BEFORE beginTurn; the settle kick runs after endTurn). */}
							{compacting && (
								<span className="flex items-center gap-2 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
									<BrailleSpinner label="Compacting context" />
									<Shimmer duration={1}>COMPACTING CONTEXT…</Shimmer>
								</span>
							)}
							{(status === "submitted" || turnInFlight) && (
								<span className="flex items-center gap-2 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
									<BrailleSpinner label="Thinking" />
									<Shimmer duration={1}>
										THINKING…
									</Shimmer>
								</span>
							)}
							{error && (
								<div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">
									Something went wrong: {error.message}
								</div>
							)}
						</div>

						{/* The dock's reserved tail (DockOverlay reports its height):
						    keeps at-rest transcript content scrolling fully clear of
						    the overlay — the flow-space replacement for the old
						    sticky dock. Zero only pre-measurement (the first layout
						    effect reports before paint). */}
						<div aria-hidden data-testid="dock-spacer" style={{ height: dockReserve }} />
				</ConversationContent>
				{/* The dock: an overlay sibling of the scroller (the
				    use-stick-to-bottom pattern). The scroll-down button lives
				    INSIDE the overlay now (owner refinement round, 2026-09-24):
				    anchored to the dock block's top edge, so it rides every
				    height morph (typing, a question growing the band, the
				    fold) and NEVER overlaps the composer. */}
				<DockOverlay
					pending={pending}
					initialQuestionDraft={pending ? questionDraft(pending.toolCallId)?.form : undefined}
					onSaveQuestionDraft={(form) => { if (pending) saveQuestionDraft(pending.toolCallId, { form }); }}
					practice={activeProblem}
					compactionRunning={compacting}
					onSubmitThinking={submitThinking}
					chatId={chatId}
					plan={hasPlan ? <PlanMarginalia messages={messages} /> : undefined}
					onOpenPlan={() => setPlanOpen(true)}
					requiresReveal={requiresReveal}
					readingThinking={readingThinking}
					onReadingThinking={applyReadingThinking}
					phase={phases.at(-1) ?? "probe"}
					turns={turns}
					contextTokens={contextTokens}
					pricing={pricing}
					onReserve={setDockReserve}
					dictationSlot={<DictationBar dictation={dictation} />}
					dictationCancel={dictation.cancel}
					queuedSteers={visibleQueuedSteers(steerQueue, nativeMessages)}
					setupCta={
						zeroKeys ? (
							<ZeroKeysPill onOpen={() => setSetupOpen(true)} />
						) : (
							!configured && (
								<div className="pointer-events-auto mb-2 flex justify-center">
									<button
										type="button"
										data-testid="setup-cta"
										onClick={() => setSetupOpen(true)}
										className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent cursor-pointer"
									>
										Set up your models
									</button>
								</div>
							)
						)
					}
					composer={
						<Composer
							// Stop aborts ANY in-flight turn (stream-reattach wave): the
							// square renders while a reattached/wake turn runs too — the
							// abort channel kills it server-side; stop() alone would
							// only detach our view.
							busy={busy}
							value={text}
							onChange={applyText}
							inputRef={composerInputRef}
							onSend={onSend}
							onStop={abortInFlightTurn}
							canSend={canSend}
							onEscape={dictation.active ? dictation.cancel : undefined}
							// The pause affordance (owner round 16): the placeholder
							// IS the hint — empty state, exactly where Enter-on-empty
							// applies.
							nextProblem={nextReady}
							onNext={sendNext}
							placeholder={nextReady ? "Ask anything, or press Enter for the next one." : undefined}
						/>
					}
					onSubmitAnswer={(output) => {
						if (!pending) return;
						// THE ANSWER IS THE QUESTION CALL'S TOOL RESULT (fork 1, owner
						// 2026-09-26): one input event, one turn — the hook appends
						// the optimistic graded result (the AnsweredCard shows at
						// once) and the server's write-ahead persists it before the
						// turn; the teacher's reaction streams below it. Dismissals
						// ride the same callback (QuestionAnswerData.dismissed). The
						// reading-thinking draft rides along (owner 2026-10-03) — the
						// check answer is its only carrier.
						saveQuestionDraft(pending.toolCallId, { readingThinking: readingThinkingRef.current });
						const reading = readingThinkingRef.current.trim() || undefined;
						// The pending-id effect clears this only when the question
						// actually leaves. An offline preflight keeps the draft visible.
						submitAnswer(pending.tool, pending.toolCallId, reading ? { ...output, readingThinking: reading } : output);
					}}
				/>
				</Conversation>

				{/* The session-scoped focuses (chrome-melt wave, 2026-09-19): mounted
				    INSIDE the session area — absolute inset-0 siblings of the scroller,
				    so they own the area below the drag bar, right of the sidebar, and
				    the top bar stays sharp + draggable while a focus is open. */}
				{mermaidFocus !== null && (
					<MermaidOverlay chart={mermaidFocus} onClose={() => setMermaidFocus(null)} />
				)}
				{figureFocus !== null && (
					<MermaidOverlay
						svg={figureFocus.svg}
						inverted={figureFocus.inverted}
						onClose={() => setFigureFocus(null)}
					/>
				)}
				{planOpen && <PlanPopup messages={messages} onClose={() => setPlanOpen(false)} />}
				<AbortTurnDialog mode={abortAsk} onClose={() => setAbortAsk(null)} onConfirm={confirmAbort} busy={busy} />
				</div>
			</div>
		</div>
		</JobsContext.Provider>
		</SessionMermaidContext.Provider>
		{/* The BYOK setup flow (owner, 2026-09-22): one mount serves the
		    persistent CTA, the refused-send interception, and the job cards'
		    deep-link. Save keeps the draft in the composer — it never sends
		    (owner ruling 2026-10-09); Esc also keeps it (the dialog is
		    closable by design — the gate is the server, not this modal). */}
		<SetupDialog
			open={setupOpen}
			onClose={() => setSetupOpen(false)}
			onDone={() => {
				setSetupOpen(false);
				setConfigured(true);
				// Save only saves (owner ruling 2026-10-09): the draft went
				// home into the composer at refusal time and STAYS there —
				// the learner sends it themselves.
			}}
		/>
		</ChatActionsContext.Provider>
	);
}

/**
 * The floating blob: ONE persistent shell, OVERLAID at the bottom of the
 * column (absolute — a sibling of the scroller, the use-stick-to-bottom
 * pattern; it replaced the old in-flow sticky dock, which died of the
 * fold-latency problem below). Contents swap between the chat composer and
 * the question dock; shell height morphs between variants (WAAPI, quick). A
 * spacer at the end of the transcript (rendered by ChatView from onReserve
 * reports) holds the dock's flow-space, so at-rest content scrolls fully
 * clear of the overlay.
 *
 * Why an overlay (owner, scroll round 1): an in-flow dock IS scroll geometry
 * — folding it shrinks the scroll content, so the fold had to wait until the
 * learner was a full dock-height past the bottom (any closer and the browser
 * clamp pinned them back, re-expanding the box: the oscillation). Decoupled
 * from the flow, the fold is VISUAL ONLY: it fires as soon as the learner
 * leaves the bottom, and the reserved tail only ever GROWS while a question
 * is open (a shrinking tail would reintroduce the clamp).
 *
 * Collapse: scroll up past COLLAPSE_DIST and the dock folds into a slim bar;
 * click it (or scroll back to the bottom) to re-expand. The question form
 * stays MOUNTED while collapsed (hidden, not unmounted) so a half-made
 * selection survives.
 */
/**
 * How a teach-phase question arrives (owner ruling, 2026-09-25): collapsed
 * behind the reveal button when it follows the composer — the learner
 * reads the teaching first — but OPEN when it follows another question
 * (a queued parallel check): the reading already happened, so there is
 * nothing left to wait for and the scroll height it already had is the
 * honest height.
 */
/** The layered-Esc ruling (owner, 2026-10-04): an open overlay claims Esc —
 *  closing itself — before the abort chain may open its confirm. A mermaid
 *  focus, the plan popup, or the setup dialog over a pending question must
 *  close the OVERLAY, never dismiss the question underneath. Priority is
 *  stacking order: the abort confirm (topmost, claims via its own dialog),
 *  then the session overlays (mermaid paints above plan — later in DOM),
 *  then setup (self-closing — the gate only must not fire), then the
 *  2026-10-02 abort chain proper (question before turn). */
export type EscAbortTarget = "mermaid" | "plan" | "setup" | "question" | "problem" | "turn" | null;
	/**
 * Does the ?prompt topic still owe its first send? The gate is "no real
 * conversation yet" (no user/assistant message) — NOT emptiness: a
 * session started with map picks carries a graph-context MARKER as
 * message[0], and that scaffolding must never swallow the first send
 * (owner report, 2026-10-04: the turn went dead behind it — the old
 * `length === 0` check saw the marker and refused to fire).
 */
export function initialPromptOwed(messages: readonly { role: string }[], prompt: string | undefined): boolean {
	if (!prompt) return false;
	return !messages.some((m) => m.role === "user" || m.role === "assistant");
}

export function escAbortTarget(s: {
	abortAsk: boolean;
	mermaidFocus: boolean;
	planOpen: boolean;
	setupOpen: boolean;
	pending: boolean;
	/** An active practice problem (practice sessions, 2026-10-04): Esc
	 *  opens the discard confirm — below a pending question (the two
	 *  never coexist, but the layering stays strict), above the turn
	 *  abort (a live turn can be running BEHIND an idle problem only in
	 *  teaching sessions — practice problems end their pose turns). */
	problem: boolean;
	busy: boolean;
}): EscAbortTarget {
	if (s.abortAsk) return null; // the popup's own Esc — claimed by the dialog
	if (s.mermaidFocus) return "mermaid";
	if (s.planOpen) return "plan";
	if (s.setupOpen) return "setup";
	if (s.pending) return "question";
	if (s.problem) return "problem";
	if (s.busy) return "turn";
	return null;
}

export function revealArrival(wasQuestion: boolean): { expanded: boolean; revealed: boolean } {
	return wasQuestion ? { expanded: true, revealed: true } : { expanded: false, revealed: false };
}

/**
 * A PROBE question's arrival state (flicker round, 2026-09-26): open iff
 * the learner is at the bottom following along; scrolled up in history →
 * arrive as the collapsed bar (owner ruling: "it should just remain
 * closed"). Decided DURING RENDER like the teach seam above — the old
 * after-paint effect painted one stale-open frame first (the box "opened
 * and immediately closed" when scrolled up). Pure for tests.
 */
export function probeArrivalExpanded(isAtBottom: boolean): boolean {
	return isAtBottom;
}

/**
 * The geometry-mute's growth rule (flicker round, 2026-09-26): a reserve
 * GROWTH while a question is pending is the dock stretching (the dictation
 * flush landing many lines at once) — the spacer lands in that commit, the
 * smooth catch-up lags by exactly the growth, and that lag is our own
 * motion, not the learner leaving, so the fold machine ignores scroll
 * events for the mute window after (reproduced d≈152 > COLLAPSE_DIST).
 * Shrinks never stamp — that path self-muted the at-bottom re-expand and
 * left the box stuck collapsed (resize round, verified live). Pure for
 * tests.
 */
export function shouldStampGeometryMute(nextH: number, prevH: number, pending: boolean): boolean {
	return pending && nextH > prevH + 1;
}

function DockOverlay({
	pending,
	initialQuestionDraft,
	onSaveQuestionDraft,
	practice,
	compactionRunning,
	onSubmitThinking,
	requiresReveal,
	readingThinking,
	onReadingThinking,
	phase,
	turns,
	contextTokens,
	pricing,
	composer,
	onSubmitAnswer,
	chatId,
	onReserve,
	plan,
	onOpenPlan,
	dictationSlot,
	dictationCancel,
	setupCta,
	queuedSteers,
}: {
	pending: ReturnType<typeof findPendingToolCall>;
	initialQuestionDraft?: QuestionFormDraft;
	onSaveQuestionDraft: (draft: QuestionFormDraft) => void;
	/** Compaction running for this chat (round 14) — the docks' submit
	 *  affordance gate (the server's registry is the real one). */
	compactionRunning: boolean;
	/** The ACTIVE practice problem (practice sessions, 2026-10-04):
	 *  {toolCallId, input} — dock ownership exactly like a pending
	 *  question (the composer is replaced); null in teaching sessions. */
	practice: { toolCallId: string; input: unknown } | null;
	/** (commit, text) — the practice dock's two submit lanes. */
	onSubmitThinking: (text: string) => void;
	/** Teach-phase pending question: arrives collapsed behind the reveal button (W5). */
	requiresReveal: boolean;
	/** The reading-thinking draft (owner 2026-10-03) — owned by ChatView so
	 *  the submit + dismissal seams (outside this overlay) can merge it. */
	readingThinking: string;
	onReadingThinking: (v: string) => void;
	/** Session phase at the pending question — scales the thinking field. */
	phase: Phase3;
	/** The session's usage log — the stats bar beneath the composer folds it. */
	turns: TurnUsage[];
	contextTokens: number | null;
	pricing?: SessionPricing;
	composer: React.ReactNode;
	onSubmitAnswer: (output: QuestionAnswerData) => void;
	/** The model control's pass-through (the stats bar hosts it). */
	chatId: string;
	/** Reports the dock's settled height (block + gradient) — ChatView's
	 *  dockReserve state feeds the transcript's spacer from it. */
	onReserve: (h: number) => void;
	/** The plan marginalia's content (the bare diagram) — rendered only
	 *  while a question owns the band. Null until a plan exists. */
	plan?: React.ReactNode;
	/** Opens the full-DAG popup (the marginalia + chip share it). */
	onOpenPlan: () => void;
	/** The dictation strip (STT wave): rendered in the stats bar's middle
	 *  slot — the mic button + live meter (components/dictation.tsx). */
	dictationSlot?: React.ReactNode;
	/** Esc in a pending question's field stops dictation (the strip is the
	 *  stats bar's; the stop belongs to the page-owned hook, threaded down). */
	dictationCancel?: () => void;
	/** The queued-steer indicator's lines (composer steering, 2026-10-03):
	 *  already filtered by visibleQueuedSteers — only undrained steers. */
	queuedSteers: QueuedSteerLine[];
	/** The persistent setup CTA (BYOK, owner 2026-09-22): the same pill
	 *  home and /chat/new carry, above the composer while slots are unset. */
	setupCta?: React.ReactNode;
}) {
	const { isAtBottom, scrollToBottom, scrollRef } = useStickToBottomContext();
	// Render-fresh bottom state (flicker round): the arrival block below reads
	// it DURING RENDER — the same value the after-paint effect used to read a
	// frame too late. Assigned per render like the other refs below.
	const atBottomRef = useRef(isAtBottom);
	atBottomRef.current = isAtBottom;
	// Teach-phase mount (session reload with a pending check): the dock starts
	// as the collapsed invitation too — the check must not pop open on reload.
	const [expanded, setExpanded] = useState(!requiresReveal);
	// Reveal state (W5): false until the learner clicks the invitation. While
	// false, the scroll machine must NOT auto-expand at the bottom — the
	// learner reads the teaching first and opens the check when ready. Once
	// revealed, the normal collapse machine rules apply untouched.
	const [revealed, setRevealed] = useState(false);
	const revealPending = requiresReveal && !revealed;

	const pendingId = pending?.toolCallId ?? null;
	const initialPendingRef = useRef(pendingId);

	// Teach-question ARRIVAL state, applied during render — BEFORE the
	// first paint (owner, scroll-honesty round 2026-09-25). Until now the
	// stale expanded=true left by the previous question painted one frame
	// of the OPEN question: the dock measured itself tall, permanently
	// reserved that height, and the collapse after the paint could never
	// give it back (fold immunity) — so a collapsed teach question scrolled
	// the transcript as if it had opened. Resetting here means the paint
	// measures the bar, the reserve keeps the composer's height, and the
	// only motion is the teaching text itself.
	const prevPendingIdRef = useRef(pendingId);
	if (pendingId !== prevPendingIdRef.current) {
		const wasQuestion = prevPendingIdRef.current !== null;
		prevPendingIdRef.current = pendingId;
		if (pendingId && requiresReveal) {
			const arrival = revealArrival(wasQuestion);
			setExpanded(arrival.expanded);
			setRevealed(arrival.revealed);
		} else if (pendingId) {
			// Probe arrival (flicker round): open iff following at the bottom.
			// Painted in THIS render — no stale-open frame, no after-paint flip.
			setExpanded(probeArrivalExpanded(atBottomRef.current));
		}
	}

	// New question MID-SESSION (flicker round): the open/closed state itself
	// is decided DURING RENDER above; this effect only owns the reveal
	// scroll for the at-bottom arrival — and now under the SAME fold
	// suppression the teach reveal uses (the arrival's growth used to
	// out-run the scroll catch-up, the position machine read the lag as the
	// learner leaving, and the dock flashed open → bar → open; reproduced
	// frame-by-frame 2026-09-26, d peaked ~405px). On session mount the dock
	// starts in its initial state — no scroll, no morph.
	useEffect(() => {
		if (!pendingId || pendingId === initialPendingRef.current) return;
		if (!requiresReveal && atBottomRef.current) void suppressFoldDuringReveal();
		// fire only when a NEW question lands
	}, [pendingId]);

	// ── Fold machine (position, not velocity — owner, scroll round 1) ──
	// The dock is an overlay: folding is visual-only and scroll geometry never
	// moves, so the thresholds can hug the bottom. Leave it → fold; reach it
	// again → re-open. The dead band keeps trackpad drift from chattering.
	const expandedRef = useRef(expanded);
	expandedRef.current = expanded;
	// Dock ownership (the fold machine, the reserve immunity, the arrival
	// states): a pending question OR an active practice problem — either
	// replaces the composer and owns the band.
	const pendingRef = useRef(!!pending || !!practice);
	pendingRef.current = !!pending || !!practice;
	const requiresRevealRef = useRef(requiresReveal);
	requiresRevealRef.current = requiresReveal;
	const revealedRef = useRef(revealed);
	revealedRef.current = revealed;

	// The plan marginalia's flank width (owner, plan-placement round): from
	// the DOCK container's right edge to the block's right edge — the bare
	// diagram's canvas. Tracked LIVE by a ResizeObserver on the block
	// (owner, resize round): every geometry change — window resize, sidebar
	// toggle, scrollbar appearance, the box's own rewrap — reports the real
	// width instantly, so the fade floor never lags behind reality (the old
	// render-time measurement went stale during drag-resizes and the mount
	// decision popped late).
	const [flankW, setFlankW] = useState(0);
	const flankWRef = useRef(0);
	// Part A of the same round (the resize mute): any block size change
	// stamps this — the fold machine ignores scroll events for a beat after,
	// because a resize/rewrap re-clamps scrollTop and emits PHANTOM scroll
	// events mid-transient (the box flickered to the bar and back).
	// Width changes stamp HERE (column resizes); height growth stamps at
	// the OFFER (see offer below) — the spacer growing is the phantom-scroll
	// source, not the field stretching. SHRINKS never stamp anywhere: the
	// fold's own morph shrinks the block and gives back the reserve, and
	// stamping that self-mutes the at-bottom re-expand — the box got stuck
	// collapsed (resize round).
	const geometryAtRef = useRef(0);
	useIsoLayoutEffect(() => {
		const block = blockRef.current;
		if (!block) return;
		const measure = () => {
			const next = Math.round(block.offsetWidth / 2 - DOCK_W / 2 - 2 * MARGIN_GAP);
			if (Math.abs(next - flankWRef.current) > 1) {
				flankWRef.current = next;
				setFlankW(next);
				geometryAtRef.current = Date.now();
			}
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(block);
		return () => ro.disconnect();
	}, []);

	// The overlay must not paint over the scroller's scrollbar (owner, scroll
	// round 2): the scroller reserves symmetric gutters (scrollbar-gutter:
	// stable both-edges), so inset the overlay's right edge by the gutter —
	// zero on macOS overlay scrollbars, the real width on classic platforms.
	// The same measure owns the QUESTION/PROBLEM HEIGHT CAP (owner round,
	// 2026-10-05): the old fixed fractions (55dvh / 40vh) cut long problems
	// off absurdly short — the cap is now the AVAILABLE COLUMN (the
	// scroller already starts below the top bar) minus a 2rem breathing
	// gap, carried as --dock-max-h for the docks' scroll areas.
	const [sbInset, setSbInset] = useState(0);
	const [dockMaxH, setDockMaxH] = useState<number | null>(null);
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const measure = () => {
			setSbInset(Math.round((el.offsetWidth - el.clientWidth) / 2));
			setDockMaxH(Math.max(el.clientHeight - 32, 160));
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [scrollRef]);

	// GROWTH MUTE (owner round, 2026-10-05 — the generation churn): during a
	// live turn the transcript content grows and stick-to-bottom chases it;
	// the transient distance-from-bottom used to read as the learner
	// leaving, folding the dock open↔bar ("disappear and appear again").
	// A ResizeObserver on the scroller's content stamps the SAME mute the
	// dock's own resizes use — growth frames can never fold. Shrinks stamp
	// nothing (the fold's own morph shrinks the reserve; muting that would
	// self-mute the at-bottom re-expand).
	const growthAtRef = useRef(0);
	useEffect(() => {
		const el = scrollRef.current;
		const content = el?.firstElementChild as HTMLElement | null | undefined;
		if (!el || !content) return;
		let prevH = content.getBoundingClientRect().height;
		const ro = new ResizeObserver(() => {
			const h = content.getBoundingClientRect().height;
			if (h > prevH + 0.5) growthAtRef.current = Date.now();
			prevH = Math.max(prevH, h);
		});
		ro.observe(content);
		return () => ro.disconnect();
	}, [scrollRef]);

	// Wheel over the dock must still scroll the transcript (owner, scroll
	// round 2): the overlay is a SIBLING of the scroller, so the browser's
	// native scroll chaining stops at the overlay (the old in-flow dock
	// chained for free). Internal scrollers — the question area, textarea
	// overflow, the model menus — keep native scrolling, including their
	// own edge chaining; only when nothing under the cursor can take the
	// delta do we forward it to the transcript.
	useEffect(() => {
		const root = blockRef.current;
		const el = scrollRef.current;
		if (!root || !el) return;
		const canScroll = (n: HTMLElement, dir: number) => {
			if (n.scrollHeight - n.clientHeight < 2) return false; // not scrollable
			return dir < 0 ? n.scrollTop > 0 : n.scrollTop < n.scrollHeight - n.clientHeight - 0.5;
		};
		const onWheel = (e: WheelEvent) => {
			if (e.deltaY === 0) return;
			for (let n = e.target as HTMLElement | null; n && n !== root; n = n.parentElement) {
				if (n instanceof HTMLElement && canScroll(n, e.deltaY)) return; // native
			}
			e.preventDefault();
			el.scrollTop += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1);
		};
		root.addEventListener("wheel", onWheel, { passive: false });
		return () => root.removeEventListener("wheel", onWheel);
	}, [scrollRef]);

	// ── The reserve: the spacer's height, reported upward ──
	// Grows immediately (typing, new variants). NEVER drops while a question
	// is open — a shrinking reserved tail is scroll geometry and the browser
	// clamp would pin a nearby learner to the bottom (the old oscillation).
	// In chat mode drops apply (the composer's typing shrink is today's
	// harmless in-flow behavior; nothing auto-expands there).
	const reserveRef = useRef(0);
	const blockRef = useRef<HTMLDivElement>(null);
	const offer = (blockH: number) => {
		const next = blockH + GRADIENT_H;
		if (next <= reserveRef.current + 0.5 && pendingRef.current) return; // fold immunity
		// Reserve GROWTH is the phantom-scroll SOURCE (flicker round,
		// 2026-09-26): the spacer's height lands in this commit, the smooth
		// catch-up lags it by the growth amount, and the position machine
		// used to read that lag as the learner leaving — form → bar → form
		// (the dictation flush, reproduced d≈152 > COLLAPSE_DIST). Stamp the
		// mute right where the spacer grows: it covers the scroll events of
		// THIS growth no matter how long after the field stretched (the
		// field grows on its own render; the offer lands on the NEXT
		// DockOverlay render — ~1s apart live). Shrinks never stamp (the
		// fold's own give-back must not self-mute the re-expand).
		if (shouldStampGeometryMute(next, reserveRef.current, pendingRef.current)) geometryAtRef.current = Date.now();
		reserveRef.current = next;
		onReserve(next);
	};

	// Explicit expand (bar click): the smooth scroll to the bottom takes
	// hundreds of ms, during which the position is still legitimately inside
	// the collapse zone — the machine would instantly re-collapse the dock
	// (open → snap shut → reopen at the bottom, the flicker). Suppress the
	// collapse branch until the reveal scroll settles or is interrupted.
	// (Flicker round, 2026-09-26: extracted — the probe arrival at the
	// bottom is the SAME motion class and needs the same cover; the owner's
	// phrasing: the arrival's open and its scroll-to-bottom "should be the
	// same kind of motion".)
	const expandIntentRef = useRef(false);
	const intentTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const suppressFoldDuringReveal = () => {
		expandIntentRef.current = true;
		clearTimeout(intentTimerRef.current);
		intentTimerRef.current = setTimeout(() => {
			expandIntentRef.current = false;
		}, 2000);
		return Promise.resolve(scrollToBottom()).finally(() => {
			clearTimeout(intentTimerRef.current);
			expandIntentRef.current = false;
		});
	};
	const expandAndReveal = () => {
		setRevealed(true); // the teach-check invitation was accepted (W5)
		setExpanded(true);
		void suppressFoldDuringReveal();
	};
	const expandAndRevealRef = useRef(expandAndReveal);
	expandAndRevealRef.current = expandAndReveal;
	// ENTER OPENS THE WAITING CHECK (owner, keyboard round 2026-10-06):
	// while a question waits with the dock CLOSED — behind its reveal
	// invitation or collapsed by scroll — Enter is never dead. Any live
	// dictation FINISHES FIRST (the flush lands in the reading-thinking
	// field, its live claim — the nothing-gets-lost law), then the check
	// opens. A typing surface or a focused button owns its own Enter (the
	// reading-thinking field opens from INSIDE when the check is closed;
	// a focused button activates natively) — this listener claims only
	// the dead case: plain focus with Enter doing nothing.
	useEffect(() => {
		if (!pending || expanded) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Enter" || e.altKey) return;
			if (e.shiftKey && !e.metaKey && !e.ctrlKey) return;
			const t = e.target as HTMLElement | null;
			if (
				t &&
				((t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range") ||
				t.tagName === "TEXTAREA" ||
				t.isContentEditable ||
				t.closest("button"))
			)
				return;
			e.preventDefault();
			void finishDictation().then(() => {
				expandAndRevealRef.current();
			});
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [pending, expanded]);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const onScroll = () => {
			if (!pendingRef.current) return;
			// Resize mute (owner, resize round): a geometry change re-clamps
			// scrollTop and the browser emits the clamp as a scroll event —
			// reading the transient position folded the box to the bar for a
			// flicker. Real scrolling resumes after the brief mute window.
			if (Date.now() - geometryAtRef.current < 400) return;
			// Growth mute (owner round, 2026-10-05): the transcript growing
			// under a live turn is not the learner leaving.
			if (Date.now() - growthAtRef.current < 400) return;
			const d = el.scrollHeight - el.clientHeight - el.scrollTop;
			if (expandedRef.current) {
				// INTENT-GATED FOLD (owner ruling, 2026-10-05): distance alone
				// folded on stick-to-bottom's catch-up transients; a real fold
				// needs the distance AND stick-to-bottom agreeing the learner
				// left the bottom.
				if (d > COLLAPSE_DIST && !expandIntentRef.current && !atBottomRef.current) setExpanded(false);
			} else if (d < EXPAND_DIST) {
				// Teach checks stay collapsed until the learner opens them (W5): the
				// at-bottom auto-expand would pop the form over the teaching.
				if (requiresRevealRef.current && !revealedRef.current) return;
				setExpanded(true);
				void scrollToBottom();
			}
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, [scrollRef, scrollToBottom]);

	// The settled block height (gradient excluded), offered to the spacer.
	// Only ever called with NATURAL heights — never the animated mid-morph
	// value (the iso effect's getAnimations guard wraps every call).
	const measureBlock = () => {
		const b = blockRef.current;
		if (b) offer(b.getBoundingClientRect().height);
	};

	const mode = pending
		? `question:${pending.toolCallId}`
		: practice
			? `practice:${practice.toolCallId}`
			: "chat";
	// The opening variant of a session appears instantly — the fade/rise is
	// reserved for mid-session transitions.
	const initialModeRef = useRef(mode);

	// Height morph: animate the shell from its previous height to its new one
	// whenever the variant (chat ↔ question ↔ collapsed bar) changes. Typing
	// growth keeps the same stateKey and is NOT animated.
	const shellRef = useRef<HTMLDivElement>(null);
	// The fold's CONTENT fade (owner round, 2026-10-05): the shell height
	// morphs, but the bar↔form content used to hard-swap. A WAAPI fade/rise
	// on the toggle — no remount, so the question form's state survives.
	const contentRef = useRef<HTMLDivElement>(null);
	const prevExpandedForFadeRef = useRef(expanded);
	useIsoLayoutEffect(() => {
		if (prevExpandedForFadeRef.current === expanded) return;
		prevExpandedForFadeRef.current = expanded;
		contentRef.current?.animate(
			[{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }],
			{ duration: 160, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
		);
	}, [expanded]);
	// The height-morph key (components/dock-state-key.ts): the expanded
	// term (the fold) belongs to EVERY docked variant — question AND
	// practice (owner fix, 2026-10-06). Typing growth keeps the key and
	// never animates; the fold/unfold morphs like teaching always has.
	const stateKey = dockStateKey(mode, !!pending || !!practice, expanded);
	const prevRef = useRef<{ key: string; height: number } | null>(null);
	useIsoLayoutEffect(() => {
		const el = shellRef.current;
		if (!el) return;
		const p = prevRef.current;
		if (p && p.key === stateKey) {
			// Same variant: keep the settled height fresh, but never measure while
			// a morph is in flight — getBoundingClientRect would read the ANIMATED
			// value and corrupt the start height of the next morph.
			if (el.getAnimations().length === 0) {
				const h = el.getBoundingClientRect().height;
				p.height = h;
				measureBlock(); // typing growth → the spacer grows with the box
			}
			return;
		}
		el.getAnimations().forEach((a) => a.cancel()); // flush to natural height before measuring
		const h = el.getBoundingClientRect().height;
		// Variant change → re-reserve. Growth applies instantly; a drop (the
		// fold, or question → composer) is filtered by the offer policy.
		measureBlock();
		if (p && Math.abs(p.height - h) > 1) {
			el.animate([{ height: `${p.height}px` }, { height: `${h}px` }], {
				duration: 120,
				easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
			});
		}
		prevRef.current = { key: stateKey, height: h };
	});

	return (
		<div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ right: sbInset }}>
			<div className="h-24 bg-gradient-to-t from-background via-background/85 to-transparent" />
			<div ref={blockRef} className="relative bg-background pb-5" style={{ "--dock-max-h": dockMaxH ? `${dockMaxH}px` : undefined } as React.CSSProperties}>
				<div className={DOCK}>
					{setupCta}
					{/* The queued-steer indicator (owner spec 2026-10-03): quiet
					    one-liners above the shell - right-aligned to where its corner
					    rounding starts, truncated, no background, no container. A
					    line dies when its card lands (visibleQueuedSteers). */}
					<QueuedSteersBody steers={queuedSteers} />
					{/* The reading-thinking field (owner 2026-10-03): mounted while a
					    teach-phase check waits — the same cue that collapses it. It
					    claims dictated speech until the learner reveals the check
					    (the dock reclaims then). Rides the check answer on submit. */}
					{pending && requiresReveal && (
						<ReadingThinkingField
							value={readingThinking}
							onChange={onReadingThinking}
							onEscape={dictationCancel}
							onOpen={
								!expanded
									? () => {
											void finishDictation().then(() => {
												expandAndRevealRef.current();
											});
										}
									: undefined
							}
							claim={revealPending}
						/>
					)}
					<div ref={shellRef} className="pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg">
						<div
						ref={contentRef}
						key={mode}
						className={mode === initialModeRef.current ? undefined : "dock-variant"}
					>
							{pending ? (
								<QuestionDock
									toolName={pending.tool as "quiz" | "probe" | "ask_user_question" | "explain" | "recall"}
									toolCallId={pending.toolCallId}
									input={pending.input as never}
									expanded={expanded}
									reveal={revealPending}
									phase={phase}
									onExpand={expandAndReveal}
									onSubmit={onSubmitAnswer}
									initialDraft={initialQuestionDraft}
									onSaveDraft={onSaveQuestionDraft}
									onEscape={dictationCancel}
									dictationClaim={!revealPending}
									compactionRunning={compactionRunning}
								/>
							) : practice ? (
								<PracticeDock
									problemCallId={practice.toolCallId}
									input={practice.input as { statement: string }}
									expanded={expanded}
									onExpand={() => {
										setExpanded(true);
										void suppressFoldDuringReveal();
									}}
									onSubmit={onSubmitThinking}
									onEscape={dictationCancel}
									compactionRunning={compactionRunning}
								/>
							) : (
								composer
							)}
						</div>
					</div>
					{/* The stats row: beneath the composer/question shell, not
					    flush to the screen bottom — static height, outside the
					    morphing shell so it never joins a height animation. */}
					<StatsBar
						turns={turns}
						contextTokens={contextTokens}
						pricing={pricing}
						dictationSlot={dictationSlot}
						chatId={chatId}
					/>
					{/* The scroll-down disc (moved here from the Conversation,
					    owner refinement round 2026-09-24): anchored to the BLOCK's
					    top edge — above the composer shell AND the stats row, in
					    the gradient's transparent band — so it never overlaps
					    any dock element. Because the anchor is the block itself
					    (not the scroller's bottom), it rides every height change
					    LIVE: typing growth, a pending question expanding the
					    band, the 180ms fold morph. pointer-events-auto: the
					    overlay is none by default. The isAtBottom/scrollToBottom
					    context still reaches it — DockOverlay is a Conversation
					    child. */}
					<ConversationScrollButton className="pointer-events-auto bottom-full mb-2" />
				</div>
				{/* The plan marginalia (owner, plan-placement round): the bare
				    diagram in the band's right flank — boundaless, meet-fitted, part
				    of the lesson's page rather than a floating widget. Mounted only
				    while a question owns the band (its reserved height is the canvas);
				    folding the dock fades + blurs it out of existence, so reading
				    the transcript in full wipes the margin clean. Click → popup.
				    Width (owner, resize round): the box shrinks continuously with
				    the flank; below MARGIN_MIN_W it FADES (never pops away — no
				    mid-question unmount), and widening past the floor fades it
				    back in. */}
				{pending && plan && (
					<Hint label="Open the full plan" side="bottom">
<button
						type="button"
						data-testid="plan-marginalia"
						onClick={onOpenPlan}
						style={{ left: `calc(50% + ${DOCK_W / 2 + MARGIN_GAP}px)` }}
						className={`absolute bottom-5 right-4 top-0 cursor-pointer transition-[filter,opacity] duration-300 ease-out ${
							expanded && flankW >= MARGIN_MIN_W
								? "pointer-events-auto opacity-100 blur-0"
								: "pointer-events-none opacity-0 blur-md"
						}`}
					>
						{plan}
					</button>
</Hint>
				)}
			</div>
		</div>
	);
}
