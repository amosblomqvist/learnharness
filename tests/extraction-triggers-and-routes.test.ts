import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import { POST as extractPOST } from "../app/api/graph/coverage/extract/route.ts";
import { GET as statusGET } from "../app/api/graph/status/route.ts";
import {
	abortExtraction,
	clearExtractionError,
	createExtractionPipeline,
	extractionError,
	ExtractionStageUnavailableError,
	isChatExtractionRunning,
} from "../src/agent/subagents/extraction.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type {
	ChatRecord,
	ChatSummary,
	CoverageEntry,
	ExtractionRunUsage,
	GraphChain,
	GraphNode,
	NotesSource,
	PlanTree,
	SessionCheckpoint,
	TurnUsage,
} from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../src/core/settings.ts";
import { extraction, sessionCoverage, stores } from "../src/server/index.ts";
import {
	areAllPlanNodesAnswered,
	didCompleteLearningArc,
	isPlanArcComplete,
	runExtractionTrigger,
	shouldTriggerExtraction,
} from "../src/server/turn-service.ts";

// ─── In-memory stores (non-mutating ChatStore mock + GraphStore) ─────────────

function memoryChatStore(initial: ChatRecord[]): ChatStore {
	const records = new Map<string, ChatRecord>(initial.map((r) => [r.id, structuredClone(r)]));
	return {
		createChat: (title: string, kind?: "practice") => {
			const now = new Date().toISOString();
			const rec: ChatRecord = {
				id: `mem_${Math.random().toString(36).slice(2, 10)}`,
				title,
				kind,
				createdAt: now,
				updatedAt: now,
				messages: [],
				tree: undefined,
			};
			records.set(rec.id, rec);
			return structuredClone(rec);
		},
		getChat: (id: string) => {
			const rec = records.get(id);
			return rec ? structuredClone(rec) : null;
		},
		listChats: (): ChatSummary[] =>
			[...records.values()].map((r) => ({
				id: r.id,
				title: r.title,
				kind: r.kind ?? "teach",
				createdAt: r.createdAt,
				updatedAt: r.updatedAt,
				messageCount: r.messages.length,
				phase: "teach",
				pendingQuestion: false,
				pendingProblem: false,
			})),
		saveMessages: (id: string, messages: LhMessage[]) => {
			const rec = records.get(id);
			if (!rec) throw new Error(`Unknown chat: ${id}`);
			records.set(id, { ...rec, messages: structuredClone(messages), updatedAt: new Date().toISOString() });
		},
		saveImageSnapshot: () => {},
		renameChat: (id: string, title: string) => {
			const rec = records.get(id);
			if (!rec) throw new Error(`Unknown chat: ${id}`);
			const next = { ...rec, title };
			records.set(id, next);
			return structuredClone(next);
		},
		saveTree: (id: string, tree: PlanTree) => {
			const rec = records.get(id);
			if (!rec) return;
			records.set(id, { ...rec, tree: structuredClone(tree) });
		},
		saveSettings: (id: string, settings) => {
			const rec = records.get(id);
			if (!rec) return;
			records.set(id, { ...rec, settings: structuredClone(settings) });
		},
		appendTurnUsage: (id: string, entry: TurnUsage) => {
			const rec = records.get(id);
			if (!rec) return;
			records.set(id, { ...rec, turns: [...(rec.turns ?? []), structuredClone(entry)] });
		},
		appendExtractionUsage: (id: string, entry: ExtractionRunUsage) => {
			const rec = records.get(id);
			if (!rec) return;
			const prev = rec.extractions ?? [];
			if (prev.some((e) => e.startedAt === entry.startedAt)) return;
			records.set(id, { ...rec, extractions: [...prev, structuredClone(entry)] });
		},
		deleteChat: (id: string) => records.delete(id),
		updateSideChats: () => null,
	};
}

function memoryGraphStore(): GraphStore {
	const nodes: GraphNode[] = [];
	const chains: GraphChain[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	const coverage: CoverageEntry[] = [];
	const sources = new Map<string, NotesSource>();
	const positions = new Map<string, { x: number; y: number }>();
	return {
		appendNode: (n) => void nodes.push(n),
		readNodes: () => nodes.map((n) => ({ ...n })),
		appendChain: (c) => void chains.push(c),
		readChains: () => chains.map((c) => ({ ...c, premises: [...c.premises], provenance: [...c.provenance] })),
		appendCheckpoint: (c) => void checkpoints.push(c),
		readCheckpoints: () => checkpoints.map((c) => ({ ...c })),
		appendCoverage: (e) => void coverage.push({ ...e }),
		readCoverage: () => coverage.map((e) => ({ ...e })),
		upsertSource: (s) => {
			const prev = sources.get(s.id);
			sources.set(s.id, { ...s, extractions: [...(prev?.extractions ?? [])] });
		},
		readSources: () => [...sources.values()].map((s) => ({ ...s, extractions: [...(s.extractions ?? [])] })),
		deleteSources: (ids) => [...ids].reduce((n, id) => n + Number(sources.delete(id)), 0),
		appendSourceUsage: (id, entry) => {
			const s = sources.get(id);
			if (s) s.extractions = [...(s.extractions ?? []), entry];
		},
		readPositions: () => Object.fromEntries([...positions].map(([id, p]) => [id, { ...p }])),
		writePositions: (next) => {
			positions.clear();
			for (const [id, p] of Object.entries(next)) positions.set(id, { ...p });
		},
		rewriteLedgers: () => {},
	};
}

function submitEngine(toolName: string, payload: unknown, gate?: Promise<void>): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses([
		async () => {
			if (gate) await gate;
			return fauxAssistantMessage([fauxToolCall(toolName, payload as ToolCall["arguments"])], { stopReason: "toolUse" });
		},
	]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

// ─── Message & plan fixtures ─────────────────────────────────────────────────

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMsg(id: string, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: 1 };
}

function assistantText(id: string, text: string, stopReason: "stop" | "error" | "aborted" = "stop"): LhMessage {
	return {
		id,
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fixture",
		content: [{ type: "text", text }],
		stopReason,
		timestamp: 2,
		usage: zeroUsage,
	};
}

function assistantQuiz(id: string, callId: string, nodeId: string, text = "Consider this concept carefully."): LhMessage {
	return {
		id,
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fixture",
		content: [
			{ type: "text", text },
			{
				type: "toolCall",
				id: callId,
				name: "quiz",
				arguments: {
					nodeId,
					question: `Question for ${nodeId}`,
					options: ["Option A", "Option B"],
					correctIndex: 0,
					explanation: "Because A.",
				},
			},
		],
		stopReason: "toolUse",
		timestamp: 2,
		usage: zeroUsage,
	};
}

function quizResult(id: string, callId: string, dismissed = false): LhMessage {
	return {
		id,
		role: "toolResult",
		toolCallId: callId,
		toolName: "quiz",
		content: [{ type: "text", text: dismissed ? '{"dismissed":true}' : '{"selected":0}' }],
		details: dismissed ? { dismissed: true } : { selected: 0 },
		isError: false,
		timestamp: 3,
	};
}

function assistantPlanInit(id: string, callId: string, text = "Here is our next learning plan."): LhMessage {
	return {
		id,
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fixture",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: callId, name: "plan_init", arguments: { mermaid: "graph TD\nC-->D" } },
		],
		stopReason: "toolUse",
		timestamp: 2,
		usage: zeroUsage,
	};
}

function planInitResult(id: string, callId: string, tree: PlanTree): LhMessage {
	return {
		id,
		role: "toolResult",
		toolCallId: callId,
		toolName: "plan_init",
		content: [{ type: "text", text: "Plan saved." }],
		details: { ok: true, tree } as unknown as ToolResultMessage["details"],
		isError: false,
		timestamp: 3,
	};
}

function treeOf(...ids: string[]): PlanTree {
	return {
		nodes: ids.map((id) => ({ id, title: id.toUpperCase() })),
		edges: ids.slice(1).map((id, idx) => ({ from: ids[idx]!, to: id })),
		version: 1,
	};
}

function chatRecord(id: string, messages: LhMessage[], tree: PlanTree | undefined): ChatRecord {
	const now = new Date().toISOString();
	return { id, title: id, createdAt: now, updatedAt: now, messages, tree };
}

// ─── 1. Learning-arc completion trigger & real extraction pipeline (#568) ────

describe("learning-arc completion trigger & runExtractionTrigger (#568)", () => {
	it("triggers real extraction on a short follow-up arc well under chunkTokens and updates GraphStore", async () => {
		const tree = treeOf("a", "b");
		const previousMessages: LhMessage[] = [
			userMsg("u1", "Teach me follow-up topic"),
			assistantQuiz("a1", "q1", "a", "First core idea: entropy increases in isolated systems."),
			quizResult("r1", "q1"),
			assistantQuiz("a2", "q2", "b", "Second core idea: free energy governs spontaneity."),
		];
		const currentMessages: LhMessage[] = [
			...previousMessages,
			quizResult("r2", "q2"),
			assistantText("a3", "Nice work — both ideas now connect cleanly."),
		];
		const record = chatRecord("chat_arc_short", currentMessages, tree);
		const chatStore = memoryChatStore([record]);
		const graphStore = memoryGraphStore();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore,
			extractor: submitEngine("submit_findings", {
				propositions: [{ id: "p1", name: "Free energy", statement: "Free energy governs spontaneity.", aliases: [], messageId: "a2" }],
				chains: [],
			}),
			auditor: submitEngine("submit_review", { links: [] }),
		});

		assert.equal(didCompleteLearningArc(tree, currentMessages, { previousMessages, previousTree: tree, isAborted: false }), true);
		const done = runExtractionTrigger({ chatStore, graphStore }, pipeline, record.id, 4096, {
			previousMessages,
			previousTree: tree,
			isAborted: false,
		});
		assert.ok(done !== null, "trigger fires even though uncovered tokens << 4096");
		const stats = await done;
		assert.deepEqual(stats, { nodes: 1, chains: 0 });
		assert.equal(graphStore.readNodes().length, 1);
		assert.ok(graphStore.readCoverage().length > 0, "coverage checkpointed after follow-up arc extraction");
	});

	it("Retry after a failed wrap-up turn still triggers extraction once Retry succeeds", async () => {
		const tree = treeOf("a");
		const beforeError: LhMessage[] = [
			userMsg("u1", "Go"),
			assistantQuiz("a1", "q1", "a", "Core idea A explained thoroughly."),
		];
		const afterError: LhMessage[] = [
			...beforeError,
			quizResult("r1", "q1"),
			assistantText("a_err", "partial fail", "error"),
		];
		// Turn 1 failed -> must NOT trigger!
		assert.equal(
			didCompleteLearningArc(tree, afterError, { previousMessages: beforeError, previousTree: tree, isAborted: false }),
			false,
		);
		// Crucially, afterError has all nodes answered, yet isPlanArcComplete is FALSE because no clean assistant followed r1!
		assert.equal(areAllPlanNodesAnswered(tree, afterError), true);
		assert.equal(isPlanArcComplete(tree, afterError), false);

		// Turn 2 (Retry) succeeds with a clean assistant wrap-up -> MUST trigger!
		const afterRetry: LhMessage[] = [
			...afterError,
			assistantText("a2", "Great job on A!"),
		];
		assert.equal(
			didCompleteLearningArc(tree, afterRetry, { previousMessages: afterError, previousTree: tree, isAborted: false }),
			true,
		);
		const record = chatRecord("chat_retry_arc", afterRetry, tree);
		const chatStore = memoryChatStore([record]);
		const graphStore = memoryGraphStore();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore,
			extractor: submitEngine("submit_findings", {
				propositions: [{ id: "p1", name: "Idea A", statement: "Core idea A.", aliases: [], messageId: "a1" }],
				chains: [],
			}),
			auditor: submitEngine("submit_review", { links: [] }),
		});
		const stats = await runExtractionTrigger({ chatStore, graphStore }, pipeline, record.id, 4096, {
			previousMessages: afterError,
			previousTree: tree,
			isAborted: false,
		});
		assert.deepEqual(stats, { nodes: 1, chains: 0 });
		assert.equal(graphStore.readNodes().length, 1);
	});

	it("silent Dismiss followed by a clean wrap-up turn triggers extraction", () => {
		const tree = treeOf("a");
		const afterDismiss: LhMessage[] = [
			userMsg("u1", "Go"),
			assistantQuiz("a1", "q1", "a", "Core idea A."),
			quizResult("r1", "q1", true),
		];
		assert.equal(areAllPlanNodesAnswered(tree, afterDismiss), true);
		assert.equal(isPlanArcComplete(tree, afterDismiss), false, "no clean assistant after silent dismiss yet");

		const afterWrapUp: LhMessage[] = [
			...afterDismiss,
			userMsg("u2", "Let's wrap up"),
			assistantText("a2", "Summary of A."),
		];
		assert.equal(
			didCompleteLearningArc(tree, afterWrapUp, { previousMessages: afterDismiss, previousTree: tree, isAborted: false }),
			true,
		);
	});

	it("closing quiz + immediate new plan_init in the SAME turn (even with a new unanswered quiz) triggers extraction", () => {
		const prevTree = treeOf("a", "b");
		const nextTree = treeOf("c", "d");
		const previousMessages: LhMessage[] = [
			userMsg("u1", "Start"),
			assistantQuiz("a1", "q1", "a", "Idea A."),
			quizResult("r1", "q1"),
			assistantQuiz("a2", "q2", "b", "Idea B."),
		];
		const currentMessages: LhMessage[] = [
			...previousMessages,
			quizResult("r2", "q2"),
			assistantPlanInit("a3", "pi1", "Awesome! Starting next arc."),
			planInitResult("pr1", "pi1", nextTree),
			assistantQuiz("a4", "q3", "c", "Now let's explore C."),
		];
		assert.equal(
			didCompleteLearningArc(nextTree, currentMessages, { previousMessages, previousTree: prevTree, isAborted: false }),
			true,
		);
	});

	it("shortening plan_init ([A,B,C] -> [A,B] after A,B answered) triggers extraction", () => {
		const prevTree = treeOf("a", "b", "c");
		const nextTree = treeOf("a", "b");
		const previousMessages: LhMessage[] = [
			userMsg("u1", "Start"),
			assistantQuiz("a1", "q1", "a", "Idea A."),
			quizResult("r1", "q1"),
			assistantQuiz("a2", "q2", "b", "Idea B."),
			quizResult("r2", "q2"),
			assistantText("a3", "Good progress, next is C."),
		];
		const currentMessages: LhMessage[] = [
			...previousMessages,
			userMsg("u2", "Let's skip C and finish here"),
			assistantPlanInit("a4", "pi1", "Trimming the plan."),
			planInitResult("pr1", "pi1", nextTree),
			assistantText("a5", "All done with A and B!"),
		];
		assert.equal(
			didCompleteLearningArc(nextTree, currentMessages, { previousMessages, previousTree: prevTree, isAborted: false }),
			true,
		);
	});

	it("blocks anti-penny-batching, 0 assistant turns, error/aborted turns, tree===null, and uncovered===0", () => {
		const tree = treeOf("a");
		const completed: LhMessage[] = [
			userMsg("u1", "Go"),
			assistantQuiz("a1", "q1", "a", "Idea A."),
			quizResult("r1", "q1"),
			assistantText("a2", "Wrap up."),
		];
		// Anti-penny-batching: subsequent chitchat after arc already complete
		const chitchat = [...completed, userMsg("u2", "Thanks!"), assistantText("a3", "You're welcome!")];
		assert.equal(didCompleteLearningArc(tree, chitchat, { previousMessages: completed, previousTree: tree, isAborted: false }), false);

		// 0 assistant messages in turnSlice
		const pending: LhMessage[] = [userMsg("u1", "Go"), assistantQuiz("a1", "q1", "a", "Idea A.")];
		assert.equal(didCompleteLearningArc(tree, [...pending, quizResult("r1", "q1")], { previousMessages: pending, previousTree: tree, isAborted: false }), false);

		// Error assistant in turnSlice
		assert.equal(
			didCompleteLearningArc(tree, [...pending, quizResult("r1", "q1"), assistantText("a2", "boom", "error")], {
				previousMessages: pending,
				previousTree: tree,
				isAborted: false,
			}),
			false,
		);

		// Aborted turn via flag or stopReason
		assert.equal(
			didCompleteLearningArc(tree, [...pending, quizResult("r1", "q1"), assistantText("a2", "cut off")], {
				previousMessages: pending,
				previousTree: tree,
				isAborted: true,
			}),
			false,
		);
		assert.equal(
			didCompleteLearningArc(tree, [...pending, quizResult("r1", "q1"), assistantText("a2", "cut off", "aborted")], {
				previousMessages: pending,
				previousTree: tree,
				isAborted: false,
			}),
			false,
		);

		// tree === null
		assert.equal(
			didCompleteLearningArc(null, [...pending, quizResult("r1", "q1"), assistantText("a2", "Done")], {
				previousMessages: pending,
				previousTree: null,
				isAborted: false,
			}),
			false,
		);

		// uncovered === 0 does not trigger even if arc completed
		const noProsePrev: LhMessage[] = [userMsg("u1", "Go"), assistantQuiz("a1", "q1", "a", "")];
		const noProseCur: LhMessage[] = [...noProsePrev, quizResult("r1", "q1"), assistantText("a2", "")];
		assert.equal(
			shouldTriggerExtraction(chatRecord("c_zero", noProseCur, tree), [], 4096, {
				previousMessages: noProsePrev,
				previousTree: tree,
				isAborted: false,
			}),
			false,
		);
	});

	it("auto-trigger skips ModelsNotConfiguredError/ProviderKeyMissingError quietly, while recording lastError on ExtractionStageUnavailableError", async () => {
		const tree = treeOf("a");
		const prev: LhMessage[] = [userMsg("u1", "Go"), assistantQuiz("a1", "q1", "a", "Idea A.")];
		const cur: LhMessage[] = [...prev, quizResult("r1", "q1"), assistantText("a2", "Done!")];
		const rec = chatRecord("chat_auto_err", cur, tree);
		const chatStore = memoryChatStore([rec]);
		const graphStore = memoryGraphStore();

		const unconfigured = createExtractionPipeline({ chatStore, graphStore, stageProvider: () => undefined });
		await runExtractionTrigger({ chatStore, graphStore }, unconfigured, rec.id, 4096, { previousMessages: prev, previousTree: tree });
		assert.equal(extractionError(rec.id), null, "ModelsNotConfiguredError stays quiet");

		const broken = createExtractionPipeline({
			chatStore,
			graphStore,
			stageProvider: () => "openai",
			providerKeyMissing: () => null,
			engineFor: () => { throw new Error("catalog crashed sk-secret1234567890"); },
		});
		await runExtractionTrigger({ chatStore, graphStore }, broken, rec.id, 4096, { previousMessages: prev, previousTree: tree });
		const err = extractionError(rec.id);
		assert.ok(err !== null && !err.includes("sk-secret"), "ExtractionStageUnavailableError populates sanitized lastError");
		clearExtractionError(rec.id);
	});
});

// ─── 2. Real HTTP route handlers: POST /api/graph/coverage/extract & GET /api/graph/status ──

describe("POST /api/graph/coverage/extract & GET /api/graph/status (#934)", () => {
	const originalStart = extraction.startExtraction;
	const createdChatIds: string[] = [];

	after(() => {
		extraction.startExtraction = originalStart;
		for (const id of createdChatIds) {
			abortExtraction(id);
			clearExtractionError(id);
			stores.chatStore.deleteChat(id);
		}
	});

	function createRealChat(kind?: "practice"): ChatRecord {
		const rec = stores.chatStore.createChat("Route fixture", kind);
		createdChatIds.push(rec.id);
		stores.chatStore.saveMessages(rec.id, [
			userMsg("u1", "Teach me X"),
			assistantText("a1", "X is a core proposition worth extracting into the knowledge graph."),
		]);
		return stores.chatStore.getChat(rec.id)!;
	}

	function postReq(rawBody: string): Request {
		return new Request("http://localhost/api/graph/coverage/extract", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: rawBody,
		});
	}

	it("validates JSON body, chat existence, and practice kind (400 / 404)", async () => {
		assert.equal((await extractPOST(postReq("{bad json"))).status, 400);
		assert.equal((await extractPOST(postReq("null"))).status, 400);
		assert.equal((await extractPOST(postReq("[]"))).status, 400);
		assert.equal((await extractPOST(postReq(JSON.stringify({ chatId: "" })))).status, 400);
		assert.equal((await extractPOST(postReq(JSON.stringify({ chatId: "chat_missing_route_test" })))).status, 404);

		const practice = createRealChat("practice");
		const res = await extractPOST(postReq(JSON.stringify({ chatId: practice.id })));
		assert.equal(res.status, 400);
	});

	it("maps readiness errors to 503 envelopes/sanitized messages, already_running to 409, nothing_uncovered to 200, and started to 202 with immediate running:true", async () => {
		const chat = createRealChat();

		// 503 ModelsNotConfiguredError
		extraction.startExtraction = async () => { throw new ModelsNotConfiguredError(["cheap"]); };
		let res = await extractPOST(postReq(JSON.stringify({ chatId: chat.id })));
		assert.equal(res.status, 503);
		assert.equal((await res.json()).code, "models_not_configured");

		// 503 ProviderKeyMissingError
		extraction.startExtraction = async () => { throw new ProviderKeyMissingError("openai", ["cheap"]); };
		res = await extractPOST(postReq(JSON.stringify({ chatId: chat.id })));
		assert.equal(res.status, 503);
		const keyBody = await res.json();
		assert.equal(keyBody.code, "provider_key_missing");
		assert.equal(keyBody.provider, "openai");

		// 503 ExtractionStageUnavailableError
		extraction.startExtraction = async () => {
			throw new ExtractionStageUnavailableError("extractor", "openai", "The selected extraction model is unavailable. Check your model settings.");
		};
		res = await extractPOST(postReq(JSON.stringify({ chatId: chat.id })));
		assert.equal(res.status, 503);
		assert.equal((await res.json()).code, "model_unavailable");

		// 503 unexpected error is sanitized
		extraction.startExtraction = async () => { throw new Error("raw crash Bearer secret_token_xyz"); };
		res = await extractPOST(postReq(JSON.stringify({ chatId: chat.id })));
		assert.equal(res.status, 503);
		const rawBody = await res.json();
		assert.ok(!rawBody.error.includes("secret_token_xyz"));

		// 200 nothing_uncovered
		extraction.startExtraction = async () => ({ status: "nothing_uncovered" });
		res = await extractPOST(postReq(JSON.stringify({ chatId: chat.id })));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { started: false });

		// Real pipeline wired to route: 202 started + immediate running===true + 409 on duplicate
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const ledgers = memoryGraphStore();
		const realPipe = createExtractionPipeline({
			chatStore: stores.chatStore,
			graphStore: ledgers,
			extractor: submitEngine(
				"submit_findings",
				{ propositions: [{ id: "p1", name: "X", statement: "X is a core proposition.", aliases: [], messageId: "a1" }], chains: [] },
				gate,
			),
			auditor: submitEngine("submit_review", { links: [] }),
		});
		let settledDone: Promise<unknown> | undefined;
		extraction.startExtraction = async (id) => {
			const r = await realPipe.startExtraction(id);
			if (r.status === "started") settledDone = r.done;
			return r;
		};

		res = await extractPOST(postReq(JSON.stringify({ chatId: chat.id })));
		assert.equal(res.status, 202);
		assert.deepEqual(await res.json(), { started: true });
		assert.equal(isChatExtractionRunning(chat.id), true, "running===true immediately on 202");
		assert.equal(sessionCoverage(chat.id)!.running, true, "sessionCoverage reflects running immediately on 202");

		// Duplicate while running -> 409
		const dup = await extractPOST(postReq(JSON.stringify({ chatId: chat.id })));
		assert.equal(dup.status, 409);

		// GET /api/graph/status includes runs AND graphRevision
		const statusRes = await statusGET();
		assert.equal(statusRes.status, 200);
		const statusBody = await statusRes.json();
		assert.ok(Array.isArray(statusBody.runs));
		assert.ok(statusBody.runs.some((r: { chatId: string }) => r.chatId === chat.id), "in-flight run visible in status");
		assert.equal(typeof statusBody.graphRevision, "number", "status payload carries graphRevision");

		release();
		await settledDone;
		assert.equal(isChatExtractionRunning(chat.id), false);
		assert.equal(ledgers.readNodes().length, 1);
	});
});
