/**
 * The learner's mistakes: finding misses in saved sessions, de-duplication,
 * the short error analysis (scripted analyst), grouping/pattern/filter for
 * the Mistakes page, the cost cap/opt-out, and the routes — all under an
 * isolated LH_DATA_DIR (the seam is set before any config import).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import {
	filterMistakes,
	findMistakes,
	groupMistakes,
	mergeMistakes,
	parseAnalysis,
	patternLine,
	summarizeMistakes,
	type MistakeRecord,
} from "../src/core/mistakes.ts";
import { MISTAKE_ANALYSIS_DAILY_CAP_DEFAULT, sanitizeUserSettings } from "../src/core/settings.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mistakes-"));
process.env.LH_DATA_DIR = TMP_DATA;
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

// ── fixtures ─────────────────────────────────────────────────────────────────

const answer = (over: Record<string, unknown>): QuestionAnswerData =>
	({
		kind: "quiz",
		questionText: "What is the friction force on the 10 kg block at rest on a 30 degree ramp?",
		options: [
			{ index: 1, label: "69 N" },
			{ index: 2, label: "50 N" },
			{ index: 3, label: "100 N" },
		],
		correctIndices: [2],
		answers: [{ label: "69 N", value: "a", index: 1 }],
		dontKnow: false,
		correct: false,
		explanation: "Static friction balances the pull down the ramp.",
		thinking: "friction is mu N",
		confidence: 90,
		answeredAt: "2026-10-27T10:00:00.000Z",
		...over,
	}) as unknown as QuestionAnswerData;

const result = (id: string, toolName: string, details: unknown, isError = false): LhMessage =>
	({ id: `m_${id}`, role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text: "ok" }], details, isError, timestamp: 1 }) as unknown as LhMessage;

const call = (id: string, name: string, args: unknown): LhMessage =>
	({ id: `a_${id}`, role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 1 }) as unknown as LhMessage;

const session: LhMessage[] = [
	call("q1", "quiz", {}),
	result("q1", "quiz", answer({})), // wrong
	call("q2", "quiz", {}),
	result("q2", "quiz", answer({ correct: true })), // right
	call("q3", "quiz", {}),
	result("q3", "quiz", answer({ dontKnow: true, answers: [], correct: false, confidence: undefined })), // unanswered
	call("q4", "quiz", {}),
	result("q4", "quiz", answer({ dismissed: true })), // skipped
	call("q5", "quiz", {}),
	result("q5", "quiz", answer({ byVoice: true, answers: [], correct: undefined })), // ungraded
	call("q7", "explain", {}),
	result("q7", "explain", { kind: "explain", questionText: "free recall", dontKnow: false, answers: [], answeredAt: "t" }), // not graded
	call("p1", "problem", { statement: "Prove the sum is even.", modelSolution: "Pair them." }),
	result("p1", "problem", null),
	call("c1", "conclude", { outcome: "surrendered", verdict: "Never found the pairing.", missClass: "structural" }),
	result("c1", "conclude", null),
	call("p2", "problem", { statement: "Another.", modelSolution: "x" }),
	result("p2", "problem", null),
	call("c2", "conclude", { outcome: "solved", verdict: "clean" }),
	result("c2", "conclude", null),
	call("c3", "conclude", { outcome: "dismissed", verdict: "" }),
	result("c3", "conclude", null),
	call("qx", "quiz", {}),
	result("qx", "quiz", answer({}), true), // errored call never happened
];

describe("findMistakes", () => {
	const found = findMistakes("chat1", session);
	it("finds wrong answers, 'I don't know', and unclean problems — nothing else", () => {
		assert.deepEqual(found.map((m) => [m.id, m.kind]), [
			["chat1:q1", "missed"],
			["chat1:q3", "unanswered"],
			["chat1:c1", "problem"],
		]);
	});
	it("records what was picked, the key, the explanation, thinking and confidence", () => {
		const m = found[0]!;
		assert.equal(m.yourAnswer, "69 N");
		assert.equal(m.correctAnswer, "50 N");
		assert.equal(m.explanation, "Static friction balances the pull down the ramp.");
		assert.equal(m.thinking, "friction is mu N");
		assert.equal(m.confidence, 90);
		assert.equal(found[1]!.yourAnswer, "I don't know");
	});
	it("joins a problem to its statement, committed solution, outcome and verdict", () => {
		const p = found[2]!;
		assert.equal(p.question, "Prove the sum is even.");
		assert.equal(p.correctAnswer, "Pair them.");
		assert.equal(p.outcome, "surrendered");
		assert.equal(p.yourAnswer, "Gave up");
		assert.equal(p.verdict, "Never found the pairing.");
		assert.equal(p.missClass, "structural");
	});
});

const META = { chatId: "chat1", title: "Friction", kind: "teach" as const, sources: ["notes.md"], now: "2026-10-27T11:00:00.000Z" };

describe("mergeMistakes", () => {
	it("adds new misses as pending and never duplicates on a second scan", () => {
		const drafts = findMistakes("chat1", session);
		const first = mergeMistakes([], drafts, META);
		assert.equal(first.added.length, 3);
		assert.ok(first.added.every((r) => r.status === "pending" && r.sessionTitle === "Friction" && r.sources[0] === "notes.md"));
		const second = mergeMistakes(first.records, drafts, META);
		assert.equal(second.added.length, 0);
		assert.equal(second.records.length, 3);
	});
	it("keeps analyses on existing records but refreshes the session title", () => {
		const first = mergeMistakes([], findMistakes("chat1", session), META).records.map((r) => ({ ...r, status: "ready" as const }));
		const next = mergeMistakes(first, [], { ...META, title: "Renamed" });
		assert.ok(next.records.every((r) => r.status === "ready" && r.sessionTitle === "Renamed"));
	});
});

describe("parseAnalysis", () => {
	const good = { errorType: "Confusable pair", topic: "static vs kinetic", whatYouDid: "a", correct: "b", rule: "c" };
	it("accepts and normalizes a complete analysis", () => {
		assert.deepEqual(parseAnalysis(good), { errorType: "confusable-pair", topic: "static vs kinetic", whatYouDid: "a", correct: "b", rule: "c" });
	});
	it("rejects unknown types and missing fields", () => {
		assert.equal(parseAnalysis({ ...good, errorType: "vibes" }), null);
		assert.equal(parseAnalysis({ ...good, rule: "" }), null);
		assert.equal(parseAnalysis(null), null);
	});
});

function ready(id: string, type: string, topic: string, chatId = "chat1", title = "Friction"): MistakeRecord {
	return {
		id, chatId, kind: "missed", origin: "quiz", question: `Q ${id}`, yourAnswer: "a", correctAnswer: "b", answeredAt: "2026-10-27T10:00:00.000Z", createdAt: "x",
		sessionTitle: title, sessionKind: "teach", sources: [], status: "ready",
		analysis: { errorType: type as never, topic, whatYouDid: "w", correct: "c", rule: "r" },
	};
}

describe("review tab helpers", () => {
	const records = [
		ready("1", "confusable-pair", "Friction"),
		ready("2", "confusable-pair", "Friction"),
		ready("3", "setup-error", "Energy", "chat2", "Energy notes"),
		{ ...ready("4", "reversal", "x"), status: "pending" as const, analysis: undefined },
	];
	it("groups by error type, session, or topic — biggest first, with a pattern line", () => {
		const byType = groupMistakes(records, "type");
		assert.deepEqual(byType.map((g) => [g.label, g.records.length]), [["Confusable pair", 2], ["Not analyzed yet", 1], ["Setup error", 1]]);
		assert.equal(byType[0]!.pattern, "2 of 2: Friction");
		const bySession = groupMistakes(records, "session");
		assert.deepEqual(bySession.map((g) => [g.label, g.records.length]), [["Friction", 3], ["Energy notes", 1]]);
		assert.equal(bySession[0]!.pattern, "2 of 2: Confusable pair");
		assert.deepEqual(groupMistakes(records, "topic").map((g) => g.label), ["Friction", "Energy", "Not analyzed yet"]);
	});
	it("only states a pattern when two share a trap", () => {
		assert.equal(patternLine([records[2]!], "errorType"), null);
	});
	it("filters by text, type, session and kind; summarizes counts", () => {
		assert.equal(filterMistakes(records, { query: "energy" }).length, 1);
		assert.equal(filterMistakes(records, { errorType: "confusable-pair" }).length, 2);
		assert.equal(filterMistakes(records, { chatId: "chat2" }).length, 1);
		assert.equal(filterMistakes(records, { kind: "unanswered" }).length, 0);
		const s = summarizeMistakes(records);
		assert.deepEqual([s.total, s.missed, s.pending], [4, 4, 1]);
		assert.deepEqual(s.byType[0], { type: "confusable-pair", count: 2 });
	});
});

describe("the analyst settings", () => {
	it("defaults to auto ON with a bounded daily cap", () => {
		const parsed = sanitizeUserSettings({ version: 1 });
		assert.ok(parsed);
		assert.equal(parsed.agent?.mistakeAnalysis, undefined);
		// Resolution is exercised through the server helper below; the factory
		// cap is the exported constant.
		assert.equal(MISTAKE_ANALYSIS_DAILY_CAP_DEFAULT, 20);
	});
	it("sanitizes an explicit opt-out and clamps the cap", () => {
		const parsed = sanitizeUserSettings({ version: 1, agent: { mistakeAnalysis: { auto: false, dailyCap: 999 } } });
		assert.ok(parsed);
		assert.deepEqual(parsed.agent?.mistakeAnalysis, { auto: false, dailyCap: 100 });
	});
});

// ── the analyst + routes ─────────────────────────────────────────────────────

function analystEngine(steps: Array<ReturnType<typeof fauxAssistantMessage>>): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}
const submit = (input: unknown) => fauxAssistantMessage([fauxToolCall("submit_analysis", input as ToolCall["arguments"], { id: "s1" })], { stopReason: "toolUse" });
const until = async (cond: () => boolean) => {
	for (let i = 0; i < 150 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
	assert.ok(cond(), "condition met in time");
};

describe("the mistakes service and routes", () => {
	let server: typeof import("../src/server/index.ts");
	let list: { GET: () => Promise<Response> };
	let scan: { POST: (req: Request) => Promise<Response> };
	let del: { DELETE: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> };
	let retry: { POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> };
	let perChat: { GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> };
	let chatStore: typeof import("../src/store/chats.ts").chatStore;

	before(async () => {
		server = await import("../src/server/index.ts");
		list = (await import("../app/api/mistakes/route.ts")) as never;
		scan = (await import("../app/api/mistakes/scan/route.ts")) as never;
		del = (await import("../app/api/mistakes/[id]/route.ts")) as never;
		retry = (await import("../app/api/mistakes/[id]/retry/route.ts")) as never;
		perChat = (await import("../app/api/chats/[id]/mistakes/route.ts")) as never;
		chatStore = (await import("../src/store/chats.ts")).chatStore;
	});

	const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body) });
	const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
	const stored = async () => ((await (await list.GET()).json()) as { mistakes: MistakeRecord[] }).mistakes;

	it("scan counts without writing, then records, analyzes, and re-scanning adds nothing", async () => {
		const chat = chatStore.createChat("Ramp friction");
		chatStore.saveMessages(chat.id, [
			call("q1", "quiz", {}),
			result("q1", "quiz", answer({})),
			call("q2", "quiz", {}),
			result("q2", "quiz", answer({ dontKnow: true, answers: [], correct: false })),
		]);
		const dry = (await (await scan.POST(post({}))).json()) as { found: number };
		assert.equal(dry.found, 2);
		assert.equal((await stored()).length, 0, "counting writes nothing");

		const ok = { errorType: "setup-error", topic: "static friction on a ramp", whatYouDid: "You used mu N.", correct: "50 N: mg sin 30.", rule: "mu N is the ceiling." };
		server.analysisEngineOverride.current = analystEngine([submit(ok), submit({ ...ok, errorType: "knowledge-gap" })]);
		const res = (await (await scan.POST(post({ confirm: true }))).json()) as { added: number };
		assert.equal(res.added, 2);
		await until(() => server.analysisProgress().active === 0);
		const records = await stored();
		assert.equal(records.length, 2);
		assert.ok(records.every((r) => r.status === "ready" && r.analysis), "both analyzed");
		assert.deepEqual(records.map((r) => r.analysis!.errorType).sort(), ["knowledge-gap", "setup-error"]);

		const again = (await (await scan.POST(post({ confirm: true }))).json()) as { added: number; queued: number };
		assert.deepEqual([again.added, again.queued], [0, 0]);
		const mine = (await (await perChat.GET(new Request("http://x"), ctx(chat.id))).json()) as { mistakes: MistakeRecord[] };
		assert.equal(mine.mistakes.length, 2);
	});

	it("a failed analysis is kept with its error and can be retried; deleting removes it", async () => {
		const chat = chatStore.createChat("Second");
		chatStore.saveMessages(chat.id, [call("z1", "quiz", {}), result("z1", "quiz", answer({}))]);
		server.analysisEngineOverride.current = analystEngine([fauxAssistantMessage("I refuse to use the tool.")]);
		server.enqueueAnalyses(server.recordChatMistakes(chat.id));
		await until(() => server.analysisProgress().active === 0);
		const failed = (await stored()).find((r) => r.chatId === chat.id)!;
		assert.equal(failed.status, "failed");
		assert.ok(failed.error);

		server.analysisEngineOverride.current = analystEngine([submit({ errorType: "misread", topic: "t", whatYouDid: "w", correct: "c", rule: "r" })]);
		assert.equal((await retry.POST(new Request("http://x", { method: "POST" }), ctx(encodeURIComponent(failed.id)))).status, 200);
		await until(() => server.analysisProgress().active === 0);
		assert.equal((await stored()).find((r) => r.id === failed.id)!.status, "ready");

		assert.equal((await del.DELETE(new Request("http://x", { method: "DELETE" }), ctx(encodeURIComponent(failed.id)))).status, 200);
		assert.equal((await del.DELETE(new Request("http://x", { method: "DELETE" }), ctx(encodeURIComponent(failed.id)))).status, 404);
		server.analysisEngineOverride.current = undefined;
	});

	it("honors the opt-out and the rolling cost cap", async () => {
		const settingsStore = (await import("../src/store/settings.ts")).settingsStore;
		settingsStore.writeSettings({ version: 1, agent: { mistakeAnalysis: { auto: false } } });
		assert.equal(server.autoAnalysisEnabled(), false);
		assert.ok(server.analysesInLastDay() >= 1); // reads the stored attempts

		const chat = chatStore.createChat("Capped");
		chatStore.saveMessages(chat.id, [
			call("a", "quiz", {}),
			result("a", "quiz", answer({ questionText: "one" })),
			call("b", "quiz", {}),
			result("b", "quiz", answer({ questionText: "two" })),
		]);
		const already = server.analysesInLastDay();
		settingsStore.writeSettings({ version: 1, agent: { mistakeAnalysis: { auto: true, dailyCap: already + 1 } } });
		assert.equal(server.autoAnalysisEnabled(), true);
		const ok = { errorType: "setup-error", topic: "static friction", whatYouDid: "You used mu N.", correct: "It is 50 N.", rule: "mu N is the ceiling." };
		server.analysisEngineOverride.current = analystEngine([submit(ok)]);
		server.enqueueAnalyses(server.recordChatMistakes(chat.id));
		await until(() => server.analysisProgress().active === 0);
		const capped = (await stored()).filter((r) => r.chatId === chat.id);
		assert.equal(capped.length, 2);
		assert.deepEqual(capped.map((r) => r.status).sort(), ["failed", "ready"]);
		const blocked = capped.find((r) => r.status === "failed")!;
		assert.match(blocked.error ?? "", /Daily analysis limit/);

		// Raising the limit lets the tab's retry analyze the blocked one.
		settingsStore.writeSettings({ version: 1, agent: { mistakeAnalysis: { auto: true, dailyCap: 100 } } });
		server.analysisEngineOverride.current = analystEngine([submit(ok)]);
		server.retryMistake(blocked.id);
		await until(() => server.analysisProgress().active === 0);
		assert.equal((await stored()).find((r) => r.id === blocked.id)!.status, "ready");
		server.analysisEngineOverride.current = undefined;
	});
});
