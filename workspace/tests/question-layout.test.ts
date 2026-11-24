import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	WIDTH_STEP,
	curveHeight,
	curveWidths,
	heightCurve,
	solveColumns,
	solveQuestionLayout,
	stackedWidth,
	twoColumnTriggered,
	widthGrid,
	type ColumnSpec,
} from "../components/question-layout.ts";

/** A text-like column: a fixed amount of "area" wrapped at the width. */
function textColumn(area: number, opts: Partial<ColumnSpec> = {}): ColumnSpec {
	return {
		min: opts.min ?? 368,
		preferredMin: opts.preferredMin ?? opts.min ?? 368,
		max: opts.max ?? 600,
		height: (w) => Math.ceil(area / w / 24) * 24,
	};
}

describe("stacked width", () => {
	it("never goes below the default, widens for unbreakable content, caps at the transcript", () => {
		assert.equal(stackedWidth(702, 0, 1800), 702);
		assert.equal(stackedWidth(702, 900, 1800), 900);
		assert.equal(stackedWidth(702, 2400, 1800), 1800);
		// A narrow window: the container's own w-full shrink handles it.
		assert.equal(stackedWidth(702, 900, 500), 702);
	});
});

describe("two-column trigger", () => {
	it("question at least as tall as the answers (1px tolerance)", () => {
		assert.equal(twoColumnTriggered(300, 200), true);
		assert.equal(twoColumnTriggered(200, 200), true);
		assert.equal(twoColumnTriggered(199.5, 200), true);
		assert.equal(twoColumnTriggered(150, 200), false);
	});
});

describe("width grid", () => {
	it("ascends from min at the step and always includes max", () => {
		assert.deepEqual(widthGrid(368, 390, 8), [368, 376, 384, 390]);
		assert.deepEqual(widthGrid(400, 400, 8), [400]);
		assert.deepEqual(widthGrid(400, 300, 8), [400]);
	});
});

describe("two-column widths", () => {
	it("finds the lowest height, then narrows each column as far as that height allows", () => {
		// Answers: short options — their height is flat from the floor.
		const answer: ColumnSpec = { min: 368, preferredMin: 368, max: 600, height: () => 120 };
		const question = textColumn(600 * 24 * 20); // 20 lines at 600px
		const solved = solveColumns(question, answer, 1400)!;
		assert.ok(solved);
		// The question takes its useful maximum (lowest height); the answer
		// side stays at its floor because widening it cannot lower the card.
		assert.equal(solved.question, 600);
		assert.equal(solved.answer, 368);
		assert.equal(solved.height, 480);
	});

	it("narrows the question when the answers are the taller side at the optimum", () => {
		const answer: ColumnSpec = { min: 368, preferredMin: 368, max: 600, height: () => 400 };
		const question = textColumn(600 * 24 * 10); // 240px at 600, 400px+ only near 368
		const solved = solveColumns(question, answer, 1400)!;
		assert.equal(solved.height, 400);
		// Narrowest question width still within 400px: ceil(area/w/24)*24 <= 400 → 16 lines.
		assert.ok(question.height(solved.question) <= 400);
		assert.ok(question.height(solved.question - WIDTH_STEP) > 400 || solved.question === 368);
		assert.equal(solved.answer, 368);
	});

	it("evaluates few widths: each height is a real layout of the probe", () => {
		let calls = 0;
		const count = (spec: ColumnSpec): ColumnSpec => ({ ...spec, height: (w) => { calls++; return spec.height(w); } });
		solveColumns(count(textColumn(600 * 24 * 20)), count(textColumn(368 * 24 * 6)), 1100);
		assert.ok(calls <= 24, `${calls} height evaluations`);
	});

	it("respects the width budget and refuses when the floors cannot fit side by side", () => {
		const a = textColumn(100_000);
		const q = textColumn(500_000);
		const solved = solveColumns(q, a, 800)!;
		assert.ok(solved.question + solved.answer <= 800);
		assert.equal(solveColumns(q, a, 700), null);
	});

	it("unbreakable content raises a column's floor beyond 23rem", () => {
		const q = textColumn(400_000, { min: 700, max: 700 });
		const a = textColumn(50_000);
		assert.equal(solveColumns(q, a, 1000), null, "700 + 368 > 1000");
		const solved = solveColumns(q, a, 1100)!;
		assert.equal(solved.question, 700);
	});

	it("diagrams keep their natural width when it fits", () => {
		const q = textColumn(300_000, { min: 368, preferredMin: 900, max: 900 });
		const a = textColumn(40_000);
		assert.equal(solveColumns(q, a, 1400)!.question >= 900, true);
	});

	it("a question diagram that cannot keep its natural width takes all the width beside the answer minimum", () => {
		// A wide diagram: taller when wider, so the lowest height alone would shrink it.
		const q: ColumnSpec = { min: 368, preferredMin: 1090, max: 1090, height: (w) => 200 + w * 0.2 };
		const a = textColumn(40_000);
		const tight = solveColumns(q, a, 1262)!;
		assert.deepEqual(
			{ question: tight.question, answer: tight.answer, binding: tight.binding },
			{ question: 1262 - 368, answer: 368, binding: true },
		);
		assert.equal(tight.height, Math.max(q.height(894), a.height(368)));
		// The answer's own unbreakable minimum is kept.
		const wideAnswer = { ...a, min: 420, preferredMin: 420 };
		assert.equal(solveColumns(q, wideAnswer, 1262)!.question, 1262 - 420);
		// No room even for the question's hard floor beside the answer: no columns.
		assert.equal(solveColumns(q, a, 700), null);
	});
});

describe("question layout", () => {
	const answer: ColumnSpec = { min: 368, preferredMin: 368, max: 600, height: () => 120 };
	const question = textColumn(600 * 24 * 20);

	it("text-answer questions (no columns input) stay stacked", () => {
		assert.deepEqual(solveQuestionLayout({ available: 1400, base: 702, stackedNeed: 0 }), { kind: "stacked", width: 702, binding: false });
	});

	it("an untriggered question stays stacked; a triggered one that fits goes to columns", () => {
		assert.equal(solveQuestionLayout({ available: 1400, base: 702, stackedNeed: 0, columns: { triggered: false, question, answer } }).kind, "stacked");
		const layout = solveQuestionLayout({ available: 1400, base: 702, stackedNeed: 0, columns: { triggered: true, question, answer } });
		assert.equal(layout.kind, "columns");
		assert.equal(layout.width, 968);
	});

	it("a triggered question that cannot fit falls back to the stacked rule", () => {
		const layout = solveQuestionLayout({ available: 720, base: 702, stackedNeed: 710, columns: { triggered: true, question, answer } });
		assert.deepEqual(layout, { kind: "stacked", width: 710, binding: true });
	});
});

describe("reusing a solved layout", () => {
	const answer: ColumnSpec = { min: 368, preferredMin: 368, max: 600, height: () => 120 };
	const question = textColumn(600 * 24 * 20);

	it("marks results the budget limited", () => {
		const free = solveQuestionLayout({ available: 1400, base: 702, stackedNeed: 0, columns: { triggered: true, question, answer } });
		assert.equal(free.binding, false, "600 + 600 fit in 1400");
		const tight = solveQuestionLayout({ available: 1000, base: 702, stackedNeed: 0, columns: { triggered: true, question, answer } });
		assert.equal(tight.binding, true);
		assert.equal(solveQuestionLayout({ available: 1400, base: 702, stackedNeed: 900 }).binding, false);
		assert.equal(solveQuestionLayout({ available: 800, base: 702, stackedNeed: 900 }).binding, true);
	});

});

describe("height curves: measure once, decide by arithmetic", () => {
	const question = textColumn(600 * 24 * 20, { max: 700 });
	const answer: ColumnSpec = { min: 368, preferredMin: 368, max: 600, height: () => 120 };
	const curve = (c: ColumnSpec) => {
		let calls = 0;
		const widths = curveWidths(c.min, c.preferredMin, c.max);
		const heights = heightCurve(widths, (w) => { calls++; return c.height(w); });
		return { column: { min: c.min, preferredMin: c.preferredMin, max: c.max, widths, heights }, calls };
	};

	it("equals the measured height at every grid width, skipping flat stretches", () => {
		const q = curve(question);
		for (const [i, w] of q.column.widths.entries()) assert.equal(q.column.heights[i], question.height(w), `width ${w}`);
		assert.ok(q.calls < q.column.widths.length, `${q.calls} of ${q.column.widths.length} measured`);
		assert.equal(curve(answer).calls, 2, "a flat options column: both ends only");
	});

	it("between grid widths, reads the grid width below (never an underestimate)", () => {
		const { column } = curve(question);
		for (let w = column.min; w <= column.max; w++) assert.ok(curveHeight(column, w) >= question.height(w), `width ${w}`);
		assert.equal(curveHeight(column, column.max), question.height(column.max));
		assert.equal(curveHeight(column, column.min + WIDTH_STEP), question.height(column.min + WIDTH_STEP));
	});

	it("a diagram's natural width is a measured width too", () => {
		assert.deepEqual(curveWidths(368, 500, 560), [368, 384, 400, 416, 432, 448, 464, 480, 496, 500, 512, 528, 544, 560]);
		assert.deepEqual(curveWidths(368, 368, 400), [368, 384, 400]);
	});

	it("decides exactly as measuring every candidate width would, at every budget", () => {
		// Realistic questions (2–30 lines at the floor) beside flat or
		// wrapping options. The arithmetic decision compares only measured
		// heights, so it equals a solve that measures on demand at the same
		// candidate widths.
		const text = (lines: number, max: number): ColumnSpec => ({ min: 368, preferredMin: 368, max, height: (w) => Math.ceil((lines * 368) / w) * 24 });
		for (const lines of [2, 6, 12, 20, 30]) for (const answerLines of [0, 3, 10]) {
			const q = text(lines, 700);
			const a = answerLines ? text(answerLines, 600) : answer;
			const qc = curve(q).column;
			const ac = curve(a).column;
			const live = (c: ColumnSpec, m: typeof qc): ColumnSpec => ({ ...c, widths: m.widths });
			const cheap = (m: typeof qc): ColumnSpec => ({ ...m, height: (w) => curveHeight(m, w) });
			for (let available = 700; available <= 1500; available += 3) {
				const input = { available, base: 702, stackedNeed: 0 };
				const exact = solveQuestionLayout({ ...input, columns: { triggered: true, question: live(q, qc), answer: live(a, ac) } });
				const decided = solveQuestionLayout({ ...input, columns: { triggered: true, question: cheap(qc), answer: cheap(ac) } });
				assert.deepEqual(decided, exact, `${lines}/${answerLines} lines at ${available}`);
			}
		}
	});
});
