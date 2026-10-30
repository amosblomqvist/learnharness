import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeMs, computePace, IDLE_GAP_MS, lessonMinutes, lessonMinutesBreakdown, paceLine, sessionPaceSamples } from "../src/core/pace.ts";
import { MIN, teachSession, userMsg } from "./helpers/course-fixtures.ts";

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

describe("learned pace", () => {
	it("activeMs drops gaps longer than 10 minutes entirely", () => {
		assert.equal(activeMs([0, 5 * MIN, 5 * MIN + IDLE_GAP_MS, 5 * MIN + IDLE_GAP_MS + IDLE_GAP_MS + 1]), 5 * MIN + IDLE_GAP_MS);
	});

	it("samples: probe overhead and per-node run minutes; the open final run is dropped", () => {
		const s = sessionPaceSamples(teachSession({ probeMinutes: 4, nodes: [["a", 3], ["b", 6]], answerLast: false }));
		assert.ok(s);
		close(s.overheadMinutes, 4);
		assert.deepEqual(s.nodeMinutes, [3]);
	});

	it("samples: the answered final run counts; revisits sum per node", () => {
		const s = sessionPaceSamples(teachSession({ probeMinutes: 2, nodes: [["a", 3], ["b", 2], ["a", 4]] }));
		assert.ok(s);
		assert.deepEqual([...s.nodeMinutes].sort(), [2, 7]);
	});

	it("a break inside a run contributes nothing", () => {
		const s = sessionPaceSamples(teachSession({ probeMinutes: 2, nodes: [["a", 30], ["b", 2]] }));
		assert.ok(s);
		assert.deepEqual(s.nodeMinutes, [0, 2], "a's 30-minute gap is a break");
	});

	it("sessions that never reached teaching, or practice sessions, give no samples", () => {
		assert.equal(sessionPaceSamples({ messages: [userMsg(0), userMsg(MIN)] }), null);
		assert.equal(sessionPaceSamples({ ...teachSession({ probeMinutes: 1, nodes: [["a", 1]] }), kind: "practice" }), null);
	});

	it("cold start = the defaults; history blends in with weights W", () => {
		const now = new Date(Date.UTC(2026, 9, 30));
		const cold = computePace([], now);
		assert.equal(cold.nodeMinutes, 8);
		assert.equal(cold.overheadMinutes, 10);
		assert.equal(cold.measuredNodes, 0);
		// One session: overhead 4, nodes 2 + 6 → node pace (80 + 8) / 12, overhead (50 + 4) / 6.
		const pace = computePace([teachSession({ probeMinutes: 4, nodes: [["a", 2], ["b", 6]] })], now);
		assert.equal(pace.nodeMinutes, Math.round((88 / 12) * 10) / 10);
		assert.equal(pace.overheadMinutes, 9);
		assert.equal(pace.measuredNodes, 2);
		assert.equal(pace.measuredSessions, 1);
	});

	it("cadence: active minutes per week and study days over the last 28 days", () => {
		const now = new Date(Date.UTC(2026, 9, 30, 23));
		const recent = teachSession({ t0: Date.UTC(2026, 9, 20, 12), probeMinutes: 8, nodes: [["a", 4]] });
		const old = teachSession({ t0: Date.UTC(2026, 7, 1, 12), probeMinutes: 8, nodes: [["a", 4]] });
		const pace = computePace([recent, old], now);
		assert.equal(pace.weeklyMinutes, Math.round(12 / 4));
		assert.equal(pace.studyDaysPerWeek, 0.3);
	});

	it("lesson minutes: (overhead + nodes × pace) × multiplier, with a readable breakdown", () => {
		const pace = { ...computePace([]), nodeMinutes: 7, overheadMinutes: 12 };
		const m = lessonMinutes({ predictedNodes: 3, multiplier: 1.3, multiplierReason: "math-heavy" }, pace);
		assert.equal(m.baselineMinutes, 33);
		assert.equal(m.minutes, 43);
		assert.equal(lessonMinutesBreakdown(m), "3 nodes × 7 + 12 = 33 min × 1.3 (math-heavy) ≈ 43 min");
		assert.equal(lessonMinutesBreakdown(lessonMinutes({ predictedNodes: 1, multiplier: 1 }, pace)), "1 node × 7 + 12 = 19 min");
		assert.match(paceLine(computePace([])), /default pace — no teaching history yet/);
	});
});
