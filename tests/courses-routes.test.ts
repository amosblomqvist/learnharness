/**
 * The course routes end to end (courses plan, 2026-10-30): real routes,
 * real fs stores in a scratch LH_DATA_DIR, a faux planner engine through
 * the coursePlanner seam. Covers draft → regenerate → accept, lesson edits,
 * lesson session starts (marker + link), derived done-ness, both replan
 * modes, usage on EVERY run (failed ones too), and the store's version law.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-courses-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");

const coursesRoute = await import("../app/api/courses/route.ts");
const courseRoute = await import("../app/api/courses/[id]/route.ts");
const generateRoute = await import("../app/api/courses/[id]/generate/route.ts");
const replanRoute = await import("../app/api/courses/[id]/replan/route.ts");
const replanAcceptRoute = await import("../app/api/courses/[id]/replan/accept/route.ts");
const lessonsRoute = await import("../app/api/courses/[id]/lessons/route.ts");
const lessonRoute = await import("../app/api/courses/[id]/lessons/[lessonId]/route.ts");
const sessionsRoute = await import("../app/api/courses/[id]/lessons/[lessonId]/sessions/route.ts");
const { coursePlanner, stores } = await import("../src/server/index.ts");
const { localDate } = await import("../src/core/course-progress.ts");
const { CURRENT_COURSE_VERSION } = await import("../src/core/contracts.ts");
const { callMsg, resultMsg, tree, userMsg } = await import("./helpers/course-fixtures.ts");
import type { CourseView } from "../src/core/contracts.ts";
import type { PiEngine } from "../src/agent/models.ts";

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const day = (n: number) => {
	const d = new Date();
	d.setDate(d.getDate() + n);
	return localDate(d);
};
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
const json = (method: string, body?: unknown) =>
	new Request("http://localhost/api/courses", { method, ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });

// ── the faux planner ──
let queue: FauxResponseStep[] = [];
const seenPrompts: string[] = [];
function useFaux() {
	coursePlanner.resolveEngine = () => {
		const faux = createFauxCore({});
		faux.setResponses(
			queue.map((step) => (context, options, state, model) => {
				const first = context.messages.find((m) => m.role === "user") as { content: string | Array<{ text?: string }> } | undefined;
				if (first) seenPrompts.push(typeof first.content === "string" ? first.content : first.content.map((c) => c.text ?? "").join(""));
				return typeof step === "function" ? step(context, options, state, model) : step;
			}),
		);
		return { model: faux.getModel(), streamFn: faux.streamSimple } as unknown as PiEngine;
	};
}
const submit = (course: unknown) => fauxAssistantMessage([fauxToolCall("submit_course", course as never)], { stopReason: "toolUse" });
const L = (id: string, extra: Record<string, unknown> = {}) => ({
	id, title: `Lesson ${id}`, goal: `Understand ${id}`, guideSummary: `About ${id}`, prerequisites: [], targetDate: day(3), predictedNodes: 2, ...extra,
});
const course = (lessons: unknown[], extra: Record<string, unknown> = {}) => ({ title: "Calculus basics", goal: "Use derivatives", feasibility: "Fits in ~2 h/week.", lessons, ...extra });

let id = "";
let view: CourseView;

describe("course routes", () => {
	before(() => {
		queue = [];
	});

	it("refuses with the 503 models envelope when no strong slot is configured — and creates nothing", async () => {
		const res = await coursesRoute.POST(json("POST", { guideText: "# G", deadline: day(10) }));
		assert.equal(res.status, 503);
		assert.equal((await res.json()).code, "models_not_configured");
		assert.equal(stores.courseStore.listCourses().length, 0);
	});

	it("validates the guide and the deadline", async () => {
		useFaux();
		assert.equal((await coursesRoute.POST(json("POST", { guideText: "  ", deadline: day(10) }))).status, 400);
		assert.equal((await coursesRoute.POST(json("POST", { guideText: "# G", deadline: day(-1) }))).status, 400);
		const form = new FormData();
		form.set("file", new File(["x"], "guide.pdf"));
		form.set("deadline", day(10));
		assert.equal((await coursesRoute.POST(new Request("http://localhost/api/courses", { method: "POST", body: form }))).status, 400);
	});

	it("Generate (multipart upload) creates a DRAFT with an inferred goal and its usage", async () => {
		queue = [submit(course([L("limits"), L("derivative", { prerequisites: ["limits"], targetDate: day(6), multiplier: 1.5, multiplierReason: "proof-heavy" })]))];
		const form = new FormData();
		form.set("file", new File(["# Calculus\n## Limits\n## Derivatives"], "calculus.md"));
		form.set("goal", "");
		form.set("deadline", day(14));
		form.set("availabilityNotes", "weekends");
		const res = await coursesRoute.POST(new Request("http://localhost/api/courses", { method: "POST", body: form }));
		assert.equal(res.status, 200);
		view = await res.json();
		id = view.id;
		assert.equal(view.status, "draft");
		assert.equal(view.goal, "Use derivatives");
		assert.equal(view.goalInferred, true);
		assert.equal(view.guide.fileName, "calculus.md");
		assert.deepEqual(view.lessons.map((l) => l.id), ["limits", "derivative"]);
		// Cold start: (10 + 2 × 8) = 26; × 1.5 = 39.
		assert.equal(view.lessons[0]!.estimate.minutes, 26);
		assert.equal(view.lessons[1]!.estimate.minutes, 39);
		assert.equal(stores.courseStore.getCourse(id)!.usage.length, 1);
		assert.match(seenPrompts.at(-1)!, /<guide>\n# Calculus/);
		const list = await (await coursesRoute.GET()).json();
		assert.deepEqual(list.courses.map((c: { id: string; status: string }) => [c.id, c.status]), [[id, "draft"]]);
	});

	it("Regenerate with feedback sees the previous draft; the retry's steps land in ONE usage run", async () => {
		queue = [
			submit(course([L("limits", { targetDate: day(99) })])), // outside the deadline → error-back
			submit(course([L("limits"), L("derivative", { prerequisites: ["limits"], targetDate: day(5) }), L("chain-rule", { prerequisites: ["derivative"], targetDate: day(8) })])),
		];
		const res = await generateRoute.POST(json("POST", { feedback: "add the chain rule" }), ctx({ id }));
		assert.equal(res.status, 200);
		view = await res.json();
		assert.equal(view.lessons.length, 3);
		assert.match(seenPrompts.at(-1)!, /Your previous draft/);
		assert.match(seenPrompts.at(-1)!, /Learner's feedback: add the chain rule/);
		const usage = stores.courseStore.getCourse(id)!.usage;
		assert.deepEqual(usage.map((u) => [u.kind, u.steps.length]), [["generate", 1], ["regenerate", 2]]);
	});

	it("a draft can't start lessons or replan; Accept makes it active", async () => {
		assert.equal((await sessionsRoute.POST(json("POST"), ctx({ id, lessonId: "limits" }))).status, 409);
		assert.equal((await replanRoute.POST(json("POST", {}), ctx({ id }))).status, 409);
		const res = await courseRoute.PATCH(json("PATCH", { status: "active" }), ctx({ id }));
		view = await res.json();
		assert.equal(view.status, "active");
		assert.equal(view.health, "on-track");
	});

	it("hand edits: cycles refused, predictedNodes drive minutes, added lessons state everything", async () => {
		let res = await lessonRoute.PATCH(json("PATCH", { prerequisites: ["chain-rule"] }), ctx({ id, lessonId: "limits" }));
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, /cycle/);
		res = await lessonRoute.PATCH(json("PATCH", { predictedNodes: 4, title: "Limits, gently" }), ctx({ id, lessonId: "limits" }));
		view = await res.json();
		const limits = view.lessons.find((l) => l.id === "limits")!;
		assert.equal(limits.title, "Limits, gently");
		assert.equal(limits.estimate.minutes, 10 + 4 * 8);
		assert.equal((await lessonsRoute.POST(json("POST", { title: "Extra", targetDate: day(9), predictedNodes: 2 }), ctx({ id }))).status, 400, "goal required");
		res = await lessonsRoute.POST(json("POST", { title: "Extra practice", goal: "Drill", targetDate: day(9), predictedNodes: 2, prerequisites: ["chain-rule"] }), ctx({ id }));
		view = await res.json();
		assert.ok(view.lessons.some((l) => l.id === "extra-practice" && l.prerequisites[0] === "chain-rule"));
		res = await courseRoute.PATCH(json("PATCH", { goal: "Pass the exam" }), ctx({ id }));
		view = await res.json();
		assert.equal(view.goalInferred, false);
	});

	it("Start lesson: the chat carries the course-lesson marker and links back; done-ness derives from it", async () => {
		const res = await sessionsRoute.POST(json("POST"), ctx({ id, lessonId: "limits" }));
		const { chatId, openingPrompt } = await res.json();
		assert.equal(openingPrompt, "Understand limits");
		const chat = stores.chatStore.getChat(chatId)!;
		const marker = chat.messages[0] as { role: string; customType: string; content: string };
		assert.equal(marker.role, "custom");
		assert.equal(marker.customType, "course-lesson");
		assert.match(marker.content, /^\[Session context\] — this session is one lesson of the learner's course "Calculus basics" \(course goal: Pass the exam\)\./);
		assert.match(marker.content, /Leads into: Lesson derivative/);
		view = await (await courseRoute.GET(json("GET"), ctx({ id }))).json();
		assert.equal(view.lessons.find((l) => l.id === "limits")!.status, "in-progress");

		const t = Date.now();
		stores.chatStore.saveMessages(chatId, [
			...chat.messages,
			userMsg(t),
			callMsg(t + 1000, "probe_done", {}, "p1"),
			resultMsg(t + 2000, "p1", "probe_done"),
			callMsg(t + 3000, "quiz", { nodeId: "n1" }, "q1"),
			resultMsg(t + 4000, "q1", "quiz", { details: {} }),
		]);
		stores.chatStore.saveTree(chatId, tree("n1"));
		view = await (await courseRoute.GET(json("GET"), ctx({ id }))).json();
		assert.equal(view.lessons.find((l) => l.id === "limits")!.status, "done");
		assert.equal(view.doneCount, 1);
	});

	it("Replan without feedback: dates/estimates only, done lessons untouched; accept applies it", async () => {
		const remaining = view.lessons.filter((l) => l.status !== "done");
		const keep = (l: CourseView["lessons"][number], extra: Record<string, unknown> = {}) => ({
			id: l.id, title: l.title, goal: l.goal, guideSummary: l.guideSummary, prerequisites: l.prerequisites, targetDate: l.targetDate, predictedNodes: l.predictedNodes, ...extra,
		});
		queue = [
			submit(course(remaining.map((l) => keep(l, { title: "sneaky rename" })))), // structure change without feedback → error-back
			submit(course(remaining.map((l) => keep(l, { targetDate: day(10) })))),
		];
		let res = await replanRoute.POST(json("POST", {}), ctx({ id }));
		assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
		view = await res.json();
		assert.ok(view.pendingReplan);
		assert.ok(view.pendingReplan.lessons.every((l) => l.targetDate === day(10)));
		assert.match(seenPrompts.at(-1)!, /Lessons already done/);
		res = await replanAcceptRoute.POST(json("POST"), ctx({ id }));
		view = await res.json();
		assert.equal(view.pendingReplan, undefined);
		assert.equal(view.lessons.find((l) => l.id === "limits")!.status, "done");
		assert.ok(view.lessons.filter((l) => l.id !== "limits").every((l) => l.targetDate === day(10)));
	});

	it("Replan with feedback may restructure; discard leaves the course untouched", async () => {
		queue = [submit(course([L("derivative", { prerequisites: ["limits"], targetDate: day(4) }), L("review", { prerequisites: ["derivative"], targetDate: day(12) })]))];
		let res = await replanRoute.POST(json("POST", { feedback: "merge the rest into one review" }), ctx({ id }));
		view = await res.json();
		assert.deepEqual(view.pendingReplan!.lessons.map((l) => l.id), ["derivative", "review"]);
		res = await replanRoute.DELETE(json("DELETE"), ctx({ id }));
		view = await res.json();
		assert.equal(view.pendingReplan, undefined);
		assert.ok(view.lessons.some((l) => l.id === "chain-rule"));
	});

	it("a failed run (never submits) is a 502 — and its usage is still recorded", async () => {
		const before = stores.courseStore.getCourse(id)!.usage.length;
		queue = [fauxAssistantMessage("I won't submit.")];
		const res = await replanRoute.POST(json("POST", {}), ctx({ id }));
		assert.equal(res.status, 502);
		assert.equal(stores.courseStore.getCourse(id)!.usage.length, before + 1);
		view = await (await courseRoute.GET(json("GET"), ctx({ id }))).json();
		assert.equal(view.cost.runs, before + 1);
	});

	it("deleting a lesson drops it from prerequisites; deleting the course keeps its sessions", async () => {
		const res = await lessonRoute.DELETE(json("DELETE"), ctx({ id, lessonId: "chain-rule" }));
		view = await res.json();
		assert.ok(view.lessons.every((l) => !l.prerequisites.includes("chain-rule")));
		const sessionId = view.lessons.find((l) => l.id === "limits")!.sessionIds[0]!;
		assert.equal((await courseRoute.DELETE(json("DELETE"), ctx({ id }))).status, 200);
		assert.equal((await courseRoute.GET(json("GET"), ctx({ id }))).status, 404);
		assert.ok(stores.chatStore.getChat(sessionId), "the lesson's session survives");
	});

	it("the planner gets the prober's map tools only while the graph-tools gate is open", async () => {
		const probe = async () => {
			let toolError: boolean | undefined;
			queue = [
				fauxAssistantMessage([fauxToolCall("list_sessions", {})], { stopReason: "toolUse" }),
				(context) => {
					toolError = (context.messages.at(-1) as { isError?: boolean }).isError;
					return submit(course([L("only")]));
				},
			];
			const res = await coursesRoute.POST(json("POST", { guideText: "# G", deadline: day(5) }));
			assert.equal(res.status, 200);
			return toolError;
		};
		assert.equal(await probe(), false, "gate open (factory default): list_sessions runs");
		stores.settingsStore.writeSettings({ version: 1, graph: { enabled: false } });
		assert.equal(await probe(), true, "gate closed: the tool does not exist");
		stores.settingsStore.writeSettings({ version: 1 });
	});

	it("the store refuses a record stamped newer than this build", () => {
		const rec = stores.courseStore.createCourse({
			title: "x", status: "draft", guide: { text: "g" }, goalInput: "", goal: "", goalInferred: true, deadline: day(1),
			availabilityNotes: "", lessons: [], feasibility: "", pace: view.pace, usage: [],
		});
		const file = path.join(scratch, "courses", `${rec.id}.json`);
		assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).version, CURRENT_COURSE_VERSION);
		fs.writeFileSync(file, JSON.stringify({ ...rec, version: CURRENT_COURSE_VERSION + 1 }));
		assert.equal(stores.courseStore.getCourse(rec.id), null);
	});
});
