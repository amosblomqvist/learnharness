import type { Usage } from "@earendil-works/pi-ai";
import {
	createPracticeAgent,
	createProberAgent,
	createTeacherAgent,
	type AgentBuildOptions,
	type TeachingAgent,
} from "../agent/teacher-agent.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { connectionBackgroundAllowed as subscriptionBackgroundAllowed, connectionScopeCurrent, isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { nativeSubscriptionError } from "../agent/subscription-stream.ts";
import { chatGPTStreamError } from "../agent/chatgpt-stream.ts";
import { SubscriptionRequestCycle, type SubscriptionDispatchLifecycle } from "../agent/subscription-request-cycle.ts";
import { reconstructRequestCause } from "../core/native-messages.ts";
import { createJobRunner } from "../agent/subagents/runner.ts";
import { createExtractionPipeline } from "../agent/subagents/extraction.ts";
import type { ModelRole } from "../../config.ts";
import {
	deliverJobResult,
	noteSteersDurable,
	reconcileUserSteers,
	registerLiveAgent,
	restoreUncommittedAutomatic,
	setJobRespawn,
	setTurnRunner,
	settleSteers,
	steerLiveChat,
	unregisterLiveAgent,
} from "./jobs.ts";
import { runPiTurn } from "./pi/ui-stream.ts";
import { setFileAccessPolicy } from "../agent/tools/file-access.ts";
import { fileAccessPolicy } from "./file-access.ts";
import { collectToolCallIds } from "./pi/call-ids.ts";
import { providerEventNote } from "../agent/provider-events.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { getPluginAgentContributions, getPluginHost } from "./plugins.ts";
import { preparePluginQuestionSubmission, reconcilePluginQuestionCompatibility, type QuestionTypeResolver } from "./plugin-questions.ts";
import { searchAvailable, searchProvider } from "./search.ts";
import { prepareSubmissionImages, prepareSubmissionImageChannels, prepareProblemSubmissionImageChannels, submissionImagePolicyKey } from "./submission-images.ts";
import { preparePluginProblemSubmission, requirePluginProblemTarget, type ProblemTypeResolver } from "./plugin-problems.ts";
import { providerKeyPresent } from "./keys.ts";
import { CLAUDE_CODE_PROVIDER } from "../core/contracts/claude-code.ts";
import {
	extractionEnabled,
	graphToolsEnabled,
	resolveConversationSpec,
	resolveRoleSpec,
} from "../core/settings-resolution.ts";
import { modelsNotConfigured, providerKeyMissing as providerKeyMissingEnvelope, ROLE_SLOT, type ModelSlotName, type ProviderKeyMissing } from "../core/settings.ts";
import { beginTurn, endTurn, isTurnRunning } from "./turn-liveness.ts";
import { claimPreparingTurn, type TurnPreparation } from "./turn-preparation.ts";
import { applyParkedDismissal } from "./dismissal-park.ts";
import { sideConversationEntries } from "../core/side-chat.ts";
import { sideChats, type SideChatService } from "./side-chat.ts";
import { SIDE_CONTEXT_BUDGET_ERROR, sideBudgetRetryDrops, sideContextWindow } from "./side-context-budget.ts";
import { registerTurn, rememberTurnFailure, unregisterTurn } from "./turn-runs.ts";
import { persistTurn, triggerExtraction, TurnPersistenceError } from "./turn-service.ts";
import { hasProbeDone, hasUnresolvedQuestion, pendingPluginQuestionOf, pluginQuestionCallsOf, questionCallsOf } from "../core/native-messages.ts";
import { samePluginQuestionOccurrence } from "../core/plugin-questions.ts";
import { composeInstructions } from "../agent/teacher-agent.ts";
import { ensureCompacted, kickCompaction, effectiveThresholdTokens, projectedContextTokens, compactionInFlight } from "./compaction.ts";
import { COMPACTION_RESERVE_TOKENS } from "../core/compaction.ts";
import { catalogContextLimits, refreshConnectionCatalog } from "./model-catalog.ts";
import { emit } from "../core/events.ts";
import { settledTurnResponse } from "./turn-runs.ts";
import { asAgentMessages, type LhMessage } from "../core/native-messages.ts";
import { QUESTION_TOOLS } from "../core/pending.ts";
import {
	ChatInputError,
	assertPluginQuestionInputAllowed,
	assertNativeSubmissionTarget,
	inputAppends,
	parseChatInput,
	questionRecoveryAppends,
	retryDrops,
	type TurnInput,
} from "../core/input-events.ts";
import { steerDelivered } from "../core/contracts.ts";
import type {CallUsage} from "../core/contracts.ts";

/**
 * One chat turn over the server-owned native record. Framework-free (plain
 * Request/Response) so tests can drive it directly with a scripted faux
 * engine — the Next route handler in app/api/chat is a one-line wrapper.
 *
 * THE INPUT-EVENTS CONTRACT (Wave B, owner ruling 2026-09-26): POST /api/chat
 * carries {chatId, input} — one explicit event (text / answer / verdict /
 * continue), never a client transcript. The server owns the record; this
 * module is the TURN COMPOSITION ROOT: it turns the event into native
 * record appends (core/input-events.ts), builds the agent from the record
 * (the record IS the agent state — state.messages = record.messages,
 * continue()), and runs the turn as a background object (pi/ui-stream.ts).
 * Wake-pipeline steers ride the same composition (TurnInput's steer kind).
 *
 * THE SAME COMPOSITION serves both entry points: client requests and the
 * wake pipeline's server-side steers (src/server/jobs.ts) — one code path
 * for write-ahead persistence, turn liveness, and the turn services.
 */

/** Fresh check only at new background-run admission; never cancel a run
 * already in progress when the opt-in is switched off. */
function connectionBackgroundAllowed(provider: string): boolean {
	return subscriptionBackgroundAllowed(provider) && (![CLAUDE_CODE_PROVIDER, "codex"].includes(provider) || providerKeyPresent(provider));
}

function settlementErrorText(error: unknown): string {
	return error instanceof TurnPersistenceError ? error.message : "An error occurred.";
}

const jobRunner = createJobRunner({
	chatStore: stores.chatStore,
	jobStore: stores.jobStore,
	deliver: deliverJobResult,
	// BYOK (owner, 2026-09-22): job engines resolve the chain — role
	// override → slot → NOTHING — read FRESH per job (a settings PUT
	// between dispatch and spawn lands); an empty chain flows through as
	// undefined and the runner refuses the spawn honestly.
	engineFor: (role) =>
		resolveEngine(role),
	// Key-presence gate (provider-key interlude, 2026-09-25): the runner
	// reads the resolved engine's provider and asks THIS check (the agent
	// layer may not read the key store); a missing key refuses the spawn
	// with the 503-envelope family instead of dying mid-run.
	providerKeyMissing: (provider, tier) =>
		providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
	// Search port wave (2026-09-20): the researcher's web_search runs on the
	// injected port — resolved FRESH per job (key rotations land immediately).
	// null = honestly unavailable; the dispatch-level drop (below) uses the
	// same signal so keyless servers never see the research tool at all.
	searchProvider,
});
/** The app's ONE extraction pipeline instance — both front doors share it:
 *  quiz-triggered session runs (turn-service) and notes imports
 *  (/api/graph/import) hit the same single-flight registry. */
export const extraction = createExtractionPipeline({
	...stores,
	// BYOK (owner, 2026-09-22): the extraction stages resolve the chain —
	// role override → slot → NOTHING — read FRESH per stage call; an empty
	// chain flows through as undefined and the pipeline refuses the run
	// with the typed ModelsNotConfiguredError. Direct test values still win.
	engineFor: (role) =>
		resolveEngine(role),
	// Key-presence gate (provider-key interlude, 2026-09-25): same check
	// the job runner gets — a stage engine whose provider key is gone
	// refuses BEFORE any batch runs (the typed throw), never mid-run.
	providerKeyMissing: (provider, tier) =>
		providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
});


// Wake-pipeline wiring (contracts.ts "THE ASYNC PROTOCOL" §4): the pipeline
// delivers its steers through THIS composition root (one event: the steer
// marker, appended natively under the turn claim), and crash recovery
// re-spawns orphaned sub-agent loops through THIS runner.
setTurnRunner(async (chatId, input) => {
	const res = await handleChatInput(chatId, input);
	// Drive the stream to completion server-side — nobody else will read it,
	// and onFinish (persist, extraction, endTurn) only runs when it drains.
	await res.arrayBuffer().catch(() => undefined);
	return res.status;
});
/** The settings-resolved engine for one role — BYOK (owner, 2026-09-22):
 *  the chain (role override → slot → NOTHING) may end empty, and undefined
 *  flows through to the per-need refusal gates (runner/extraction), read
 *  FRESH so a settings PUT between dispatch and spawn lands. */
function resolveEngine(role: ModelRole): PiEngine | undefined {
	const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
	return spec ? piEngineForSpec(spec, true, undefined, retentionForSlot(ROLE_SLOT[role])) : undefined;
}

/** Slot policy is independent of model overrides. Read fresh per operation,
 * including parked conversations, background loops and compaction. */
function retentionForSlot(slot: ModelSlotName) {
	return () => stores.settingsStore.readSettings()?.models?.[slot]?.cacheRetention;
}

setJobRespawn((jobId) => void jobRunner.runJob(jobId));
// The learner-filesystem policy (file-access wave): every tool registry is
// built in this composition root, so the seam is installed here — the
// tools read it fresh per call (allowed folders + the app's private paths).
setFileAccessPolicy(fileAccessPolicy);

/** The route-facing entry: parse {chatId, input} and run one turn. */
export async function handleChatRequest(
	req: Request,
	buildAgent?: (opts: AgentBuildOptions & { teaching: boolean }) => TeachingAgent,
	sideContext: Pick<SideChatService, "snapshot"> = sideChats,
): Promise<Response> {
	let body: { chatId?: unknown; input?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const chatId = typeof body.chatId === "string" ? body.chatId : "";
	if (!chatId) return Response.json({ error: "Unknown chat" }, { status: 404 });
	let input: TurnInput;
	try {
		input = parseChatInput(body.input);
	} catch (err) {
		if (err instanceof ChatInputError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}
	return handleChatInput(chatId, input, buildAgent, sideContext);
}

/**
 * The turn composition: one input event → native record appends → one
 * agent turn as a background object. Also the wake pipeline's entry
 * (TurnInput's steer kind appends the marker under the same claim).
 */
export async function handleChatInput(
	chatId: string,
	input: TurnInput,
	buildAgent?: (opts: AgentBuildOptions & { teaching: boolean }) => TeachingAgent,
	sideContext: Pick<SideChatService, "snapshot"> = sideChats,
): Promise<Response> {
	await reconcilePluginQuestionCompatibility(stores.chatStore, chatId);
	const initialRecord = stores.chatStore.getChat(chatId);
	if (!initialRecord) {
		return Response.json({ error: "Unknown chat" }, { status: 404 });
	}
	let record = initialRecord;

	const capturedSession = { createdAt: record.createdAt, kind: record.kind };
	const freshSubmission = input.type === "text" || input.type === "thinking" || input.type === "answer" || input.type === "plugin-question-answer" || input.type === "plugin-problem-submission";
	try {
		assertPluginQuestionInputAllowed(record.messages, input);
		if (input.type !== "steers") assertNativeSubmissionTarget(record.messages, input);
		if (input.type === "plugin-problem-submission") requirePluginProblemTarget(record, input);
		if (input.type === "plugin-question-answer") {
			const pending = pendingPluginQuestionOf(record.messages);
			if (!pending || pending.questionId !== input.questionId || !samePluginQuestionOccurrence(pending.occurrence, input.occurrence))
				throw new ChatInputError("This question is no longer pending. Sync the saved session before trying again.");
		}
	}
	catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	if ((input.type === "plugin-question-answer" || input.type === "plugin-problem-submission") && isTurnRunning(chatId))
		return Response.json({ error: "A turn is already running for this session" }, { status: 409 });
	let questionResolver: QuestionTypeResolver | undefined;
	let problemResolver: ProblemTypeResolver | undefined;
	if (input.type === "plugin-problem-submission") {
		try {
			const host = await getPluginHost();
			problemResolver = (pluginId, typeId, version) => host.resolveProblemType(pluginId, typeId, version);
		} catch { return Response.json({ error: "Problem unavailable" }, { status: 400 }); }
	}
	if (input.type === "plugin-question-answer") {
		try {
			const host = await getPluginHost();
			questionResolver = (pluginId, typeId, version) => host.resolveQuestionType(pluginId, typeId, version);
		} catch { return Response.json({ error: "Question unavailable" }, { status: 400 }); }
	}

	// Refuse an ineligible Retry before catalog refresh, compaction, or any
	// turn/write effects. Revalidate after the awaited gates below too.
	if (input.type === "retry") {
		try {
			retryDrops(record.messages);
		} catch (err) {
			if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
			throw err;
		}
	}

	if (input.type === "retry-question") {
		try { questionRecoveryAppends(record.messages, input); }
		catch (err) {
			if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
			throw err;
		}
	}

	// THE UNIVERSAL TURN GATE (BYOK, owner, 2026-09-22): a turn needs the
	// CONVERSATION chain — the chat's own model override over the strong
	// slot — and there is no factory floor; when both are empty the turn
	// refuses honestly with the machine-readable 503 envelope (new sessions
	// and continuing ones alike — wake-pipeline turns ride this same path).
	// Placement is deliberate: BEFORE beginTurn (no liveness effects), the
	// write-ahead persist (nothing durable changes), and every downstream
	// resolution (jobs/extraction gate per-need on their own tiers).
	const effective = effectiveSettings();
	const conversation = resolveConversationSpec(record.settings, effective.models.strong);
	if (!conversation) {
		const envelope = modelsNotConfigured(["strong"]);
		console.info(`[chat ${chatId}] turn refused — ${JSON.stringify(envelope)}`);
		return Response.json(envelope, { status: 503 });
	}

	// THE KEY-PRESENCE GATE (provider-key interlude, owner, 2026-09-25): a
	// pinned model is not enough — its PROVIDER's key must be present, or
	// the turn dies mid-stream masked to a generic error. Truth is env-first
	// (providerKeyPresent reads what pi-ai would read at request time), so
	// an env-shadowed key passes. Same placement discipline as the models
	// gate: BEFORE beginTurn (no liveness effects) and the write-ahead
	// persist (nothing durable changes); wake-pipeline turns ride the same
	// path. The affected tier is strong — the conversation chain's own tier
	// (a chat.model override still resolves through it).
	if (isSubscriptionProvider(conversation.provider)) {
		await refreshConnectionCatalog(conversation.provider);
		if (input.type === "steers" && !connectionBackgroundAllowed(conversation.provider)) {
			return Response.json({ error: "Background use is off for this connection. Automatic follow-up remains deferred in its queue." }, { status: 403 });
		}
	}
	if (!providerKeyPresent(conversation.provider)) {
		const envelope = providerKeyMissingEnvelope(conversation.provider, ["strong"]);
		console.info(`[chat ${chatId}] turn refused — ${JSON.stringify(envelope)}`);
		return Response.json(envelope, { status: 503 });
	}

	// THE COMPACTION GATE (owner round 14, 2026-10-05 — the structural
	// ruling: NOTHING model-facing for this chat interleaves with a
	// running compaction): await any in-flight compaction (the settle
	// kick usually finished inside the learner's answer pause), and if
	// the record is STILL over threshold, compact synchronously — this
	// request waits. Skipped under tests (the extraction precedent);
	// placement mirrors the BYOK/key gates — BEFORE appends and
	// beginTurn, no liveness effects — and the record re-reads after
	// because compaction appends the marker.
	const callPurpose = { background: input.type === "steers" || (input.type === "continue" && reconstructRequestCause(record.messages) !== "foreground") };
	let requestCycle: SubscriptionRequestCycle | undefined;
	const tentativeSideIds = new Set<string>();
	const admittedSideIds = new Set<string>();
	let preparedSideIds = new Set<string>();
	const admitSideContext = () => { for (const id of preparedSideIds) admittedSideIds.add(id); };
	const lifecycle: SubscriptionDispatchLifecycle = {
		captured: (scope) => requestCycle?.captured(scope),
		beforeDispatch: (scope) => { requestCycle?.beforeDispatch(scope); admitSideContext(); },
		noDispatch: (kind) => requestCycle?.noDispatch(kind),
	};
	let conversationEngine: PiEngine;
	let compactionEngine: PiEngine;
	try {
		conversationEngine = piEngineForSpec(conversation, () => callPurpose.background, lifecycle, retentionForSlot("strong"));
		compactionEngine = piEngineForSpec(conversation, true, undefined, retentionForSlot("strong"));
	}
	catch { return Response.json({ error: conversation.provider === "chatgpt" ? chatGPTStreamError("model catalog") : isSubscriptionProvider(conversation.provider) ? nativeSubscriptionError(conversation.provider, "model catalog") : "The selected model is unavailable." }, { status: 503 }); }
	const capturedPolicy = submissionImagePolicyKey(conversationEngine);
	const capturedConversation = JSON.stringify(conversation);
	try {
		switch (input.type) {
			case "text": case "thinking":
				input = { ...input, images: await prepareSubmissionImages(input.images, conversationEngine) };
				break;
			case "answer":
				input = { ...input, answer: { ...input.answer, images: await prepareSubmissionImageChannels(input.answer.images, conversationEngine) } };
				break;
			case "plugin-problem-submission":
				input = { ...input, images: await prepareProblemSubmissionImageChannels(input.images, conversationEngine) };
				break;
			case "plugin-question-answer":
				input = { ...input, images: await prepareSubmissionImageChannels(input.images, conversationEngine) };
				break;
		}
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	const modelIdForCompaction = `${conversationEngine.model.provider}:${conversationEngine.model.id}`;
	const contextWindow = catalogContextLimits().get(modelIdForCompaction);
	const thresholdTokens = effectiveThresholdTokens(effective.compaction?.thresholdTokens, contextWindow);
	const systemPromptTokens = Math.ceil(composeInstructions(record.kind === "practice" ? "practice" : "teacher").length / 4);
	const estimateModel = effective.compaction.includeReasoning ? conversationEngine.model : undefined;
	const fitsSideContext = (messages: readonly LhMessage[]) => {
		const live = messages.filter((message) => (message as { role: string }).role !== "system");
		// Hard admission is not the compaction trigger. CLI capacity comes from
		// this request's latest matching session report, never catalog placeholders.
		// Re-resolve at every gate: new responses/compaction can invalidate it.
		// Retry's transient SDK prefix omits ALL tail failures. Keep the saved
		// history in the metadata-only view so omission cannot revive a report
		// invalidated by a genuine provider failure. New live responses win.
		const saved = conversation.provider === CLAUDE_CODE_PROVIDER ? stores.chatStore.getChat(chatId)?.messages ?? [] : [];
		const savedIds = new Set(saved.map((message) => message.id));
		const reportHistory = saved.length ? [...saved, ...live.filter((message) => !savedIds.has(message.id))] : live;
		const window = sideContextWindow(reportHistory, conversationEngine.model, contextWindow, input.type === "retry");
		const budget = window === undefined ? thresholdTokens : Math.max(1, window - Math.min(COMPACTION_RESERVE_TOKENS, conversationEngine.model.maxTokens));
		return projectedContextTokens(live, systemPromptTokens, estimateModel) <= budget;
	};
	const sideBudgetError = () => new Error(SIDE_CONTEXT_BUDGET_ERROR);
	const beforeCompaction = record.messages;
	await ensureCompacted(
		{
			chatStore: stores.chatStore,
			engine: compactionEngine,
			canStart: () => !isTurnRunning(chatId) && connectionBackgroundAllowed(conversation.provider),
			modelId: modelIdForCompaction,
			kind: record.kind === "practice" ? "practice" : hasProbeDone(record.messages) ? "teach" : "probe",
			includeReasoning: effective.compaction.includeReasoning,
			thresholdTokens,
			systemPromptTokens,
			projectMessages: (current) => {
				try {
					if (input.type === "plugin-question-answer" || input.type === "plugin-problem-submission") {
						// The processed result does not exist yet. Count only saved
						// history + raw side cargo, never a guessed result or an early
						// plugin callback. The exact assembled request is checked later.
						if (input.type === "plugin-question-answer") {
							const pending = pendingPluginQuestionOf(current.messages);
							if (!pending || pending.questionId !== input.questionId || !samePluginQuestionOccurrence(pending.occurrence, input.occurrence)) return current.messages;
							if (questionCallsOf(current.messages).length || pluginQuestionCallsOf(current.messages).some(call =>
								(call.status === "answerable" || call.status === "unreadable") && !samePluginQuestionOccurrence(call.occurrence, pending.occurrence))) return current.messages;
						} else {
							requirePluginProblemTarget(current, input);
							if (hasUnresolvedQuestion(current.messages)) return current.messages;
						}
						const updates = sideConversationEntries({ messages: current.messages, sideChats: sideContext.snapshot(chatId) });
						return updates.length ? [...current.messages, ...updates] : current.messages;
					}
					const next = input.type === "steers" ? input.steers.filter((entry) => !steerDelivered(current.messages, entry.id)) : inputAppends(current, input);
					const after = [...current.messages, ...next];
					if (hasUnresolvedQuestion(after)) return current.messages;
					const updates = sideConversationEntries({ messages: current.messages, sideChats: sideContext.snapshot(chatId) }, after);
					if (!updates.length) return current.messages;
					const projected = [...current.messages, ...(input.type === "answer" || input.type === "retry-question" ? [...next, ...updates] : [...updates, ...next])];
					const omitted = input.type === "retry" ? retryDrops(current.messages) : new Set<string>();
					return projected.filter((message) => !omitted.has(message.id));
				} catch (error) {
					if (error instanceof ChatInputError) return current.messages; // normal input validation follows the gate
					throw error;
				}
			},
		},
		chatId,
	);
	let pluginContributions: AgentBuildOptions["pluginContributions"];
	if (!buildAgent) {
		try { pluginContributions = await getPluginAgentContributions(); }
		catch (error) {
			// Plugin startup failures must not make the native lesson unusable.
			console.error("[plugins] Agent contributions unavailable:", error);
		}
	}
	const compactedRecord = stores.chatStore.getChat(chatId);
	if (!compactedRecord) return Response.json({ error: "Unknown chat" }, { status: 404 });
	record = compactedRecord;
	// Final admission seam: every image/preflight await is over. Resolve via
	// the SAME conversation chain, never a parallel role catalog. No await
	// may intervene before the save-only write or beginTurn/write below.
	const staleSubmission = () => Response.json({ code: "submission-stale", error: "The submission target or selected model changed. Your input has been kept." }, { status: 412 });
	const submissionIsCurrent = (checkModel = true) => {
		if (!freshSubmission) return true;
		if (record.createdAt !== capturedSession.createdAt || record.kind !== capturedSession.kind) return false;
		try {
			if (checkModel) {
				const spec = resolveConversationSpec(record.settings, effectiveSettings().models.strong);
				if (!spec || JSON.stringify(spec) !== capturedConversation) return false;
				const checked = piEngineForSpec(spec, () => callPurpose.background, lifecycle, retentionForSlot("strong"));
				if (submissionImagePolicyKey(checked) !== capturedPolicy || checked.level !== conversationEngine.level) return false;
			}
			assertPluginQuestionInputAllowed(record.messages, input);
			if (input.type !== "steers") assertNativeSubmissionTarget(record.messages, input);
			if (input.type === "plugin-problem-submission") requirePluginProblemTarget(record, input);
			if (input.type === "plugin-question-answer") {
				const pending = pendingPluginQuestionOf(record.messages);
				if (!pending || pending.questionId !== input.questionId || !samePluginQuestionOccurrence(pending.occurrence, input.occurrence)) return false;
			}
		} catch { return false; }
		return true;
	};
	if (!submissionIsCurrent()) return staleSubmission();
	// Recompute Retry eligibility on current truth, still before beginTurn.
	// A compaction marker or another writer may have landed during awaits.
	// These omissions affect ONLY the agent context, never the saved record.
	let retryOmissions = new Set<string>();
	if (input.type === "retry") {
		try {
			retryOmissions = sideBudgetRetryDrops(beforeCompaction, record.messages) ?? retryDrops(record.messages);
		} catch (err) {
			if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
			throw err;
		}
	}

	// The input's native appends (pure; the honest 400 for an answer with no
	// pending question call). Computed BEFORE beginTurn so a refused input
	// leaves no liveness effects; read against the CURRENT record. Wave C:
	// the idle wake carries EVERY queued marker (steerDelivered filters a
	// re-fire of an already-landed one) - with claimSteers gone, this wake
	// input is the only steer appender; in-run delivery rides pi's own
	// follow-up queue and never builds an input event at all.
	let preparation: TurnPreparation | undefined;
	let turnClaimed = false;
	let handedOff = false;
	let inputSaved = false;
	const releaseOwnership = () => {
		if (preparation) preparation.finish();
		else { endTurn(chatId); unregisterTurn(chatId); }
	};
	// The entire owned region includes grading, persistence and construction.
	// Every pre-handoff exit closes waiting views and releases its own claim.
	try {
	let appends;
	try {
		assertPluginQuestionInputAllowed(record.messages, input);
		// A competing preflight can start compaction during the contribution
		// await above. No await separates this structural check from ownership
		// or the save-only sibling branch below.
		if (compactionInFlight(chatId))
			return Response.json({ error: "A turn is already running for this session" }, { status: 409 });
		if ((input.type === "plugin-question-answer" || input.type === "plugin-problem-submission") && isTurnRunning(chatId))
			return Response.json({ error: "A turn is already running for this session" }, { status: 409 });
		if (input.type === "plugin-question-answer" || input.type === "plugin-problem-submission") {
			const questionSubmission = input.type === "plugin-question-answer" ? preparePluginQuestionSubmission({ id: chatId, messages: record.messages }, input, questionResolver!) : undefined;
			const problemSubmission = input.type === "plugin-problem-submission" ? preparePluginProblemSubmission(record, input, problemResolver!) : undefined;
			const submission = questionSubmission ?? problemSubmission!;
			const work = questionSubmission?.grade ?? problemSubmission?.process;
			if (work) {
				const claim = claimPreparingTurn(chatId);
				if (!claim) return Response.json({ error: "A turn is already running for this session" }, { status: 409 });
				preparation = claim;
				turnClaimed = true;
				const outcome = await work(preparation.signal);
				// No captured history may be written after asynchronous plugin processing.
				const current = stores.chatStore.getChat(chatId);
				if (!current || !preparation.isCurrent()) return staleSubmission();
				record = current;
				// Admission pins this submission's model/provider. Later picker
				// changes apply to the next request, not to this accepted work.
				if (!submissionIsCurrent(false)) return staleSubmission();
				preparation.signal.throwIfAborted();
				appends = submission.finish({ id: chatId, kind: record.kind, messages: record.messages }, outcome);
			} else appends = submission.finish({ id: chatId, kind: record.kind, messages: record.messages });
		} else appends = input.type === "steers"
			? input.steers.filter((s) => !steerDelivered(record.messages, s.id))
			: inputAppends(record, input);
	} catch (err) {
		if (err instanceof ChatInputError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}

	// THE PARALLEL-QUESTION GATE (owner, 2026-10-03 — the deepseek parallel
	// batch incident): an answer that leaves a SIBLING question dangling
	// defers its wake. The dock advances to the next question (the client's
	// optimistic result + record-changed carry the view); the LAST answer
	// fires the one reaction turn with every result ADJACENT to its calling
	// assistant message — the provider shape law (a tool result appended
	// after an intervening assistant message is rejected, which stranded
	// the sibling question permanently pre-fix). Nothing else can generate
	// while a question dangles (job wakes wait, continuation folds refuse,
	// the composer gates), so adjacency holds by construction.
	if ((input.type === "answer" || input.type === "plugin-question-answer") && hasUnresolvedQuestion([...record.messages, ...appends])) {
		const merged = [...record.messages, ...appends];
		try { stores.chatStore.saveMessages(chatId, merged); inputSaved = true; }
		catch (err) {
			console.error(`[chat ${chatId}] write-ahead persist failed:`, err);
			return new Response("Your input could not be saved. Please try again.", { status: 500 });
		}
		emit("record-changed", { chatId });
		return settledTurnResponse(); // the cheap terminal — no beginTurn, no turn
	}

	// One turn per chat, ever. A second request while a turn runs means a
	// stale/remounted client raced a live one — letting it through would
	// double-run the teacher and clobber the first turn's persist.
	if (!preparation && !beginTurn(chatId)) {
		console.info(`[chat ${chatId}] turn already in flight — request rejected`);
		return Response.json({ error: "A turn is already running for this session" }, { status: 409 });
	}

	turnClaimed = true;

	// Write-ahead persistence: the input's native appends go on disk BEFORE
	// the turn starts - the learner's answer is durable the instant the
	// request arrives, and any remount, second tab, or server crash reads
	// truth instead of the pre-answer record. (Wave C: the wake's markers
	// ride this same write-ahead - the pump de-queued them at fire, so this
	// is the ONLY copy ever appended.)
	// Prospectively check new exchanges from ALL threads for early automatic
	// refusal. This snapshot does not authorize the final assembled request;
	// SDK preparation re-collects live text and validates queued steering too.
	const sideContextSnapshots = sideContext.snapshot(chatId);
	const afterInput = [...record.messages, ...appends];
	const sideQuestions = hasUnresolvedQuestion(afterInput) ? [] : sideConversationEntries({
		messages: record.messages, sideChats: sideContextSnapshots,
	}, afterInput);
	const withSideQuestions = input.type === "answer" || input.type === "retry-question" || input.type === "plugin-question-answer" ? [...appends, ...sideQuestions] : [...sideQuestions, ...appends];
	const prospective = [...record.messages, ...withSideQuestions].filter((message) => !retryOmissions.has(message.id));
	const sideContextBlocked = sideQuestions.length > 0 && !fitsSideContext(prospective);
	// An automatic batch has not been admitted; refuse it without persisting
	// its markers. Its existing caller retains/restores the queued work.
	if (sideContextBlocked && isSubscriptionProvider(conversation.provider) && input.type === "steers") {
		endTurn(chatId);
		return new Response(sideBudgetError().message, { status: 400 });
	}
	// Only the learner/automatic input is write-ahead. Raw exchanges are
	// already durable in sideChats; their delivery entries join the SDK
	// request at its preparation boundary, and publish only if admitted.
	const merged = [...record.messages, ...appends];
	// Retry preserves every persisted attempt. Pi needs a non-assistant
	// tail to start continue(), so its temporary history omits the trailing
	// failures only. Count that SAME temporary prefix at settlement, or the
	// retained failures would make persistTurn skip genuinely new output.
	const agentMessages = input.type === "retry" ? merged.filter((m) => !retryOmissions.has(m.id)) : merged;
	const stagedAutomatic = isSubscriptionProvider(conversation.provider) && input.type === "steers";
	let persistBaseCount = stagedAutomatic ? record.messages.length : agentMessages.length;
	try {
		if (!stagedAutomatic) {
			stores.chatStore.saveMessages(chatId, merged);
			inputSaved = true;
		}
	} catch (err) {
		console.error(`[chat ${chatId}] write-ahead persist failed:`, err);
		return new Response("Your input could not be saved. Please try again.", { status: 500 });
	}
	// Visibility bookkeeping is not the canonical save. Its failure must
	// neither misreport a saved input as lost nor prevent the turn running.
	try {
		if (!stagedAutomatic) noteSteersDurable(chatId, merged);
	} catch (err) {
		console.error(`[chat ${chatId}] input visibility bookkeeping failed:`, err);
	}

	// MONEY CHANNEL (wave 4): one collector per request, fed by the agent's
	// message_end events. Every model call's usage lands in the chat record's
	// append-only turns log at onFinish — idempotent per turn id.
	const turnUsageId = crypto.randomUUID();
	const steps: CallUsage[] = [];
	const collectUsage = (usage: Usage) => {
		steps.push({
			inputTokens: usage.input,
			outputTokens: usage.output,
			cacheReadTokens: usage.cacheRead,
			cacheWriteTokens: usage.cacheWrite,
			cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
			// Optional in pi's Usage — persisted as 0, never dropped.
			reasoningTokens: usage.reasoning ?? 0,
		});
	};

	// AGENT CONSTRUCTION BRANCH (docs/archive/probe-teach-split.md §2): the transcript
	// is the seam — a probe_done call in the record means the probe is
	// concluded: build the TEACHER (planning + the full toolset). Otherwise
	// the session is still probing: build the PROBER (quiz/ask + probe_done).
	// Both share this whole composition (write-ahead persist, liveness,
	// steers, usage, extraction) — only the agent differs.
	const teaching = hasProbeDone(agentMessages);
	// BYOK (owner, 2026-09-22): the conversation chain was resolved by the
	// turn gate above (chat.model override → strong slot → refused) — the
	// engine build is pure from here; thinking levels clamp natively.
	// (Built once above the compaction gate; reused verbatim.)
	const engine = conversationEngine;
	// Provider-qualified stamp (model slots wave): matches the price table's
	// provider:id keys.
	const modelId = `${engine.model.provider}:${engine.model.id}`;
	// Tests inject a factory: the agent is stateless per turn, so each
	// request builds a fresh one off the record — the factory mirrors that
	// seam exactly. Wave B: the record IS the agent state (native messages;
	// the record's id field strips at the wire in toLlmMessages).
	// CROSS-STREAM SEAM (P2 reconciliation, 2026-09-19): `toolToggles`
	// rides the build opts as the user-level DELTA map (absent key =
	// enabled). The definitive toggleable set is TOGGLEABLE_TOOLS — the
	// sub-agent JOB tools (research/demo/visual/pdf; adjudicated with the
	// user: quiz/ask/fs/plan/probe_done are always-on).
	if (isSubscriptionProvider(conversation.provider)) requestCycle = new SubscriptionRequestCycle({
		initialMessages: asAgentMessages(agentMessages),
		staged: stagedAutomatic ? asAgentMessages(appends) : undefined,
		foregroundOwed: !callPurpose.background,
		purpose: callPurpose,
		scopeCurrent: (scope) => connectionScopeCurrent(conversation.provider, scope),
		commitStaged: () => {
			stores.chatStore.saveMessages(chatId, merged);
			persistBaseCount = merged.length;
			noteSteersDurable(chatId, merged);
		},
		restoreAutomatic: (automaticIds, retainedIds) => restoreUncommittedAutomatic(chatId, constructed, automaticIds, retainedIds),
	});
	let pendingSideBudgetError: Error | undefined;
	const agentOpts: AgentBuildOptions = {
		pluginContributions,
		engine,
		callPurpose,
		requestCycle,
		messages: asAgentMessages(agentMessages),
		validateContext: (messages) => {
			// This is the SDK's ACTUAL request, after both prepared references
			// and already-drained steering have joined it. A pre-queue estimate
			// cannot authorize this combined payload.
			preparedSideIds = new Set(messages.map((message) => (message as LhMessage).id).filter((id) => tentativeSideIds.has(id)));
			if (pendingSideBudgetError || (preparedSideIds.size > 0 && !fitsSideContext(messages as readonly LhMessage[]))) {
				pendingSideBudgetError = sideBudgetError();
				const rejected = new Set([...tentativeSideIds].filter((id) => !admittedSideIds.has(id)));
				// Only unadmitted reference entries are withdrawn from transient
				// loop state. No saved prefix, learner steer or completed tool is removed.
				constructed.state.messages = constructed.state.messages.filter((message) => !rejected.has((message as LhMessage).id));
				requestCycle?.rejectLocalRequest(rejected);
				throw pendingSideBudgetError;
			}
			if (!requestCycle) admitSideContext(); // BYOK has no subscription admission gate
		},
		contextUpdates: (messages) => {
			pendingSideBudgetError = undefined;
			const current = stores.chatStore.getChat(chatId);
			if (!current) return [];
			const saved = new Set(current.messages.map((message) => message.id));
			// Only unsaved null-detail SDK acknowledgements are placeholders;
			// real graded answers and legacy saved null results still resolve.
			const live = messages.filter((message) => message.role !== "toolResult" || message.isError || message.details !== null ||
				saved.has((message as LhMessage).id) || !(QUESTION_TOOLS as readonly string[]).includes(message.toolName)) as LhMessage[];
			if (hasUnresolvedQuestion(live)) return [];
			// Include the loop's already-injected entries, but don't fold saved
			// suffixes twice. Full disk history keeps the pre-compaction ledger.
			const pending = live.filter((message) => message.role === "custom" && message.customType === "side-question" && !saved.has(message.id));
			const history = [...current.messages, ...pending];
			const updates = sideConversationEntries({ messages: history, sideChats: sideContext.snapshot(chatId) });
			if (updates.length && !fitsSideContext([...live, ...updates])) {
				pendingSideBudgetError = sideBudgetError();
				return []; // no delivery watermark for exchanges the model cannot receive
			}
			for (const update of updates) tentativeSideIds.add(update.id);
			return asAgentMessages(updates);
		},
		onUsage: collectUsage,
		toolToggles: effective.agent.tools,
		// Debug (owner, 2026-10-04): teacher/prober raw provider events under
		// LH_PROVIDER_EVENTS=1 (provider-events.ts); no-op otherwise.
		chatId,
		// The prompt-override switches (P2, 2026-09-19): same resolution
		// point as the tool delta — the agent layer composes the system
		// prompt fresh per turn, swapping in any enabled override segments.
		promptSwitches: effective.agent.prompts,
	};
	// PRACTICE BRANCH (owner design, 2026-10-04): a kind:"practice"
	// session builds the practitioner from turn 1 — no prober→teacher
	// split, no plan/question/job tools; the whole registry is
	// problem + conclude. buildAgent stays honored (the test seam is
	// uniform across kinds).
	const constructed: TeachingAgent = buildAgent
		? buildAgent({ ...agentOpts, teaching })
		: record.kind === "practice"
			? createPracticeAgent(
					{
						chatId,
						chatStore: stores.chatStore,
						// TARGET VALIDATION (owner round 9): the practice tools read the
						// WHOLE graph fresh per pose — targets validate against every
						// proposition, not just the session's picks (pickless sessions
						// and future graph-tools poses stay valid).
						graphNodes: () => stores.graphStore.readNodes(),
						// THE RARELY-NEEDED SET (owner round 10): research + pdf jobs
						// (same runner/gating as the teacher's — research honestly
						// absent when no engine is live) and the map readers behind
						// the SAME settings gate as the prober's.
						jobs: {
							chatId,
							jobStore: stores.jobStore,
							spawn: (job, input) => void jobRunner.runJob(job.id, input),
							searchAvailable,
						},
						...(graphToolsEnabled(effective) ? { graph: { chatStore: stores.chatStore, graphStore: stores.graphStore } } : {}),
					},
					agentOpts,
				)
			: teaching
			? createTeacherAgent(
					{
						chatId,
						chatStore: stores.chatStore,
						jobStore: stores.jobStore,
						spawn: (job, input) => void jobRunner.runJob(job.id, input),
						// The registry drop's signal (2026-09-20): no live engine
						// = no research tool in the teacher's registry.
						searchAvailable,
					},
					agentOpts,
				)
			: createProberAgent(
					{
						chatId,
						chatStore: stores.chatStore,
						deliver: (steer) => void deliverJobResult(steer),
						// Fix wave (2026-09-20): the prober carries research + pdf
						// dispatch (owner ruling — phase-omnipresent), so its ctx
						// needs the same job wiring as the teacher's.
						jobStore: stores.jobStore,
						spawn: (job, input) => void jobRunner.runJob(job.id, input),
						searchAvailable,
						// The map reader (wave 7): the prober reads the learner's
						// knowledge graph through tools when the gate opens —
						// graph master switch AND the agent.graphTools toggle.
						...(graphToolsEnabled(effective) ? { graphStore: stores.graphStore } : {}),
					},
					agentOpts,
				);

	// A test-injected agent gets no usage collector (tests assert the
	// transcript, not the money channel); when it's ours, usage flows through
	// the factory's subscription (wired above via onUsage).
	try {
		// THE TURN AS A BACKGROUND OBJECT (owner ruling, 2026-09-25):
		// runPiTurn executes decoupled from this response — the POST stream
		// is just the FIRST subscriber (a view). A client disconnect can no
		// longer abort the turn; the remote kill is the abort channel, and
		// late views reattach via GET /api/chats/[id]/stream.
		// Wave C (owner correction, 2026-09-26 — steering): register the live
		// agent BEFORE runPiTurn — the loop's start steering-poll drains the
		// queue SYNCHRONOUSLY inside that call, so a later registration would
		// miss it. Registration also steers any pending registry markers into
		// this run: a marker parked behind a just-answered quiz rides THIS
		// run's first LLM call (the native replacement for continuation
		// coalescing). Settlement still cannot beat the flow below: it needs
		// a streamed response, which never happens inside the constructor.
		registerLiveAgent(chatId, constructed, input.type !== "steers" && input.type !== "continue",
			input.type === "steers" ? new Set(appends.map((message) => message.id)) : undefined);
		// Debug recorder run marker (owner, 2026-10-04): correlates the
		// JSONL event stream with the record's turns; no-op unless
		// LH_PROVIDER_EVENTS=1.
		providerEventNote(chatId, "turn", `run start (base: ${agentMessages.length} messages)`);
		const handle = runPiTurn({
			agent: constructed,
			requestCycle,
			// The next-turn SDK hook covers internal calls. The steering poll
			// supplies the same fresh cargo on the first/recovery call, with
			// normal lifecycle events and no extra provider request.
			beforeCycle: () => {
				for (const message of agentOpts.contextUpdates!(constructed.state.messages)) constructed.steer(message);
			},
			// The coalescing window seam (COMPACTION LAW, 2026-10-09): tests
			// tighten it via LH_UPDATE_FLUSH_MS; production rides the 100ms
			// default in ui-stream.
			...(process.env.LH_UPDATE_FLUSH_MS ? { updateFlushMs: Number(process.env.LH_UPDATE_FLUSH_MS) } : {}),
			// THE LACAN FIX (2026-10-04): seed the uniquifier with every
			// tool-call id the record already holds — a provider that resets
			// ids per response (DeepSeek) then gets fresh unique ids for this
			// turn's calls at the wire boundary, on the wire, in the record,
			// and in the next turn's context alike.
			usedToolCallIds: new Set(collectToolCallIds(merged)),
			// Stream-level failures are provider/transport internals — masked,
			// like the SDK defaults. Tool-input validation messages never
			// route through here: they ride the error-result path and reach the
			// transcript directly (the retry context the model saw).
			onError: (error) => {
				if (conversation.provider === "chatgpt") return chatGPTStreamError(String(error));
				if (isSubscriptionProvider(conversation.provider)) return nativeSubscriptionError(conversation.provider, String(error));
				console.error(`[chat ${chatId}] turn error:`, error);
				return "An error occurred.";
			},
			onSettleError: settlementErrorText,
			onSettleFailure: (error, reportedErrorText) => {
				if (preparation && !preparation.isCurrent()) return;
				// POST only acknowledges acceptance; the submitter may attach
				// after this turn has already failed and left the registry.
				rememberTurnFailure(chatId, reportedErrorText ?? settlementErrorText(error));
				try { applyParkedDismissal(stores.chatStore, chatId); }
				catch (dismissalError) { console.error(`[chat ${chatId}] parked dismissal failed:`, dismissalError); }
				finally { releaseOwnership(); unregisterLiveAgent(chatId); }
				// The canonical save may have succeeded before later bookkeeping
				// threw. Reconcile against actual durability, never replay input
				// merely because usage/extraction/other settlement work failed.
				const persisted = stores.chatStore.getChat(chatId)?.messages ?? [];
				reconcileUserSteers(chatId, persisted);
				settleSteers(chatId, persisted, true, constructed);
			},
			onFinish: (turnMessages, isAborted) => {
				if (preparation && !preparation.isCurrent()) return;
				// Wave B: append only messages past the temporary agent prefix.
				// Retry's saved record still includes its earlier failed attempts.
				// Unadmitted reference entries cannot become delivery watermarks
				// merely because a local/provider refusal settled the running turn.
				const admittedMessages = turnMessages.filter((message) => !tentativeSideIds.has((message as LhMessage).id) || admittedSideIds.has((message as LhMessage).id));
				const stamped = persistTurn(stores.chatStore, chatId, persistBaseCount, admittedMessages, isAborted);
				noteSteersDurable(chatId, stores.chatStore.getChat(chatId)?.messages ?? stamped);
				// usage log append (idempotent per turn id) — the stats bar
				// refolds this on the client after the turn settles. The
				// provenance message is the turn's FIRST new assistant message.
				const response = stamped.find((m) => (m as { role?: string }).role === "assistant");
				if (response && steps.length > 0) {
					stores.chatStore.appendTurnUsage(chatId, {
						id: turnUsageId,
						messageId: response.id,
						at: new Date().toISOString(),
						model: modelId,
						steps,
					});
				}
				// GRAPH GATE (settings-storage wave, 2026-09-19): the write channel —
				// extraction, its auditor — dies with the master switch.
				// PRACTICE (owner, 2026-10-04): practice sessions write nothing —
				// no extraction, no graph, no coverage (v1: the session itself
				// is the deliverable).
				if ((!requestCycle || requestCycle.dispatched) && record.kind !== "practice" && extractionEnabled(effective.graph)) {
					// Fresh per-turn read of the graph section's chunk budget
					// (extraction-UX redesign, 2026-09-24): the trigger compares
					// against it and the pipeline's batches share it.
					triggerExtraction(stores, extraction, chatId, effective.graph.extractionChunkTokens);
				}
				// PARKED DISMISSAL (owner, 2026-10-04): a dismissal that arrived
				// mid-turn was parked by the dismiss route (202); now that
				// persistTurn has landed the turn's messages, apply it against
				// real truth — BEFORE endTurn, so "turn-settled" guarantees a
				// subsequent fetch reads the dismissal already in the record
				// (the same ordering law as persistTurn itself).
				applyParkedDismissal(stores.chatStore, chatId);
				// Any helper activity after the last model call stays pending;
				// settlement never injects it behind the agent's context.
				// LAST: a poller that sees not-in-flight must read an already-persisted
				// record — endTurn only after persistTurn has done its job.
				releaseOwnership();
				// Wave C steer settlement: the live agent is dead (no more
				// followUp handoffs) - reconcile the steer registry against
				// what this run actually persisted (in-run injections
				// resolve; stranded markers return to pending), then let
				// the pump take any stragglers down the idle wake.
				unregisterLiveAgent(chatId);
				settleSteers(chatId, stamped, false, constructed);
				// Composer steers (2026-10-03): delivered ids dropped, stranded
				// ones stay parked for the chat's next run (the registry is the
				// stranding safety net — the agent's undrained copy died above).
				reconcileUserSteers(chatId, stamped);
				// THE SETTLE KICK (owner round 14): the turn settled — if the
				// projection is now over threshold, the summary starts in the
				// background, INSIDE the learner's reading/answering pause
				// (question/problem poses end runs, so this moment is always a
				// between-runs window). The next turn's ensureCompacted gate
				// awaits whatever this leaves running; a lost engine or a
				// beneath-threshold record is a silent no-op. Skipped under
				// tests (the extraction precedent — scripted chats are
				// fixtures; the service itself is pinned directly).
				if (process.env.NODE_ENV !== "test" && !pendingSideBudgetError && (!requestCycle || requestCycle.dispatched))
					kickCompaction(() => {
						const fresh = effectiveSettings();
						const spec = resolveConversationSpec(stores.chatStore.getChat(chatId)?.settings, fresh.models.strong);
						if (!spec || !connectionBackgroundAllowed(spec.provider)) return null;
						let kickEngine: PiEngine;
						try { kickEngine = piEngineForSpec(spec, true, undefined, retentionForSlot("strong")); } catch { return null; }
						const kickModelId = `${kickEngine.model.provider}:${kickEngine.model.id}`;
						const freshRecord = stores.chatStore.getChat(chatId);
						if (!freshRecord) return null;
						return {
							chatStore: stores.chatStore,
							engine: kickEngine,
							canStart: () => !isTurnRunning(chatId) && connectionBackgroundAllowed(spec.provider),
							modelId: kickModelId,
							kind: freshRecord.kind === "practice" ? "practice" : hasProbeDone(freshRecord.messages) ? "teach" : "probe",
							includeReasoning: fresh.compaction.includeReasoning,
							thresholdTokens: effectiveThresholdTokens(
								fresh.compaction?.thresholdTokens,
								catalogContextLimits().get(kickModelId),
							),
							systemPromptTokens: Math.ceil(composeInstructions(freshRecord.kind === "practice" ? "practice" : "teacher").length / 4),
						};
					}, chatId);
			},
		});
		// The turn is now a live background object: register it so any view
		// can reattach (GET /api/chats/[id]/stream) or remotely abort it
		// (POST /api/activity/abort, kind "turn"). Registration after the
		// runPiTurn call is race-free: the agent loop only ticks in later
		// microtasks, so settle (and thus unregister) cannot beat us here.
		if (preparation) preparation.handoff(handle);
		else registerTurn(chatId, handle);
		handedOff = true;
		// CONNECTION DIET B (owner, 2026-10-10 — the parallel-session freeze
		// postmortem): the POST no longer holds the turn's SSE stream open for
		// its whole duration. It acknowledges acceptance and CLOSES; the
		// submitter attaches through GET /api/chats/[id]/stream — the same
		// universal reattach wire a returning visitor uses. The browser's
		// 6-connections-per-origin pool is the scarce resource. A graded
		// submission is the explicit exception: its POST stays open through
		// grading and the canonical save, then closes before teacher output. The
		// turn itself is a server-side process (ruling 2026-09-25) — it never
		// needed this connection, only a view did.
		if (stagedAutomatic && requestCycle && !(await requestCycle.admission)) return Response.json({ error: "Automatic follow-up remains deferred in its queue." }, { status: 403 });
		return Response.json({ ok: true });
	} catch (err) {
		console.error(`[chat ${chatId}] turn failed to start:`, err);
		if (preparation && inputSaved) {
			// The answer and outcome are already durable. Report the later
			// teacher failure through the existing retained stream notice.
			rememberTurnFailure(chatId, "Failed to start the turn");
			return Response.json({ ok: true });
		}
		return Response.json({ error: "Failed to start the turn" }, { status: 500 });
	}
	} catch (err) {
		if (preparation && inputSaved) {
			console.error(`[chat ${chatId}] accepted answer continuation failed:`, err);
			rememberTurnFailure(chatId, "Failed to start the turn");
			return Response.json({ ok: true });
		}
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		if (preparation?.signal.aborted) {
			return Response.json({ error: preparation.signal.reason instanceof Error ? preparation.signal.reason.message : "Question unavailable" }, { status: 409 });
		}
		if (turnClaimed) {
			console.error(`[chat ${chatId}] turn failed to start:`, err);
			return Response.json({ error: "Failed to start the turn" }, { status: 500 });
		}
		throw err;
	} finally {
		if (turnClaimed && !handedOff) {
			try {
				if (!preparation || preparation.isCurrent()) applyParkedDismissal(stores.chatStore, chatId);
			} catch (err) { console.error(`[chat ${chatId}] parked dismissal failed:`, err); }
			finally {
				if (!preparation || preparation.isCurrent()) unregisterLiveAgent(chatId);
				releaseOwnership();
			}
		}
	}
}
