"use client";

import { createContext, Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useChatSession } from "@/components/session";
import { usePlugins } from "./plugins";
import { PluginSubmissionRunner, SubmissionModelEpoch, type SubmissionAttempt } from "./plugin-submission-runner";
import { submissionImages, type BuiltinSubmissionCapture, type PrepareBuiltinSubmission, type PrepareThinkingSubmission, type PreparePluginQuestionSubmission, type PreparePluginProblemSubmission } from "./plugin-submission-adapters";
import { SubmittedImages } from "./submitted-images";
import { usePageSurfaceBoundary, SurfaceRegion } from "./plugin-surfaces";
import { findSurfaceBoundary } from "./plugin-surface-targets";
import { scheduleOpeningSubmission } from "./plugin-submission-opening";
import { activeProblemOccurrenceOf, buildAnswer, toClientQuestion, type PluginSubmission, type PluginSubmissionTarget, type QuestionData } from "@/src/core";
import { validatePluginBuiltinSubmissionAnswer } from "@/src/core";
import { visibleQueuedSteers } from "@/components/session-core";
import { SetupDialog } from "@/components/setup-dialog";
import { Hint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";
import { useModelSetup, selectedModelUnavailable, openModelPicker, ZeroKeysPill } from "@/components/setup-cta";
import { useStickToBottomContext, type StickToBottomContext } from "use-stick-to-bottom";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { PathText } from "@/components/file-path-chip";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { BrailleSpinner } from "@/components/braille-spinner";
import { ToolPartRenderer } from "@/components/plugin-renderers";
import { Separator } from "@/components/ui/separator";
import { AnsweredCard } from "@/components/answered-card";
import { MalformedQuestion } from "@/components/malformed-question";
import { SubagentSteerCard } from "@/components/artifacts/steer-card";
import { ChatSessionComposer } from "@/components/composer";
import { useEnterSubmits } from "@/components/enter-submits";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { dockStateKey } from "@/components/dock-state-key";
import { clearOpeningPrompt, readOpeningPromptEntry, stashOpeningPrompt, OPENING_PROMPT_FAILURE } from "@/components/opening-prompt";
import { forwardDockWheel, useDockHeight } from "@/components/dock-height";
import { createDockMorph } from "@/components/dock-morph";
import { QueuedSteersBody, type QueuedSteerLine } from "@/components/queued-steers";
import { DictationBar, finishDictation, joinDictation, useDictation, type Dictation } from "@/components/dictation";
import { useFieldCycle } from "@/components/field-cycle";
import { useOptionalInteractionLayers } from "./interaction-layers";
import { isInteractionScopeEligible } from "./plugin-input-focus";
import { JobsContext } from "@/components/jobs-context";
import { StatsBar } from "@/components/stats-bar";
import { useServerEvent, useServerResync } from "@/components/server-events";
import {
	isProviderKeyRefusal,
	firstSourceTextParts,
	cliContextWindowOf,
	messageAnchorId,
	sideEntryPoints,
	sideSegmentId,
	textPartMessageId,
	kbdEventForAction as kbdEventForChat,
	type ChatInput,
	type ChatSettings,
	type LhMessage,
	type ModelSlotName,
} from "@/src/core";
import { PlanBlock, PlanPopup, latestTree } from "@/components/plan-block";
import { PlanMarginalia, planExists } from "@/components/plan-window";
import { MermaidOverlay, SessionMermaidContext, type SessionImage } from "@/components/session-overlay";
import { AbortTurnDialog, type AbortMode } from "@/components/abort-turn-dialog";
import { ArrowRightIcon, DumbbellIcon, MessageCircleQuestionIcon, WaypointsIcon } from "lucide-react";
import type { PlanBlockData } from "@/src/core";
import { QuestionDock } from "@/components/question-dock";
import { PluginQuestionDock } from "./plugin-question-dock";
import { PluginQuestionPart } from "./plugin-question-part";
import { pluginQuestionKeySuppressed, composingQuestionKey } from "./plugin-question-keys";
import { capturePluginQuestionDismissal, confirmPluginQuestionDismissal, type PluginQuestionDismissalTarget } from "./plugin-question-dismissal";
import { pendingPluginQuestionOf, pluginQuestionCallsOf } from "@/src/core";
import { pluginQuestionOccurrenceKey, type PluginQuestionSnapshot } from "@/src/core";
import type { PluginQuestionDraft } from "./session-core";
import { SessionFind } from "@/components/session-find";
import { SessionMessageNavigation } from "@/components/session-navigation";
import { SelectionToolbar } from "@/components/selection-toolbar";
import { createCiteAction, type CitationEditTarget } from "@/components/citation-actions";
import { CitationActionsContext, type CitationActions } from "@/components/citation-chip";
import { CitationCommentPopover } from "@/components/citation-comment-popover";
import { revealCitationSource } from "@/components/citation-source";
import { createSideQuestionActions, SideThreadBody, SideThreadPanel, SideThreadPopover } from "@/components/side-thread";
import { useSideThread, type SideThreadOpenArgs } from "@/components/use-side-thread";
import { useRouter } from "next/navigation";
import { PracticeDock } from "@/components/practice-dock";
import { PluginProblemDock, type PluginProblemDockProps } from "./plugin-problem-dock";
import { practiceProblemForCall } from "@/src/core";
import { PluginProblemSubmitted } from "./plugin-problem-submitted";
import { readPluginProblemSubmission, pluginProblemById } from "@/src/core";
import { ThinkingCard, ProblemCard, type PracticeThinkingData } from "@/components/practice-cards";
import { GraphContextCard, type GraphContextData } from "@/components/graph-context-card";
import { TopBar } from "@/components/top-bar";
import { PluginTopBarActions } from "@/components/plugin-chrome";
import { usePluginShortcutPage } from "@/components/plugin-shortcuts";
import { createPluginSessionActionContext, type PluginSessionViewInput } from "@/src/core";
import type { SessionInputViewReader, SessionViewTargets, NativeQuestionViewState, ViewReaderRef } from "./session-view-readers";
import type { JobRecord, Phase3, QuestionAnswerData, QuestionFormDraft, TurnUsage, SessionPricing } from "@/src/core";
import type { LhViewMessage } from "@/src/core";
import { PhaseChip, PhaseDivider } from "@/components/phase-divider";
import {
	CompactionCutDivider,
	CompactionMomentDivider,
	type CompactionDividerData,
} from "@/components/compaction-divider";
import { CoverageRing } from "@/components/extraction-coverage";
import { Button } from "@/components/ui/button";
import {
	activeProblemOf,
	pendingQuestionOf,
	malformedQuestionsOf,
	dismissedAnswer,
	endsInFailedTurn,
	findPendingToolCall,
	phaseAt3,
	phaseTimeline,
	teachStepIndex,
	toolQuestionKind,
	questionNeedsReveal,
} from "@/src/core";
import { ReadingThinkingField } from "@/components/reading-thinking";
import { currentUserThinkingOpen, setAllUserThinkingOpen } from "@/components/thinking-block";

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

/** Retry sends no composer text. Its refusal must not resurrect the draft
 * from an earlier, already-durable text send over today's unsent composer.
 * Retire that fallback synchronously, never when the async Retry settles:
 * a later ordinary send may own a new recovery draft by then. */
export function retryFailedResponse(
	send: (input: ChatInput) => void,
	submittedDraft: { current: string | null },
): void {
	submittedDraft.current = null;
	void send({ type: "retry" });
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

/** One immediate optimistic placeholder; only its wording changes during
 * host-managed submission evaluation. The spinner keeps its identity. */
export function PendingTurnIndicator({ evaluating }: { evaluating: boolean }) {
	return (
		<span className="flex items-center gap-2 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
			<BrailleSpinner label={evaluating ? "Evaluating" : "Thinking"} />
			<Shimmer duration={1}>{evaluating ? "EVALUATING…" : "THINKING…"}</Shimmer>
		</span>
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
	const { canonicalMessages, reconciliation, reconcile, pluginQuestionAvailability, pluginQuestionDraft, pluginProblemAvailability, pluginProblemDraft, dismissPluginQuestion, readRecord, messages, nativeMessages, hasConfirmedConversation, contextTokens, send, continueIfOwed, steer, steerQueue, submitAnswer, dismissQuestion, dismissProblem, questionDraft, saveQuestionDraft, status, evaluating, error, stop, clearError, resumeStream, setReattachSettled } =
		useChatSession({ chatId, initialMessages, initialError, initiallyInFlight });

	const controller = useOptionalInteractionLayers();
	const sessionFindScopeRef = useRef<HTMLDivElement | null>(null);
	const pathname = usePathname();
	const surfaceTarget = usePageSurfaceBoundary({ active: pathname === `/chat/${encodeURIComponent(chatId)}`, viewKey: chatId, bodyRef: sessionFindScopeRef });
	const { manager: pluginManager } = usePlugins();
	const [, submissionChanged] = useState(0);
	const [preparationError, setPreparationError] = useState<string>();
	const [submissionRunner] = useState(() => new PluginSubmissionRunner(() => submissionChanged(n => n + 1)));
	const [submissionModel] = useState(() => new SubmissionModelEpoch());
	const submissionMounted = useRef(true);
	useEffect(() => { submissionMounted.current = true; return () => { submissionMounted.current = false; submissionRunner.dispose(); }; }, [submissionRunner]);
	useEffect(() => () => submissionRunner.dispose(), [surfaceTarget, submissionRunner]);
	const inputViewReader = useRef<(() => PluginSessionViewInput) | null>(null) as SessionInputViewReader;
	const [, refreshViewContext] = useState(0);
	const notifyViewChanged = useCallback(() => { if (submissionMounted.current) refreshViewContext(value => value + 1); }, []);
	inputViewReader.changed = notifyViewChanged;
	const submissionLive = useRef({ nativeMessages, surfaceTarget, ready: true });
	submissionLive.current = { nativeMessages, surfaceTarget, ready: true };
	const runSubmission = async (target: PluginSubmissionTarget, capture: () => PluginSubmission | Promise<PluginSubmission>, current: () => boolean, deliver: (prepared: PluginSubmission, attempt: SubmissionAttempt) => Promise<boolean>): Promise<boolean> => {
		const modelRevision = submissionModel.capture();
		const attempt = submissionRunner.begin(target, pluginManager?.captureSubmissionInterceptors() ?? [], () => submissionMounted.current && submissionModel.isCurrent(modelRevision) && submissionLive.current.surfaceTarget === target.surfaceTarget && !!findSurfaceBoundary(target.surfaceTarget) && current());
		if (!attempt) return false;
		setPreparationError(undefined);
		try {
			const input = await attempt.finalize(async () => { await finishDictation(); return capture(); });
			const prepared = await attempt.prepare(input, submissionLive.current.nativeMessages);
			if (!prepared) return false;
			attempt.check();
			return await deliver(prepared, attempt);
		} catch (error) {
			attempt.cancel(); attempt.refused();
			if (!(error instanceof DOMException && error.name === "AbortError")) setPreparationError(attempt.preparationFailure(error).message);
			return false;
		}
	};
	const textTarget = (): Extract<PluginSubmissionTarget, { type: "text" }> | undefined => surfaceTarget ? { type: "text", sessionId: chatId, sessionKind: kind === "practice" ? "practice" : "teaching", surfaceTarget, channels: ["content"] } : undefined;
	const scrollContextRef = useRef<StickToBottomContext | null>(null);
	const sourceTextParts = useMemo(() => firstSourceTextParts(messages), [messages]);
	const sideEntries = useMemo(() => sideEntryPoints(nativeMessages, messages), [nativeMessages, messages]);

	// The reattach settled terminal → the sync-and-continue seam (below).
	setReattachSettled(() => reattachSettledRef.current());

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
			if (!isInteractionScopeEligible(sessionFindScopeRef.current, controller)) return;
			setTitleDraft(titleText);
			setRenaming(true);
		};
		window.addEventListener("lh:kbd-rename-session", onRename);
		return () => window.removeEventListener("lh:kbd-rename-session", onRename);
	}, [titleText, controller]);

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
	const pluginAbortTarget = useRef<PluginQuestionDismissalTarget | null>(null);
	const pluginDismissal = useRef({ canonicalMessages, reconciliation, stop, dismissPluginQuestion });
	pluginDismissal.current = { canonicalMessages, reconciliation, stop, dismissPluginQuestion };
	const closeAbortAsk = useCallback(() => { pluginAbortTarget.current = null; setAbortAsk(null); }, []);
	useEffect(() => {
		const onAbort = () => {
			if (!isInteractionScopeEligible(sessionFindScopeRef.current, controller)) return;
			const pluginQuestion = capturePluginQuestionDismissal(pluginDismissal.current.canonicalMessages);
			const target = escAbortTarget({
				abortAsk: abortAskRef.current !== null,
				sideThread: sideThreadOpenRef.current,
				mermaidFocus: mermaidFocusRef.current !== null || figureFocusRef.current !== null,
				planOpen: planOpenRef.current,
				setupOpen: setupOpenRef.current,
				pending: pendingRef.current !== null || pluginQuestion !== null,
				problem: activeProblemRef.current !== null,
				busy: busyRef.current,
			});
			if (target === "side-thread") closeSideThreadRef.current();
			else if (target === "question") { pluginAbortTarget.current = pluginQuestion; setAbortAsk("question"); }
			else if (target === "problem") setAbortAsk("problem");
			else if (target === "turn") setAbortAsk("turn");
			else if (target === "mermaid") setMermaidFocus(null);
			else if (target === "plan") setPlanOpen(false);
			// setup closes itself; null = nothing to do — both claimed.
		};
		window.addEventListener("lh:kbd-abort-turn", onAbort);
		return () => window.removeEventListener("lh:kbd-abort-turn", onAbort);
	}, [controller]);
	const confirmAbort = useCallback(
		(mode: AbortMode) => {
			const pluginQuestion = pluginAbortTarget.current;
			closeAbortAsk();
			if (mode === "question" && pluginQuestion) {
				confirmPluginQuestionDismissal(pluginQuestion, pluginDismissal.current);
				return;
			}
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
				void closeSideThreadRef.current(); // its note lands after the skip
				const answer = dismissedAnswer(toolQuestionKind(p.tool), question);
				void dismissQuestion(
					p.toolCallId,
					reading ? { ...answer, readingThinking: reading } : answer,
					p.key,
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
		[abortInFlightTurn, dismissQuestion, dismissProblem, closeAbortAsk],
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

	const pendingPlugin = pendingPluginQuestionOf(canonicalMessages);
	const unreadablePlugin = pluginQuestionCallsOf(canonicalMessages).find(call => call.status === "unreadable");
	const pluginOwnsDock = !!pendingPlugin || !!unreadablePlugin;
	const [pluginMicAvailable, setPluginMicAvailable] = useState(false);
	const pluginProblemIdentity = activeProblemOf(canonicalMessages)?.pluginProblem?.problemId;
	const pluginCanonicalIdentity = pendingPlugin?.questionId ?? (unreadablePlugin ? pluginQuestionOccurrenceKey(unreadablePlugin.occurrence) : pluginProblemIdentity ?? null);
	useEffect(() => {
		// Effect reconnection (including StrictMode replay) must renew the
		// canonical read; a retained identity ref cannot certify a connection.
		if (pluginCanonicalIdentity) void reconcile();
	}, [pluginCanonicalIdentity, reconcile]);
	useServerEvent("plugins-changed", () => {
		if ((pluginOwnsDock || pluginProblemIdentity) && status !== "submitted" && status !== "streaming") void reconcile();
	});
	const pending = findPendingToolCall(messages, pendingQuestionOf(nativeMessages));
	const malformedQuestions = malformedQuestionsOf(nativeMessages);
	// The abort handler reads the pending question from a ref (the window
	// listener is mount-scoped; the value it needs is render-scoped).
	const pendingRef = useRef(pending);
	pendingRef.current = pending;

	// THE ACTIVE PRACTICE PROBLEM (practice sessions, 2026-10-04): the
	// same dock-ownership rule as a pending question — an active problem
	// replaces the composer. Computed from the NATIVE record (the fold is
	// the gate the tools themselves read), not the projected view.
	const activeProblem = activeProblemOf(nativeMessages);
	const activeProblemOccurrence = activeProblemOccurrenceOf(nativeMessages);
	const activeProblemRef = useRef(activeProblem);
	activeProblemRef.current = activeProblem;

	const localStream = status === "submitted" || status === "streaming";
	const busy = localStream || turnInFlight || reconciliation !== "ready";
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
	const requiresReveal = pendingPlugin ? pendingPlugin.variant === "teach" && pendingPlugin.input.type === "check" : pending !== null && questionNeedsReveal(pending.tool, pending.input, phaseAt3(messages));

	/* The READING-THINKING channel (owner 2026-10-03): a draft field for
	 * thinking while reading the teaching prose, mounted while a check waits
	 * behind its reveal, riding the check answer (or its dismissal) as the
	 * separate `readingThinking` field. Reset per pending question. */
	const [readingThinkingSeed, setReadingThinkingSeed] = useState({ questionId: null as string | null, value: "", revision: 0 });
	const readingThinkingRef = useRef("");

	// ⌘T (toggle-user-thinking, owner round 2026-10-07): set EVERY user
	// thinking row to one state — transcript rows default open, so the
	// first press collapses everything, the second re-expands.
	useEffect(() => {
		const onToggle = () => {
			if (isInteractionScopeEligible(sessionFindScopeRef.current, controller)) setAllUserThinkingOpen(!currentUserThinkingOpen());
		};
		window.addEventListener(kbdEventForChat("toggle-user-thinking"), onToggle);
		return () => window.removeEventListener(kbdEventForChat("toggle-user-thinking"), onToggle);
	}, [controller]);
	const applyReadingThinking = useCallback((v: string) => {
		readingThinkingRef.current = v;
	}, []);
	const clearReadingThinking = useCallback(() => {
		readingThinkingRef.current = "";
		setReadingThinkingSeed((previous) => ({ ...previous, value: "", revision: previous.revision + 1 }));
	}, []);
	const pendingQuestionId = pendingPlugin ? pluginQuestionOccurrenceKey(pendingPlugin.occurrence) : pending?.key ?? null;
	useLayoutEffect(() => {
		// Different calls never share a draft; a failed submission of THIS
		// call restores the reading channel alongside the form's snapshot.
		const value = pendingPlugin ? pluginQuestionDraft(pendingPlugin).readingThinking : pendingQuestionId ? questionDraft(pendingQuestionId)?.readingThinking ?? "" : "";
		readingThinkingRef.current = value;
		setReadingThinkingSeed((previous) =>
			previous.questionId === pendingQuestionId && previous.value === value
				? previous
				: { questionId: pendingQuestionId, value, revision: previous.revision + 1 },
		);
	}, [pendingQuestionId, questionDraft, pluginQuestionDraft]);

	// The phase at every message (one linear fold): the transcript draws a
	// color-coded dotted divider at each boundary; the header chip reads the
	// session's current phase.
	const phases = useMemo(() => phaseTimeline(messages), [messages]);

	const [composerDraftRevision, setComposerDraftRevision] = useState(0);
	/* The composer draft ref is synchronous, so sends and dictation flushes
	 * read the latest text without a parent render per input event. Explicit
	 * resets still bump a revision so the local field can sync. */
	const textRef = useRef("");
	const composerEditRevision = useRef(0);
	const applyText = useCallback((v: string) => {
		textRef.current = v; composerEditRevision.current++;
		setComposerDraftRevision((revision) => revision + 1);
	}, []);
	const recordComposerText = useCallback((v: string) => {
		textRef.current = v; composerEditRevision.current++;
	}, []);
	// Saved slot completeness is live, but the session's selected route
	// comes from its own ordinary model control, never today's Strong pin.
	const { catalog, configured, zeroKeys } = useModelSetup(initialConfigured);
	const catalogRef = useRef(catalog);
	catalogRef.current = catalog;
	const [selectedModel, setSelectedModel] = useState<string | undefined>();
	const recordSelectedModel = useCallback((model: string | undefined) => { submissionModel.observe(model); setSelectedModel(model); }, [submissionModel]);
	const [setupOpen, setSetupOpen] = useState(false);
	/** The last explicitly-sent draft (composer send): the
	 *  refusal flow restores it into the composer, where it waits for the
	 *  learner to re-send (Save never auto-sends, owner 2026-10-09).
	 *  Auto-continuations (probe answers) never set it — their refusal
	 *  opens recovery with no replay. */
	const draftRef = useRef<string | null>(null);
	const openingDraftRef = useRef<string | null>(null);
	const [openingError, setOpeningError] = useState(false);
	const openingMountedRef = useRef(false);
	useEffect(() => {
		openingMountedRef.current = true;
		return () => { openingMountedRef.current = false; };
	}, []);

	const builtinTarget = (question: QuestionData): Extract<PluginSubmissionTarget, { type: "answer" }> | undefined => {
		if (!surfaceTarget || !pending) return;
		return { type: "answer", sessionId: chatId, sessionKind: kind === "practice" ? "practice" : "teaching", surfaceTarget,
			channels: ["answer", "thinking", ...(requiresReveal ? ["readingThinking" as const] : [])],
			question: { ...toClientQuestion(question), occurrence: { messageId: pending.messageId, contentIndex: pending.contentIndex, toolCallId: pending.toolCallId, toolName: pending.tool }, ...(question.questionType ? { questionType: question.questionType } : {}) },
		};
	};
	const prepareBuiltin: PrepareBuiltinSubmission = ({ question, capture, isCurrent }: BuiltinSubmissionCapture) => {
		const target = builtinTarget(question), original = pending;
		if (!target || !original || busyRef.current || compacting) return;
		void runSubmission(target, () => {
			const raw = capture();
			saveQuestionDraft(original.key, { readingThinking: readingThinkingRef.current });
			return { type: "answer", answer: {
				...(raw.dontKnow !== undefined ? { dontKnow: raw.dontKnow } : {}), ...(raw.values !== undefined ? { values: raw.values } : {}),
				...(raw.other !== undefined ? { other: raw.other } : {}), ...(raw.text !== undefined ? { text: raw.text } : {}),
				...(raw.confidence !== undefined ? { confidence: raw.confidence } : {}), images: [],
			}, thinking: { text: raw.thinking ?? "", images: [] }, readingThinking: { text: requiresReveal ? readingThinkingRef.current : "", images: [] } };
		}, () => {
			const now = pendingQuestionOf(submissionLive.current.nativeMessages);
			return isCurrent() && !busyRef.current && now?.messageId === original.messageId && now.contentIndex === original.contentIndex && now.toolCallId === original.toolCallId && now.tool === original.tool;
		}, async (prepared, attempt) => {
			if (prepared.type !== "answer") return false;
			const raw = validatePluginBuiltinSubmissionAnswer(question, prepared.answer);
			const answer = buildAnswer(question, { ...raw, ...(prepared.thinking.text ? { thinking: prepared.thinking.text } : {}), ...(requiresReveal && prepared.readingThinking.text ? { readingThinking: prepared.readingThinking.text } : {}) }, original.tool);
			const images = submissionImages(prepared, target.channels);
			// Save newer native edits without changing the prepared payload.
			capture(); saveQuestionDraft(original.key, { readingThinking: readingThinkingRef.current });
			attempt.deliver();
			return send({ type: "answer", toolCallId: original.toolCallId, occurrence: target.question.occurrence, answer: { ...answer, ...(images ? { images } : {}) } }, attempt.accepted, original.key, attempt.refused);
		});
	};
	const thinkingTarget = (): Extract<PluginSubmissionTarget, { type: "thinking" }> | undefined => {
		const occurrence = activeProblemOccurrenceOf(nativeMessages);
		if (!surfaceTarget || !activeProblem || activeProblem.pluginProblem || !occurrence) return;
		return { type: "thinking", sessionId: chatId, sessionKind: kind === "practice" ? "practice" : "teaching", surfaceTarget, channels: ["content"], problem: { occurrence, statement: (activeProblem.input as { statement: string }).statement } };
	};
	const prepareThinking: PrepareThinkingSubmission = (capture, clear) => {
		const target = thinkingTarget();
		if (!target || busyRef.current || compacting) return;
		let captured = "";
		void runSubmission(target, () => ({ type: "thinking", content: { text: captured = capture(), images: [] } }), () => !busyRef.current && JSON.stringify(activeProblemOccurrenceOf(submissionLive.current.nativeMessages)) === JSON.stringify(target.problem.occurrence), async (prepared, attempt) => {
			if (prepared.type !== "thinking") return false;
			if (!prepared.content.text.trim() && !prepared.content.images.length) throw new Error("Thinking text or images are required. Your input has been kept.");
			attempt.deliver();
			return send({ type: "thinking", problemCallId: target.problem.occurrence.toolCallId, occurrence: target.problem.occurrence, text: prepared.content.text, ...(prepared.content.images.length ? { images: prepared.content.images.map(image => ({ ...image })) } : {}) }, () => { clear(captured); attempt.accepted(); }, undefined, attempt.refused);
		});
	};
	const pluginProblemTarget = (): Extract<PluginSubmissionTarget, { type: "plugin-problem-submission" }> | undefined => {
		const original = activeProblem?.pluginProblem, occurrence = activeProblemOccurrence;
		if (!surfaceTarget || !original || !occurrence) return;
		return { type: "plugin-problem-submission", sessionId: chatId, sessionKind: "practice", surfaceTarget,
			channels: ["submission", "thinking"], problem: { problemId: original.problemId, occurrence, pluginId: original.pluginId, typeId: original.typeId, contractVersion: original.contractVersion, label: original.label, statement: original.input.statement } };
	};
	const preparePluginProblem: PreparePluginProblemSubmission = (capture, isCurrent, onAccepted) => {
		const original = activeProblem?.pluginProblem, occurrence = activeProblemOccurrence, target = pluginProblemTarget();
		if (!target || !original || !occurrence || busyRef.current || compacting) return Promise.resolve(false);
		return runSubmission(target, () => {
			const raw = capture();
			return { type: "plugin-problem-submission", submission: raw.submission, submissionImages: [], thinking: { text: raw.thinking ?? "", images: [] } };
		}, () => isCurrent() && !busyRef.current && activeProblemOf(submissionLive.current.nativeMessages)?.pluginProblem?.problemId === original.problemId, async (prepared, attempt) => {
			if (prepared.type !== "plugin-problem-submission") return false;
			const images = { ...(prepared.submissionImages.length ? { submission: prepared.submissionImages } : {}), ...(prepared.thinking.images.length ? { thinking: prepared.thinking.images } : {}) };
			attempt.deliver();
			return send({ type: "plugin-problem-submission", problemId: original.problemId, occurrence, submission: prepared.submission as Extract<ChatInput, { type: "plugin-problem-submission" }>["submission"],
				thinking: prepared.thinking.text, ...(Object.keys(images).length ? { images } : {}),
			}, () => { onAccepted(); attempt.accepted(); }, undefined, attempt.refused);
		});
	};
	const pluginQuestionTarget = (): Extract<PluginSubmissionTarget, { type: "plugin-question-answer" }> | undefined => {
		if (!surfaceTarget || !pendingPlugin) return;
		const original = pendingPlugin;
		return { type: "plugin-question-answer", sessionId: chatId, sessionKind: kind === "practice" ? "practice" : "teaching", surfaceTarget,
			channels: ["answer", ...(original.showThinking ? ["thinking" as const] : []), ...(requiresReveal ? ["readingThinking" as const] : [])],
			question: { questionId: original.questionId, occurrence: original.occurrence, pluginId: original.pluginId, typeId: original.typeId, contractVersion: original.contractVersion, label: original.label, variant: original.variant, showThinking: original.showThinking },
		};
	};
	const preparePluginQuestion: PreparePluginQuestionSubmission = (capture, isCurrent) => {
		const target = pluginQuestionTarget();
		if (!target || !pendingPlugin || busyRef.current || compacting) return Promise.resolve(false);
		const original = pendingPlugin;
		return runSubmission(target, () => {
			const raw = capture();
			return { type: "plugin-question-answer", answer: raw.answer, answerImages: [], thinking: { text: raw.thinking ?? "", images: [] }, readingThinking: { text: raw.readingThinking ?? "", images: [] } };
		}, () => isCurrent() && !busyRef.current && pendingPluginQuestionOf(submissionLive.current.nativeMessages)?.questionId === original.questionId, async (prepared, attempt) => {
			if (prepared.type !== "plugin-question-answer") return false;
			const images = submissionImages(prepared, target.channels);
			attempt.deliver();
			return send({ type: "plugin-question-answer", questionId: original.questionId, occurrence: original.occurrence, answer: prepared.answer as Extract<ChatInput, { type: "plugin-question-answer" }>["answer"],
				...(original.showThinking ? { thinking: prepared.thinking.text } : {}), ...(requiresReveal ? { readingThinking: prepared.readingThinking.text } : {}), ...(images ? { images } : {}),
			}, attempt.accepted, undefined, attempt.refused);
		});
	};
	const prepareText = (supplied?: string, openingAccepted?: () => void, beforePost?: (captured: string) => boolean) => {
		const target = textTarget();
		if (!target || pendingRef.current || pluginOwnsDock || activeProblemRef.current || compacting) return Promise.resolve(false);
		if (!busyRef.current && zeroKeys) { setSetupOpen(true); return Promise.resolve(false); }
		if (!busyRef.current && selectedModelUnavailable(catalog, selectedModel)) { openModelPicker(); return Promise.resolve(false); }
		let captured = "", capturedRevision = 0;
		return runSubmission(target, () => { capturedRevision = composerEditRevision.current; return { type: "text", content: { text: captured = supplied ?? textRef.current.trim(), images: [] } }; }, () => submissionLive.current.ready && !pendingQuestionOf(submissionLive.current.nativeMessages) && !pendingPluginQuestionOf(submissionLive.current.nativeMessages) && !activeProblemOf(submissionLive.current.nativeMessages), async (prepared, attempt) => {
			if (prepared.type !== "text") return false;
			if (!prepared.content.text.trim() && !prepared.content.images.length) throw new Error("Message text or images are required. Your input has been kept.");
			if (beforePost && !beforePost(captured)) { attempt.cancel(); return false; }
			draftRef.current = captured;
			const accepted = () => { if (composerEditRevision.current === capturedRevision && textRef.current.trim() === captured) applyText(""); openingAccepted?.(); attempt.accepted(); };
			attempt.deliver();
			if (busyRef.current) return steer(prepared.content.text, prepared.content.images, accepted, attempt.refused);
			return send({ type: "text", text: prepared.content.text, ...(prepared.content.images.length ? { images: prepared.content.images.map(image => ({ ...image })) } : {}) }, accepted, undefined, attempt.refused);
		});
	};

	const deliverOpeningPrompt = (prompt: string, captureNative = false) => {
		let submitted = prompt;
		openingDraftRef.current = prompt;
		// Persist uncertainty BEFORE the POST: another mount must restore,
		// not race the still-arriving request. No storage means no auto-send.
		if (!stashOpeningPrompt(chatId, prompt, true)) {
			applyText(prompt);
			setOpeningError(true);
			return;
		}
		setOpeningError(false);
		draftRef.current = prompt; // The existing 503 flow must restore it too.
		void prepareText(captureNative ? undefined : prompt, () => {
			clearOpeningPrompt(chatId);
			openingDraftRef.current = null;
			if (draftRef.current === submitted) draftRef.current = null;
		}, captured => {
			submitted = captured; openingDraftRef.current = captured;
			const saved = stashOpeningPrompt(chatId, captured, true);
			if (!saved) setOpeningError(true);
			return saved;
		}).then(accepted => {
			if (!accepted && openingMountedRef.current && openingDraftRef.current === prompt && !textRef.current) {
				applyText(prompt);
			}
		});
	};

	const sentInitial = useRef(false);
	useEffect(() => {
		if (sentInitial.current || !surfaceTarget) return;
		return scheduleOpeningSubmission(
			() => !sentInitial.current && submissionMounted.current && submissionLive.current.surfaceTarget === surfaceTarget && !!findSurfaceBoundary(surfaceTarget),
			() => {
				sentInitial.current = true;
				const entry = readOpeningPromptEntry(chatId);
				const prompt = initialPrompt || entry?.text; // Legacy links still work.
				if (!initialPromptOwed(initialMessages, prompt)) {
					if (initialMessages.some(m => m.role === "user" || m.role === "assistant")) clearOpeningPrompt(chatId);
					return;
				}
				openingDraftRef.current = prompt!;
				if (entry?.attempted || initiallyInFlight) {
					applyText(prompt!); // Interrupted start: the learner explicitly resends.
					return;
				}
				deliverOpeningPrompt(prompt!);
			},
		);
	}, [chatId, initialPrompt, initialMessages, initiallyInFlight, surfaceTarget, deliverOpeningPrompt, applyText]);

	useEffect(() => {
		if (!hasConfirmedConversation) return;
		clearOpeningPrompt(chatId);
		// A later canonical read may confirm a lost acknowledgment. Clear
		// only the unchanged recovered draft, never the learner's newer work.
		const opening = openingDraftRef.current;
		if (opening !== null && textRef.current === opening) applyText("");
		if (draftRef.current === opening) draftRef.current = null;
		openingDraftRef.current = null;
		setOpeningError(false);
	}, [chatId, hasConfirmedConversation, applyText]);

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
		// provider key is gone also restores the draft. With another provider
		// connected, repair belongs to the ordinary current-session picker;
		// otherwise setup derives its exclusive provider/loading stage.
		const keyRefused = parseProviderKeyRefusal(error.message);
		if (!missing && !keyRefused) return; // a real error keeps the honest banner
		// ORDER MATTERS: clearError() flips this effect's own dep (`error`)
		// and would cancel the in-flight work below — so the banner dismiss,
		// the draft restore, and the dialog open all land TOGETHER after the
		// record refetch (the honest truth minus the refused send).
		let cancelled = false;
		void (async () => {
			try { await readRecord({ isCurrent: () => !cancelled }); }
			catch { /* refusal handling still restores the draft on a failed read */ }
			if (cancelled) return;
			if (draftRef.current !== null) {
				if (!textRef.current) applyText(draftRef.current);
				draftRef.current = null;
			}
			clearError();
			if (keyRefused && catalogRef.current?.providers.some((p) => p.keyPresent)) openModelPicker();
			else setSetupOpen(true);
		})();
		return () => {
			cancelled = true;
		};
		// (readRecord/clearError are stable per useChat instance — the
		//  dep pair [error, chatId] is what the flow actually keys on.)
	}, [error, chatId, readRecord]);
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
			...pick('[data-testid="reading-thinking-field"] [data-file-path-input]'),
			...pick('[data-testid="question-dock"] [data-file-path-input]'),
			...pick('[data-testid="practice-dock"] [data-file-path-input]'),
			...pick('[data-testid="composer"] [data-file-path-input]'),
		];
	}, []);
	useFieldCycle(cycleChatFields);
	const recording = useDictation({
		// Ref-first (see textRef): the join is computed from the mirror so a
		// send resuming after `await finish()` reads the dictated tail.
		append: (t) => { if (!pluginOwnsDock) applyText(joinDictation(textRef.current, t)); },
		disabled: pluginOwnsDock && !pluginMicAvailable,
	});
	const dictation: Dictation = { ...recording,
		phase: recording.destinationId === "main" ? recording.phase : "idle",
		active: recording.destinationId === "main" && recording.active,
		error: recording.destinationId === "main" ? recording.error : null,
		blocked: recording.destinationId !== "main" && recording.active,
	};
	/* When a dictation run ends, the bare composer takes focus (owner
	 * 2026-10-01) — the hands are already on the keyboard from the stop.
	 * Falling edge of `active` only (idle→idle never focuses), and ONLY the
	 * composer: with a question pending the Composer is unmounted, the ref
	 * is null, and the thinking field is left alone by design. */
	const dictationWasActiveRef = useRef(false);
	const composerInputRef = useRef<HTMLDivElement>(null);

	// CITE (2026-10-31): selected tutor text → a citation chip in the
	// composer, then its comment popover. The transcript's scroll element
	// arrives late (StickToBottom attaches it), so it is reported up.
	const [transcriptElement, setTranscriptElement] = useState<HTMLElement | null>(null);
	const [citationEdit, setCitationEdit] = useState<CitationEditTarget | null>(null);
	const lastCiteInputRef = useRef<HTMLElement | null>(null);
	const citeInput = useCallback(() => {
		const fields = cycleChatFields();
		return fields.find((field) => field === lastCiteInputRef.current) ?? fields[0] ?? composerInputRef.current;
	}, [cycleChatFields]);
	useEffect(() => {
		const remember = (event: FocusEvent) => {
			const input = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-file-path-input]") : null;
			if (input && cycleChatFields().includes(input)) lastCiteInputRef.current = input;
		};
		document.addEventListener("focusin", remember);
		return () => document.removeEventListener("focusin", remember);
	}, [cycleChatFields]);
	const citeAction = useMemo(
		() => createCiteAction({ chatId, composer: citeInput, openEditor: setCitationEdit }),
		[chatId, citeInput],
	);
	// One durable companion per explanation/check, in teaching AND practice.
	// Main requests append new raw exchanges from every thread; closing only hides the UI.
	const workingRef = useRef("");
	const sideThread = useSideThread(chatId, nativeMessages, () => {
		// Plugin editors own opaque answer/submission values. Only host Thinking
		// is safe helper context; read its live draft without introspecting the renderer.
		if (pendingPlugin) return pendingPlugin.showThinking ? pluginQuestionDraft(pendingPlugin).thinking : "";
		if (activeProblem?.pluginProblem) return pluginProblemDraft(activeProblem.pluginProblem).thinking;
		return workingRef.current;
	});
	const sideNavigation = useRef(0);
	const closeSideThread = useCallback(() => {
		const id = sideThread.state?.threadId;
		if (!id) return;
		const navigation = ++sideNavigation.current;
		void recording.finishFor(`side:${id}`).then(() => {
			if (navigation === sideNavigation.current) sideThread.close(id);
		});
	}, [recording.finishFor, sideThread.state?.threadId, sideThread.close]);
	const openSideThread = useCallback((args: SideThreadOpenArgs) => {
		const navigation = ++sideNavigation.current;
		const current = sideThread.state;
		const source = args.sourceMessageId ?? args.passage?.sourceMessageId ?? (args.questionCallId ? nativeMessages.find((message) => message.role === "assistant" &&
			message.content.some((block) => block.type === "toolCall" && block.id === args.questionCallId))?.id : undefined);
		if (current && current.segmentId !== sideSegmentId(nativeMessages, source) && recording.active && recording.destinationId === `side:${current.threadId}`) {
			void recording.finishFor(`side:${current.threadId}`).then(() => {
				if (navigation === sideNavigation.current) sideThread.open(args);
			});
		} else sideThread.open(args);
	}, [nativeMessages, recording.active, recording.destinationId, recording.finishFor, sideThread.open, sideThread.state]);
	const goToCurrentSideStep = sideThread.state && sideThread.currentSegmentId && sideThread.state.segmentId !== sideThread.currentSegmentId
		? () => openSideThread({ sourceMessageId: sideThread.currentSegmentId!, anchor: sideThread.state!.anchor }) : undefined;
	const sideDictationFor = (id: string) => {
		const destinationId = `side:${id}`;
		const owns = recording.destinationId === destinationId;
		return { phase: owns ? recording.phase : "idle" as const, active: owns && recording.active,
			blocked: !owns && recording.active, error: owns ? recording.error : null, levelRef: recording.levelRef,
			toggle: () => recording.toggleFor({ id: destinationId, append: (text) => sideThread.saveDraft(id, joinDictation(sideThread.draftFor(id), text), true) }),
			finish: () => recording.finishFor(destinationId) };
	};
	const renderSideEntry = (sourceMessageId?: string) => {
		if (!sourceMessageId) return null;
		const hasHistory = sideThread.threads.some((thread) => thread.anchor.messageId === sourceMessageId && thread.messages.length > 0);
		return <div className="mt-1 flex justify-end">
			<Button type="button" variant="ghost" size="icon-xs" data-testid="side-conversation-button" data-side-segment-id={sourceMessageId}
				data-has-history={hasHistory} aria-label={hasHistory ? "Open side conversation" : "Ask a side question"}
				title={hasHistory ? "Open side conversation" : "Ask a side question"}
				className={hasHistory ? "border border-border/60 text-muted-foreground" : "text-muted-foreground/40 hover:text-muted-foreground"}
				onClick={(event) => openSideThread({ sourceMessageId, anchor: { kind: "element", element: event.currentTarget } })}>
				<MessageCircleQuestionIcon aria-hidden className="size-3.5" fill="currentColor" fillOpacity={hasHistory ? 0.12 : 0} />
			</Button>
		</div>;
	};
	const sideThreadOpenRef = useRef(false);
	sideThreadOpenRef.current = sideThread.state !== null;
	const closeSideThreadRef = useRef(closeSideThread);
	closeSideThreadRef.current = closeSideThread;
	const toggleQuestionThread = useCallback(() => {
		if (!isInteractionScopeEligible(sessionFindScopeRef.current, controller)) return;
		if (sideThreadOpenRef.current) closeSideThreadRef.current();
		else openSideThread({ anchor: { kind: "composer" }, questionCallId: pendingRef.current?.toolCallId });
	}, [controller, openSideThread]);
	useEffect(() => {
		window.addEventListener(kbdEventForChat("toggle-question-thread"), toggleQuestionThread);
		return () => window.removeEventListener(kbdEventForChat("toggle-question-thread"), toggleQuestionThread);
	}, [toggleQuestionThread]);
	// Advancing the lesson does not close or disable an old conversation.
	const sideActions = useMemo(() => createSideQuestionActions({ open: openSideThread }), [openSideThread]);
	const selectionActions = useMemo(() => [citeAction, ...sideActions], [citeAction, sideActions]);
	const router = useRouter();
	const transcriptElementRef = useRef<HTMLElement | null>(null);
	transcriptElementRef.current = transcriptElement;
	const citationActions = useMemo<CitationActions>(() => ({
		editComment: (citation, source) => setCitationEdit({ citation, link: source.link, start: source.start, host: source.host, input: source.host.closest<HTMLElement>("[data-file-path-input]") ?? undefined }),
		openSource: (citation) => {
			const context = scrollContextRef.current;
			revealCitationSource({
				transcript: transcriptElementRef.current,
				scroll: context ? { scrollRef: context.scrollRef, stopScroll: context.stopScroll } : null,
				citation,
				currentChatId: chatId,
				navigate: (href) => router.push(href),
			});
		},
	}), [chatId, router]);
	useEffect(() => {
		if (dictation.active) {
			dictationWasActiveRef.current = true;
		} else if (dictationWasActiveRef.current) {
			dictationWasActiveRef.current = false;
			// Do not steal focus from a helper or a newer interaction owner.
			if (!document.activeElement?.closest('[data-testid="side-thread"]') && isInteractionScopeEligible(composerInputRef.current, controller)) composerInputRef.current!.focus();
		}
	}, [dictation.active, controller]);

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
	submissionLive.current.ready = !compacting && reconciliation === "ready";
	// A failed model response (issue #110): Retry keeps the saved input
	// and completed work, without another learner message. Offered from
	// "error" too: a dropped stream leaves the model there, and send()
	// recovers from it. Later compaction requires new input instead.
	const retryable = !pluginOwnsDock && (status === "ready" || status === "error") && !busy && !compacting && endsInFailedTurn(nativeMessages);
	const retryFailedTurn = () => retryFailedResponse(send, draftRef);
	const sendAllowed = !pluginOwnsDock && reconciliation === "ready" && !pending && !activeProblem && !compacting && !submissionRunner.occupied;
	const pendingTextTarget = textTarget();
	const pendingTextInput = !!pendingTextTarget && !!pluginManager?.hasPendingSubmissionInput(pendingTextTarget);
	const pendingThinkingTarget = thinkingTarget();
	const pendingThinkingInput = !!pendingThinkingTarget && !!pluginManager?.hasPendingSubmissionInput(pendingThinkingTarget);

	/* THE PRACTICE PAUSE (owner round 16): between problems — practice
	 * kind, nothing active, nothing in flight, and at least one problem
	 * has ever been posed (the fresh session's opening turn is owed, not
	 * the move-on). Enter-on-empty and the Next chip both key on it. */
	const nextReady =
		kind === "practice" &&
		!pending &&
		!pluginOwnsDock &&
		!activeProblem &&
		!compacting &&
		!busy &&
		nativeMessages.some(
			(m) => m.role === "assistant" && m.content.some(
					(b, contentIndex) => b.type === "toolCall" && !!practiceProblemForCall(nativeMessages, { messageId: m.id, contentIndex, toolCallId: b.id, toolName: b.name }),
				),
		);
	const sendNext = useCallback(() => {
		if (!nextReady || submissionRunner.occupied) return;
		if (pendingTextInput) { void prepareText(); return; }
		void send({ type: "next" });
	}, [nextReady, send, submissionRunner, pendingTextInput]);

	/* ENTER FROM ANYWHERE (owner round 16 refinement, 2026-10-06 —
	 * keyboard-first): the move-on must not require composer focus. The
	 * window-level Enter (typing surfaces and buttons excluded — a
	 * focused composer/button keeps its own lane, so no double fire)
	 * fires the signal from body focus, a scroll, anywhere. sendNext
	 * self-guards on nextReady, so the listener is inert outside the
	 * pause — the dock-mounted listeners are gone by then (docks unmount
	 * when nothing is active; the two never overlap). */
	useEnterSubmits(sendNext, sessionFindScopeRef);

	const syncFromServer = useCallback(async () => {
		const record = await readRecord().catch(() => undefined);
		if (!record) return;
		if (Array.isArray(record.turns)) setTurns(record.turns);
		setPricing(record.pricing);
		// The continuation seam (contracts.ts protocol §4): a job result
		// landing in the record leaves the agent owing a continuation — the
		// record ENDS on un-consumed results, the dock owns no question, and
		// nothing runs. The native fold (needsContinuation) is the old SDK
		// lastAssistantMessageIsCompleteWithToolCalls check.
		// Current model truth also guards retained/live failures: canonical
		// sync must never automatically replace a reply that failed to save.
		continueIfOwed(record.messages);
	}, [readRecord, continueIfOwed]);

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
			await readRecord({ adoption: "append" });
		} catch {
			/* transient — the idle full sync is the net */
		}
	}, [readRecord]);

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
	const [figureFocus, setFigureFocus] = useState<{ svg: string; inverted: boolean } | { image: SessionImage } | null>(null);

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
			const record = await readRecord({ adoption: "none" });
			if (!record) return;
			if (Array.isArray(record.turns)) setTurns(record.turns);
			setPricing(record.pricing);
		} catch {
			// transient blip: stats stay on the last known figures
		}
	}, [readRecord]);
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
				const record = await readRecord({ adoption: "none", isCurrent: () => !cancelled });
				if (!record) return;
				if (record.turnInFlight === true) setTurnInFlight(true);
				else void syncFromServer();
			} catch {
				/* transient — the banner stands; the next send's merge-retry heals */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [status, readRecord, syncFromServer]);

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
		if (!isInteractionScopeEligible(sessionFindScopeRef.current, controller) || submissionRunner.occupied) return;
		if (openingDraftRef.current !== null) { deliverOpeningPrompt(textRef.current.trim(), true); return; }
		void prepareText();
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

	const readViewInput = (): PluginSessionViewInput => {
		const expected = pendingPlugin?.occurrence ?? unreadablePlugin?.occurrence
			?? (pending ? { messageId: pending.messageId, contentIndex: pending.contentIndex, toolCallId: pending.toolCallId, toolName: pending.tool } : undefined) ?? activeProblemOccurrence;
		if (!expected && !unreadablePlugin) return textTarget()!;
		const current = inputViewReader.current?.();
		const occurrence = current?.type === "answer" || current?.type === "plugin-question-answer" ? current.question.occurrence
			: current?.type === "thinking" || current?.type === "plugin-problem-submission" ? current.problem.occurrence : current?.type === "unavailable" ? current.occurrence : undefined;
		if (current && current.type !== "text" && expected && occurrence && pluginQuestionOccurrenceKey(expected) === pluginQuestionOccurrenceKey(occurrence)) return current;
		return { type: "unavailable", ...(expected ? { occurrence: expected } : {}), expanded: false, revealed: false };
	};
	const actionContext = () => surfaceTarget ? createPluginSessionActionContext({ placement: "top-bar", surface: "session", sessionId: chatId, kind: kind === "practice" ? "practice" : "teaching", surfaceTarget }, () => {
		if (!submissionMounted.current || submissionLive.current.surfaceTarget !== surfaceTarget) throw new Error("This session view is no longer active.");
		return {
			sessionId: chatId, kind: kind === "practice" ? "practice" : "teaching", title: titleText,
			messages: nativeMessages, transcript: messages, status, reconciliation, busy, compacting,
			phase: kind === "practice" ? "practice" : phases.at(-1) ?? "probe", contextTokens,
			queuedSteers: visibleQueuedSteers(steerQueue, nativeMessages), composer: { text: textRef.current },
			input: readViewInput(),
		};
	}) : undefined;
	const renderedActionContext = actionContext();
	const captureActionContext = () => {
		if (!submissionMounted.current || !surfaceTarget || !findSurfaceBoundary(surfaceTarget)) return;
		const captured = actionContext();
		if (captured) void captured.view; // Detach once at invocation, not after plugin awaits.
		return captured;
	};

	usePluginShortcutPage(`/chat/${encodeURIComponent(chatId)}`, captureActionContext);

	return (
		<ChatActionsContext.Provider
			value={{
				chatId,
				syncFromServer,
				sendText: (t: string) => { void prepareText(t); },
				openSetup: () => setSetupOpen(true),
			}}
		>
		<SessionMermaidContext.Provider
			value={{
				openMermaid: setMermaidFocus,
				openFigure: (svg, inverted) => setFigureFocus({ svg, inverted }),
				openImage: image => setFigureFocus({ image }),
			}}
		>
		<JobsContext.Provider value={jobs}>
		<CitationActionsContext.Provider value={citationActions}>
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
									if (!isInteractionScopeEligible(e.currentTarget, controller)) return;
									if (e.key === "Enter") void commitRename(titleDraft);
									// stopPropagation claims the Esc (keyboard wave A):
									// closing rename must not also abort a turn.
									else if (e.key === "Escape") {
										controller?.claimEscape(e);
										e.stopPropagation();
										setRenaming(false);
									}
								}}
								onBlur={() => void commitRename(titleDraft)}
								spellCheck={false}
								data-plugin-chrome-title
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
							data-plugin-chrome-title
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
					{renderedActionContext && <PluginTopBarActions context={renderedActionContext} captureContext={captureActionContext} />}
				</TopBar>

				<SessionFind scopeRef={sessionFindScopeRef} scrollContextRef={scrollContextRef} />
				<div ref={sessionFindScopeRef} className="relative flex min-h-0 flex-1">
				<Conversation className="h-full min-w-0 flex-1" initial="instant" contextRef={scrollContextRef}>
					<SessionMessageNavigation />
					<TranscriptElementReporter onElement={setTranscriptElement} />
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
											case "data-plugin-problem-submission": {
												const submitted = readPluginProblemSubmission(part.data);
												return <PluginProblemSubmitted key={pi} data={part.data} snapshot={submitted ? pluginProblemById(nativeMessages, submitted.problemId) : null} chatId={chatId} />;
											}
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
													<PathText text={m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")} />
												</div>
												<SubmittedImages images={m.parts.filter((part) => part.type === "image").map(part => ({ type: "image" as const, data: part.data as string, mimeType: part.mimeType as string }))} />
											</div>
									) : (
									<Message from="assistant" className="max-w-full">
									<MessageContent className="w-full">
											{m.parts.map((part, pi) => {
												if (part.pluginProblem) return <ProblemCard key={pi} part={{ ...part, state: part.state ?? "input-available", toolCallId: part.toolCallId ?? "" }} />;
												if (part.pluginQuestion) return <PluginQuestionPart key={pi} part={part} chatId={chatId} />;
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
														return <Fragment key={`step-${pi}`}>
															{renderSideEntry(sideEntries.get(m.id)?.get(pi))}
															{teachBoundary ? <PhaseDivider phase="teach" /> : pi > 0 ? <Separator className="my-3" /> : null}
														</Fragment>;
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
														const malformed = !busy && malformedQuestions.find(call => call.messageId === part.sourceMessageId && call.contentIndex === part.sourceContentIndex && call.toolCallId === part.toolCallId);
														if (malformed) return <MalformedQuestion key={pi} disabled={!!pending || compacting}
															reason={pending ? "Answer or discard the remaining question first." : undefined}
															onRetry={() => {
																draftRef.current = null;
																void send({ type: "retry-question", messageId: malformed.messageId, contentIndex: malformed.contentIndex, toolCallId: malformed.toolCallId });
															}} />;
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
														// Built-in presentation stays authoritative; plugin renderers
														// extend only the generic native-tool fallback slot.
														if (part.type.startsWith("tool-")) return <ToolPartRenderer key={pi} part={part} />;
														return null;
													}
												}
											})}
										</MessageContent>
										{m.role === "assistant" && renderSideEntry(sideEntries.get(m.id)?.get(m.parts.length))}
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
							    provider-connect gap. Optional plugin grading/processing
							    uses EVALUATING… until its POST acknowledges; this changes
							    only the wording, never the action or stream gates.
							    turnInFlight: the same state
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
								<PendingTurnIndicator evaluating={evaluating} />
							)}
							{openingError && <p role="alert" className="text-sm text-destructive">{OPENING_PROMPT_FAILURE}</p>}
							{error && (
								<div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">
									<span>Something went wrong: {error.message}</span>
									{retryable && (
										<Button variant="outline" size="xs" data-testid="retry-failed-turn" onClick={retryFailedTurn}>
											Retry
										</Button>
									)}
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
					viewReader={inputViewReader}
					viewTargets={surfaceTarget ? { text: textTarget()!, answer: builtinTarget, thinking: thinkingTarget(), pluginQuestion: pluginQuestionTarget(), pluginProblem: pluginProblemTarget() } : undefined}
					pending={pending}
					onPrepareBuiltin={prepareBuiltin}
					onBuiltinPendingInput={question => { const target = builtinTarget(question); return !!target && !!pluginManager?.hasPendingSubmissionInput(target); }}
					onPrepareThinking={prepareThinking}
					pendingThinkingInput={pendingThinkingInput}
					onPreparePluginQuestion={preparePluginQuestion}
					preparing={submissionRunner.occupied}
					preparationStatus={<>
						{preparationError && <p role="alert" className="px-4 py-2 text-sm text-destructive">{preparationError}</p>}
					</>}
					pluginQuestion={pendingPlugin}
					pluginDraft={pendingPlugin ? pluginQuestionDraft(pendingPlugin) : undefined}
					pluginAvailable={!!pendingPlugin && pluginQuestionAvailability?.questionId === pendingPlugin.questionId && pluginQuestionAvailability.status === "available"}
					pluginReady={!busy && !compacting && reconciliation === "ready"}
					onPluginMicAvailable={setPluginMicAvailable}
					onPluginSend={send}
					onPluginDismiss={() => pendingPlugin ? dismissPluginQuestion(pendingPlugin.occurrence, pendingPlugin.questionId) : unreadablePlugin ? dismissPluginQuestion(unreadablePlugin.occurrence, unreadablePlugin.annotation.status === "unreadable" ? unreadablePlugin.annotation.identity?.questionId : undefined) : Promise.resolve()}
					unreadablePlugin={!!unreadablePlugin}
					unavailableOccurrence={unreadablePlugin?.occurrence}
					reconciliation={reconciliation}
					onRetrySync={() => { void reconcile(); }}
					initialQuestionDraft={pending ? questionDraft(pending.key)?.form : undefined}
					onSaveQuestionDraft={(form) => { if (pending) saveQuestionDraft(pending.key, { form }); }}
					workingRef={workingRef}
					practice={activeProblem}
					pluginPractice={activeProblem?.pluginProblem && activeProblemOccurrence ? {
						snapshot: activeProblem.pluginProblem, occurrence: activeProblemOccurrence, chatId, draft: pluginProblemDraft(activeProblem.pluginProblem),
						available: pluginProblemAvailability?.problemId === activeProblem.pluginProblem.problemId && pluginProblemAvailability.status === "available",
						ready: !busy && !compacting && reconciliation === "ready", reconciliation: activeProblemOf(canonicalMessages)?.pluginProblem?.problemId === activeProblem.pluginProblem.problemId ? reconciliation : "syncing",
						prepareSubmission: preparePluginProblem, send, preparing: submissionRunner.occupied, compactionRunning: compacting, onEscape: dictation.cancel,
					} : undefined}
					compactionRunning={compacting}
					onSubmitThinking={submitThinking}
					chatId={chatId}
					onModelChange={recordSelectedModel}
					plan={hasPlan ? <PlanMarginalia messages={messages} /> : undefined}
					onOpenPlan={() => setPlanOpen(true)}
					requiresReveal={requiresReveal}
					readingThinking={readingThinkingSeed.value}
					readingThinkingRevision={readingThinkingSeed.revision}
					onReadingThinking={(value) => { applyReadingThinking(value); if (pendingPlugin) pluginQuestionDraft(pendingPlugin).readingThinking = value; }}
					phase={phases.at(-1) ?? "probe"}
					turns={turns}
					contextTokens={contextTokens}
					cliContextWindow={cliContextWindowOf(nativeMessages)}
					pricing={pricing}
					onReserve={setDockReserve}
					dictationSlot={<DictationBar dictation={dictation} disabled={pluginOwnsDock && !pluginMicAvailable} />}
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
						<ChatSessionComposer
							// Stop aborts ANY in-flight turn (stream-reattach wave): the
							// square renders while a reattached/wake turn runs too — the
							// abort channel kills it server-side; stop() alone would
							// only detach our view.
							busy={busy}
							value={textRef.current}
							pendingInput={pendingTextInput}
							revision={composerDraftRevision}
							onChange={recordComposerText}
							inputRef={composerInputRef}
							onSend={onSend}
							onStop={abortInFlightTurn}
							sendAllowed={sendAllowed}
							dictationActive={dictation.active}
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
						saveQuestionDraft(pending.key, { readingThinking: readingThinkingRef.current });
						const reading = readingThinkingRef.current.trim() || undefined;
						// The pending-id effect clears this only when the question
						// actually leaves. An offline preflight keeps the draft visible.
						const send = () => submitAnswer(pending.tool, pending.toolCallId, reading ? { ...output, readingThinking: reading } : output, pending.key);
						// Never wait for the helper. The server atomically appends new
						// raw side updates with this main answer.
						send();
					}}
				/>
				</Conversation>
				{sideThread.state?.mode === "panel" && (
					<SideThreadPanel>
						<SideThreadBody
							key={sideThread.state.threadId}
							state={sideThread.state}
							chatId={chatId}
							draft={sideThread.draftFor(sideThread.state.threadId)}
							readDraft={sideThread.draftFor.bind(null, sideThread.state.threadId)}
							dictation={sideDictationFor(sideThread.state.threadId)}
							onDraftChange={sideThread.saveDraft.bind(null, sideThread.state.threadId)}
							onAsk={(text, retry) => sideThread.ask(text, retry, sideThread.state!.threadId)}
							onStop={sideThread.stop}
							onExpand={sideThread.expand}
							onFloat={sideThread.float}
							onClose={closeSideThread}
							onCurrentStep={goToCurrentSideStep}
						/>
					</SideThreadPanel>
				)}

				{sideThread.state?.mode === "popover" && (
					<SideThreadPopover
						state={sideThread.state}
						chatId={chatId}
						draft={sideThread.draftFor(sideThread.state.threadId)}
						readDraft={sideThread.draftFor.bind(null, sideThread.state.threadId)}
						dictation={sideDictationFor(sideThread.state.threadId)}
						onDraftChange={sideThread.saveDraft.bind(null, sideThread.state.threadId)}
						composer={() => composerInputRef.current}
						onAsk={(text, retry) => sideThread.ask(text, retry, sideThread.state!.threadId)}
						onStop={sideThread.stop}
						onExpand={sideThread.expand}
						onFloat={sideThread.float}
						onClose={closeSideThread}
						onCurrentStep={goToCurrentSideStep}
					/>
				)}

				{/* The session-scoped focuses (chrome-melt wave, 2026-09-19): mounted
				    INSIDE the session area — absolute inset-0 siblings of the scroller,
				    so they own the area below the drag bar, right of the sidebar, and
				    the top bar stays sharp + draggable while a focus is open. */}
				<SurfaceRegion target={surfaceTarget}>
				{mermaidFocus !== null && (
					<MermaidOverlay chart={mermaidFocus} onClose={() => setMermaidFocus(null)} />
				)}
				{figureFocus !== null && (
					<MermaidOverlay
						{...figureFocus}
						onClose={() => setFigureFocus(null)}
					/>
				)}
				{planOpen && <PlanPopup messages={messages} onClose={() => setPlanOpen(false)} />}
				<SelectionToolbar viewport={transcriptElement} actions={selectionActions} />
				{citationEdit && (
					<CitationCommentPopover
						key={`${citationEdit.start}:${citationEdit.link}`}
						target={citationEdit}
						transcript={transcriptElement}
						composer={() => citationEdit.input?.isConnected ? citationEdit.input : citeInput()}
						onClose={() => setCitationEdit(null)}
						onSend={() => {
							const input = citationEdit.input?.isConnected ? citationEdit.input : citeInput();
							if (input === composerInputRef.current) onSend();
							else if (input) requestAnimationFrame(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
						}}
					/>
				)}
				</SurfaceRegion>
				<AbortTurnDialog mode={abortAsk} onClose={closeAbortAsk} onConfirm={confirmAbort} busy={busy} />
				</div>
			</div>
		</div>
		</CitationActionsContext.Provider>
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
export type EscAbortTarget = "side-thread" | "mermaid" | "plan" | "setup" | "question" | "problem" | "turn" | null;
	/**
 * Does the opening topic still owe its first send? The topic is the
 * server's ?prompt= or the sessionStorage stash. The gate is "no real
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
	/** An open side thread (#16, F11): Esc closes (and commits) it before
	 *  anything else on the ladder. */
	sideThread?: boolean;
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
	if (s.sideThread) return "side-thread";
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

/** Reports the transcript's scroll element once StickToBottom attaches it
 *  (its ref lands after first render, like SessionMessageNavigation's). */
function TranscriptElementReporter({ onElement }: { onElement: (element: HTMLElement | null) => void }) {
	const { scrollRef } = useStickToBottomContext();
	useEffect(() => {
		if (scrollRef.current) { onElement(scrollRef.current); return () => onElement(null); }
		const id = window.setInterval(() => {
			if (!scrollRef.current) return;
			window.clearInterval(id);
			onElement(scrollRef.current);
		}, 50);
		return () => { window.clearInterval(id); onElement(null); };
	}, [scrollRef, onElement]);
	return null;
}

/** Host-only composition/test seam; never part of the plugin SDK. */
export function DockOverlay({
	viewReader, viewTargets, unavailableOccurrence,
	pending,
	onPrepareBuiltin, onBuiltinPendingInput, onPrepareThinking, pendingThinkingInput, onPreparePluginQuestion, preparing, preparationStatus,
	pluginQuestion, pluginDraft, pluginAvailable, pluginReady, onPluginMicAvailable, onPluginSend, onPluginDismiss, unreadablePlugin, reconciliation, onRetrySync,
	initialQuestionDraft,
	onSaveQuestionDraft,
	workingRef,
	practice, pluginPractice,
	compactionRunning,
	onSubmitThinking,
	requiresReveal,
	readingThinking,
	readingThinkingRevision,
	onReadingThinking,
	phase,
	turns,
	contextTokens,
	cliContextWindow,
	pricing,
	composer,
	onSubmitAnswer,
	chatId,
	onModelChange,
	onReserve,
	plan,
	onOpenPlan,
	dictationSlot,
	dictationCancel,
	setupCta,
	queuedSteers,
}: {
	viewReader?: SessionInputViewReader;
	viewTargets?: SessionViewTargets;
	unavailableOccurrence?: import("@/src/core").PluginSubmissionOccurrence;
	pending: ReturnType<typeof pendingQuestionOf>;
	onPrepareBuiltin: PrepareBuiltinSubmission;
	onBuiltinPendingInput: (question: QuestionData) => boolean;
	onPrepareThinking: PrepareThinkingSubmission;
	pendingThinkingInput: boolean;
	onPreparePluginQuestion: PreparePluginQuestionSubmission;
	preparing: boolean;
	preparationStatus: React.ReactNode;
	pluginQuestion?: PluginQuestionSnapshot;
	pluginDraft?: PluginQuestionDraft;
	pluginAvailable: boolean;
	pluginReady: boolean;
	onPluginMicAvailable(available: boolean): void;
	onPluginSend(input: ChatInput): Promise<boolean>;
	onPluginDismiss(): Promise<void>;
	unreadablePlugin: boolean;
	reconciliation: "ready" | "syncing" | "failed";
	onRetrySync(): void;
	initialQuestionDraft?: QuestionFormDraft;
	onSaveQuestionDraft: (draft: QuestionFormDraft) => void;
	/** The dock's current unsubmitted working, for the side thread. */
	workingRef?: { current: string };
	/** Compaction running for this chat (round 14) — the docks' submit
	 *  affordance gate (the server's registry is the real one). */
	compactionRunning: boolean;
	/** The ACTIVE practice problem (practice sessions, 2026-10-04):
	 *  {toolCallId, input} — dock ownership exactly like a pending
	 *  question (the composer is replaced); null in teaching sessions. */
	practice: { toolCallId: string; input: unknown } | null;
	pluginPractice?: Omit<PluginProblemDockProps, "expanded" | "onExpand">;
	/** (commit, text) — the practice dock's two submit lanes. */
	onSubmitThinking: (text: string) => void;
	/** Teach-phase pending question: arrives collapsed behind the reveal button (W5). */
	requiresReveal: boolean;
	/** The reading-thinking draft (owner 2026-10-03) — owned by ChatView so
	 *  the submit + dismissal seams (outside this overlay) can merge it. */
	readingThinking: string;
	readingThinkingRevision: number;
	onReadingThinking: (v: string) => void;
	/** Session phase at the pending question — scales the thinking field. */
	phase: Phase3;
	/** The session's usage log — the stats bar beneath the composer folds it. */
	turns: TurnUsage[];
	contextTokens: number | null;
	cliContextWindow: ReturnType<typeof cliContextWindowOf>;
	pricing?: SessionPricing;
	composer: React.ReactNode;
	onSubmitAnswer: (output: QuestionAnswerData) => void;
	/** The model control's pass-through (the stats bar hosts it). */
	chatId: string;
	onModelChange: (model: string | undefined) => void;
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
	const controller = useOptionalInteractionLayers();
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

	const pendingId = pluginQuestion ? pluginQuestionOccurrenceKey(pluginQuestion.occurrence) : unreadablePlugin ? "unreadable-plugin-question" : pending?.key ?? null;
	const readingInputRef = useRef<HTMLDivElement>(null);
	const ownsDock = !!pending || !!pluginQuestion || unreadablePlugin || !!practice;
	const initialPendingRef = useRef(pendingId);
	const nativeViewReader = useRef<(() => NativeQuestionViewState) | null>(null) as ViewReaderRef<NativeQuestionViewState>;
	const practiceViewReader = useRef<(() => string) | null>(null) as ViewReaderRef<string>;
	const customViewReader = useRef<(() => { available: boolean }) | null>(null) as ViewReaderRef<{ available: boolean }>;
	nativeViewReader.changed = practiceViewReader.changed = customViewReader.changed = viewReader?.changed;

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
	const pendingRef = useRef(ownsDock);
	pendingRef.current = ownsDock;
	const requiresRevealRef = useRef(requiresReveal);
	requiresRevealRef.current = requiresReveal;
	const revealedRef = useRef(revealed);
	revealedRef.current = revealed;

	const blockRef = useRef<HTMLDivElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const shellRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const mode = pluginQuestion ? `plugin-question:${pendingId}` : unreadablePlugin ? "unreadable-plugin-question" : pending
		? `question:${pending.key}`
		: practice
			? `practice:${pluginPractice?.snapshot.problemId ?? practice.toolCallId}`
			: "chat";

	useLayoutEffect(() => {
		if (!viewReader || !viewTargets) return;
		const read = (): PluginSessionViewInput => {
			if (pluginQuestion && pluginDraft && viewTargets.pluginQuestion) return { ...viewTargets.pluginQuestion, input: pluginQuestion.input, expanded, revealed: !revealPending,
				available: customViewReader.current?.().available ?? false, draft: pluginDraft };
			if (unreadablePlugin) return { type: "unavailable", ...(unavailableOccurrence ? { occurrence: unavailableOccurrence } : {}), expanded, revealed: !revealPending };
			if (pending) {
				const state = nativeViewReader.current?.();
				const target = state && state.question.id === pending.toolCallId ? viewTargets.answer(state.question) : undefined;
				return target && state ? { ...target, expanded, revealed: !revealPending, available: true, draft: { ...state.draft, readingThinking } }
					: { type: "unavailable", occurrence: { messageId: pending.messageId, contentIndex: pending.contentIndex, toolCallId: pending.toolCallId, toolName: pending.tool }, expanded, revealed: !revealPending };
			}
			if (pluginPractice && viewTargets.pluginProblem) return { ...viewTargets.pluginProblem, input: pluginPractice.snapshot.input, expanded,
				available: customViewReader.current?.().available ?? false, draft: pluginPractice.draft };
			if (practice && viewTargets.thinking) return { ...viewTargets.thinking, expanded, draft: { thinking: practiceViewReader.current?.() ?? "" } };
			return viewTargets.text;
		};
		viewReader.current = read;
		return () => { if (viewReader.current === read) viewReader.current = null; };
	});
	const unavailableViewKey = unavailableOccurrence ? pluginQuestionOccurrenceKey(unavailableOccurrence) : "";
	useLayoutEffect(() => { viewReader?.changed?.(); }, [viewReader, mode, expanded, revealPending, readingThinking, unavailableViewKey]);

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

	// The reserve grows immediately, but never shrinks while a question or
	// practice problem owns the dock: shrinking flow space could pin a nearby
	// learner back to the bottom. Composer mode may give space back.
	const reserveRef = useRef(0);
	const offer = useCallback((blockH: number) => {
		const next = blockH + GRADIENT_H;
		if (next <= reserveRef.current + 0.5 && pendingRef.current) return;
		// Stamp growth at the source, including child-only field resizes, so
		// stick-to-bottom's catch-up is not mistaken for the learner leaving.
		if (shouldStampGeometryMute(next, reserveRef.current, pendingRef.current)) geometryAtRef.current = Date.now();
		reserveRef.current = next;
		onReserve(next);
	}, [onReserve]);

	// The overlay must not paint over the scroller's scrollbar (owner, scroll
	// round 2): the scroller reserves symmetric gutters (scrollbar-gutter:
	// stable both-edges), so inset the overlay's right edge by the gutter —
	// zero on macOS overlay scrollbars, the real width on classic platforms.
	// Budget the whole solid dock, leaving only its question area flexible.
	// The hook measures natural, visible content before the morph/reserve
	// effect below. Short windows scroll the reading/question/answer body;
	// the stats/model toolbar remains outside that overflow viewport.
	const [sbInset, setSbInset] = useState(0);
	const stateKey = dockStateKey(mode, ownsDock, expanded);
	const heightMorphRef = useRef<ReturnType<typeof createDockMorph> | null>(null);
	if (!heightMorphRef.current) heightMorphRef.current = createDockMorph();
	const retargetOpening = useCallback(() => heightMorphRef.current?.retarget(stateKey), [stateKey]);
	useIsoLayoutEffect(() => () => heightMorphRef.current?.dispose(), []);
	useDockHeight({
		scrollRef, blockRef, viewportRef, bodyRef, shellRef, contentRef,
		expanded, enabled: ownsDock, mode, onScrollbarInset: setSbInset, onHeight: offer,
		onLayout: retargetOpening,
	});

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
		const onWheel = (e: WheelEvent) => forwardDockWheel(e, root, el);
		root.addEventListener("wheel", onWheel, { passive: false });
		return () => root.removeEventListener("wheel", onWheel);
	}, [scrollRef]);

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
		if ((!pending && !pluginQuestion && !unreadablePlugin) || expanded) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Enter" || e.altKey || e.defaultPrevented || pluginQuestionKeySuppressed(e) || composingQuestionKey(e) || !isInteractionScopeEligible(blockRef.current, controller)) return;
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
	}, [pending, pluginQuestion, unreadablePlugin, expanded, controller]);

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

	// The opening variant of a session appears instantly — the fade/rise is
	// reserved for mid-session transitions.
	const initialModeRef = useRef(mode);

	// Height morph: animate the shell from its previous height to its new one
	// whenever the variant (chat ↔ question ↔ collapsed bar) changes. Typing
	// growth keeps the same stateKey and is NOT animated.
	// The fold's CONTENT fade (owner round, 2026-10-05): the shell height
	// morphs, but the bar↔form content used to hard-swap. A WAAPI fade/rise
	// on the toggle — no remount, so the question form's state survives.
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
	useIsoLayoutEffect(() => {
		const el = shellRef.current;
		if (!el) return;
		// The private controller owns only this shell's height animation. Late
		// child layout can retarget an opening over its remaining original time;
		// closing and ordinary typing retain their existing behavior.
		heightMorphRef.current?.layout(el, stateKey, ownsDock && expanded, measureBlock);
	});

	return (
		<div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ right: sbInset }}>
			<div className="h-24 bg-gradient-to-t from-background via-background/85 to-transparent" />
			<div ref={blockRef} className="relative bg-background pb-5">
				<div className={DOCK}>
					<div ref={viewportRef} data-dock-viewport="" className="pointer-events-auto">
					<div ref={bodyRef}>
					{setupCta}
					{reconciliation === "failed" && <div role="alert" className="mb-2 rounded-2xl border bg-card px-4 py-3 text-sm">Could not sync the saved session. <Button type="button" variant="ghost" onClick={onRetrySync}>Retry syncing</Button></div>}
					{/* The queued-steer indicator (owner spec 2026-10-03): quiet
					    one-liners above the shell - right-aligned to where its corner
					    rounding starts, truncated, no background, no container. A
					    line dies when its card lands (visibleQueuedSteers). */}
					<QueuedSteersBody steers={queuedSteers} />
					{/* The reading-thinking field (owner 2026-10-03): mounted while a
					    teach-phase check waits — the same cue that collapses it. It
					    claims dictated speech until the learner reveals the check
					    (the dock reclaims then). Rides the check answer on submit. */}
					{(pending || pluginQuestion) && requiresReveal && (
						<ReadingThinkingField
							inputRef={readingInputRef}
							value={readingThinking}
							revision={readingThinkingRevision}
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
					<div ref={shellRef} data-attachment-composer="" className="pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg">
						{preparationStatus}
						{/* Include descendant margins (notably practice thinking's
						    bottom margin) in the natural content measurement. */}
						<div
							ref={contentRef}
							key={mode}
							className={mode === initialModeRef.current ? "flow-root" : "flow-root dock-variant"}
						>
							{pluginQuestion && pluginDraft ? (
								<PluginQuestionDock viewReader={customViewReader} snapshot={pluginQuestion} chatId={chatId} draft={pluginDraft} expanded={expanded} reveal={revealPending} onExpand={expandAndReveal} ready={pluginReady} available={pluginAvailable} reconciliation={reconciliation} readingRef={readingInputRef} onMicAvailable={onPluginMicAvailable} send={onPluginSend} dismiss={onPluginDismiss} prepareSubmission={onPreparePluginQuestion} />
							) : unreadablePlugin ? (
								<div className="px-4 py-3">
									{reconciliation === "syncing" && <p role="status" className="text-sm text-muted-foreground">Preparing question…</p>}
									{reconciliation === "ready" && <><p role="status" className="text-sm text-muted-foreground">Question unavailable</p><Button type="button" variant="ghost" disabled={!pluginReady} onClick={() => { void finishDictation().then(onPluginDismiss); }}>Dismiss question</Button></>}
								</div>
							) : pending ? (
								<QuestionDock
									viewReader={nativeViewReader}
									toolName={pending.tool as "quiz" | "probe" | "ask_user_question" | "explain" | "recall"}
									toolCallId={pending.toolCallId}
									input={pending.input as never}
									expanded={expanded}
									reveal={revealPending}
									phase={phase}
									onExpand={expandAndReveal}
									onSubmit={onSubmitAnswer}
									onPrepareSubmission={onPrepareBuiltin}
									hasPendingInput={onBuiltinPendingInput}
									preparing={preparing}
									initialDraft={initialQuestionDraft}
									onSaveDraft={onSaveQuestionDraft}
									workingRef={workingRef}
									onEscape={dictationCancel}
									dictationClaim={!revealPending}
									compactionRunning={compactionRunning}
								/>
							) : pluginPractice ? (
								<PluginProblemDock {...pluginPractice} viewReader={customViewReader} expanded={expanded} onExpand={() => { setExpanded(true); void suppressFoldDuringReveal(); }} />
							) : practice ? (
								<PracticeDock
									viewReader={practiceViewReader}
									problemCallId={practice.toolCallId}
									input={practice.input as { statement: string }}
									expanded={expanded}
									onExpand={() => {
										setExpanded(true);
										void suppressFoldDuringReveal();
									}}
									onSubmit={onSubmitThinking}
									onPrepareSubmission={onPrepareThinking}
									hasPendingInput={pendingThinkingInput}
									preparing={preparing}
									onEscape={dictationCancel}
									compactionRunning={compactionRunning}
								/>
							) : (
								composer
							)}
						</div>
					</div>
					</div>
					</div>
					{/* The stats row: beneath the composer/question shell, not
					    flush to the screen bottom — static height, outside the
					    morphing shell so it never joins a height animation. */}
					<StatsBar
						turns={turns}
						contextTokens={contextTokens}
						cliContextWindow={cliContextWindow}
						pricing={pricing}
						dictationSlot={dictationSlot}
						chatId={chatId}
						onModelChange={onModelChange}
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
				{(pending || pluginQuestion) && plan && (
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
