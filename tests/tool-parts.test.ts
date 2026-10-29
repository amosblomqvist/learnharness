/**
 * Unit tests — the UI parse seam (src/core/tool-parts.ts).
 *
 * The rule born of the 2026-09-12 live crashes: model-authored tool input
 * is consumed only through these parsers, each running the SAME zod schema
 * the model faced at the boundary. These pins hold the two exact live
 * crash shapes (the model's double-encoding habit) and the boundary-parity
 * property: anything a boundary schema accepts, the display parse accepts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { quizInputProblems } from "../src/core/question-core.ts";
import { Value } from "typebox/value";
import { repairMathForDisplay, restoreMathEscapes } from "../src/core/math-delims.ts";
import {
	parseAskInput,
	parseProbeDoneInput,
	parseQuizInput,
	parseExplainInput,
} from "../src/core/tool-parts.ts";
import { quizInputSchema, probeQuizInputSchema } from "../src/core/question-core.ts";
import { probeDoneInputSchema } from "../src/core/contracts/probe.ts";

const TEACHER_QUIZ = {
	question: "What does Tarski's convention-T define?",
	options: [
		{ label: "Truth for a language", value: "truth" },
		{ label: "Provability", value: "provability" },
	],
	correctAnswer: "truth",
	explanation: "Convention-T schematizes truth for the object language.",
	type: "check", // teach-only role field — the display parse KEEPS it (the dock gates by it)
	nodeId: "convention-t", // teacher-only field — the display parse must accept and strip it
};

const PROBER_QUIZ = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
};

const VALID_ASSESSMENT = {
	assessment: {
		strands: [
			{ strand: "modal logic basics", assessment: "Floor: solid intuition; ceiling: notation." },
			{ strand: "indexical 'actual'", assessment: "Genuine floor — prior exposure likely." },
		],
		summary: "Bracketed: teach the symbols on the intuition he has.",
	},
};

describe("parseQuizInput", () => {
	it("parses a boundary-valid TEACHER quiz and strips the teacher-only nodeId", () => {
		const parsed = parseQuizInput(TEACHER_QUIZ);
		assert.ok(parsed);
		assert.equal(parsed.question, TEACHER_QUIZ.question);
		assert.equal((parsed as Record<string, unknown>).nodeId, undefined, "unknown keys are stripped, not trusted");
		assert.equal((parsed as { type?: unknown }).type, "check", "the role field survives the display parse (owner 2026-10-03)");
	});

	it("parses a boundary-valid PROBER quiz (no nodeId at all)", () => {
		assert.ok(parseQuizInput(PROBER_QUIZ));
	});

	it("boundary parity: anything the TEACH schema accepts, the display parse accepts", () => {
		assert.ok(Value.Check(quizInputSchema, TEACHER_QUIZ), "fixture must be boundary-valid for this pin to mean anything");
		assert.ok(parseQuizInput(TEACHER_QUIZ));
	});

	it("boundary parity: anything the PROBE schema accepts, the display parse accepts", () => {
		assert.ok(Value.Check(probeQuizInputSchema, PROBER_QUIZ));
		assert.ok(parseQuizInput(PROBER_QUIZ));
	});

	it("boundary parity: the 2026-09-26 string-options shape heals on read (universal-heal mirror, 2026-10-09)", () => {
		// The boundary now heals a JSON-encoded options string at EVERY
		// registry (healToolRecord, owner 2026-10-09 — the bare-quiz sets
		// carried no prepareArguments at all), and the record keeps the RAW
		// args — so the display parse heals the same shape, per this file's
		// own parity law: anything the boundary accepts, the display parse
		// accepts, or the posed quiz renders nowhere while the turn has
		// ended = learner lockout.
		const stringified = { ...PROBER_QUIZ, options: JSON.stringify(PROBER_QUIZ.options) };
		const parsed = parseQuizInput(stringified);
		assert.ok(parsed, "the healed-at-boundary record must parse on read");
		assert.deepEqual(parsed.options, PROBER_QUIZ.options);
	});

	it("boundary parity under Value.Convert: a NUMERIC correctAnswer parses (live-smoke lockout fix, 2026-09-26)", () => {
		// The live smoke's model emitted correctAnswer: 17 (number). pi's
		// boundary runs Value.Convert before Value.Check, so the quiz posed
		// — but the record keeps the RAW args. A parse seam without Convert
		// would reject exactly what the boundary accepted: the pending quiz
		// renders nowhere while the turn has ended = learner lockout.
		// Dock-visible parity case: the smoke's real emission — options whose
		// values ARE the numbers, correctAnswer numeric. Convert → "17",
		// refinement passes (it matches an option), the quiz parses.
		const numeric = {
			question: "What is 5 + 3 × 4?",
			options: [
				{ label: "17", value: "17" },
				{ label: "27", value: "27" },
				{ label: "9", value: "9" },
			],
			explanation: "Multiplication first.",
			correctAnswer: 17,
		};
		const parsed = parseQuizInput(numeric);
		assert.ok(parsed);
		assert.equal(parsed.correctAnswer, "17", "converted to the string the boundary saw");
		const numericArray = { ...numeric, multiSelect: true, correctAnswer: [17, "27"] };
		const parsedArray = parseQuizInput(numericArray);
		assert.ok(parsedArray);
		assert.deepEqual(parsedArray.correctAnswer, ["17", "27"]);
		// Non-convertible garbage still never parses (structure owns it)…
		assert.equal(parseQuizInput({ ...PROBER_QUIZ, correctAnswer: { bad: true } }), undefined);
		// …and Convert's widening (undefined → "") is caught by the refinement
		// chain the boundary itself uses — garbage renders as a quiet fallback.
		const widened = { ...PROBER_QUIZ, correctAnswer: undefined };
		assert.equal(parseQuizInput(widened), undefined, "the refinement owns the reject");
	});

	it("garbage never parses: non-object, missing question, missing correctAnswer", () => {
		assert.equal(parseQuizInput("a string"), undefined);
		assert.equal(parseQuizInput({ options: [] }), undefined);
		assert.equal(parseQuizInput({ ...PROBER_QUIZ, correctAnswer: undefined }), undefined);
	});
});

describe("parseAskInput", () => {
	it("parses free-text mode (no options) and option mode", () => {
		assert.ok(parseAskInput({ question: "What do you want to learn?" }));
		assert.ok(parseAskInput({ question: "Which topics?", options: [{ label: "Physics" }, { label: "Logic" }], multiSelect: true }));
	});

	it("the live crash shape — stringified options — does not parse", () => {
		assert.equal(parseAskInput({ question: "q", options: "[]" }), undefined);
	});
});

describe("parseProbeDoneInput", () => {
	it("parses the valid assessment", () => {
		const parsed = parseProbeDoneInput(VALID_ASSESSMENT);
		assert.ok(parsed);
		assert.equal(parsed.assessment.strands.length, 2);
		assert.equal(parsed.assessment.summary, "Bracketed: teach the symbols on the intuition he has.");
	});

	it("boundary parity: anything the tool schema accepts, the display parse accepts", () => {
		assert.ok(Value.Check(probeDoneInputSchema, VALID_ASSESSMENT));
		assert.ok(parseProbeDoneInput(VALID_ASSESSMENT));
	});

	it("the live crash shape — assessment STRINGIFIED — does not parse", () => {
		// The exact double-encoding from the modal-realism run: strands died
		// on `.map` because the card cast the shape. The parse kills the class.
		const stringified = { assessment: JSON.stringify(VALID_ASSESSMENT.assessment) };
		assert.equal(parseProbeDoneInput(stringified), undefined);
		const garbage = JSON.stringify(VALID_ASSESSMENT.assessment).slice(0, 30);
		assert.equal(parseProbeDoneInput(garbage), undefined);
	});

	it("a mid-stream partial (no strands yet) does not parse", () => {
		assert.equal(parseProbeDoneInput({ assessment: { summary: "…" } }), undefined);
	});
});
describe("LaTeX-escape restoration (the JSON-debris fix, owner ruling 2026-09-26)", () => {
	// The exact live shapes from the modal-logic session: single-backslash
	// LaTeX inside JSON args — JSON escape resolution ate the command's
	// first letter (\f → FF ate 'f' of \forall, \v → VT ate 'v' of \varphi).
	it("presentation restores debris from parsed source fields (question + options + explanation)", () => {
		const parsed = parseQuizInput({
			question: "What does \\(\\forall x\\, \\varphi(x)\\) mean?",
			options: [
				{ label: "\\(\x0barphi\\) is true when every element satisfies it", value: "tarski" },
				{ label: "\\(\x0corall\\) and \\(\\exists\\) are just shorthand", value: "shorthand" },
			],
			correctAnswer: "tarski",
			explanation: "\\(\x0corall\\) quantifies over the domain.",
		});
		assert.ok(parsed);
		assert.equal(parsed.question, "What does \\(\\forall x\\, \\varphi(x)\\) mean?");
		assert.equal(repairMathForDisplay(parsed.options[0]!.label), "\\(\\varphi\\) is true when every element satisfies it");
		assert.equal(repairMathForDisplay(parsed.options[1]!.label), "\\(\\forall\\) and \\(\\exists\\) are just shorthand");
		assert.equal(repairMathForDisplay(parsed.explanation), "\\(\\forall\\) quantifies over the domain.");
	});

	it("presentation restores debris from parsed ask option labels too", () => {
		const parsed = parseAskInput({
			question: "Goal?",
			options: [{ label: "\\(\x0corall\\) rigor" }, { label: "Intuition first" }],
		});
		assert.ok(parsed);
		assert.equal(repairMathForDisplay(parsed.options![0]!.label), "\\(\\forall\\) rigor");
	});

	it("restores TAB debris (the \\to case) inside spans only", () => {
		const parsed = parseQuizInput({
			question: "Is \\(p\to q\\) valid?",
			options: [{ label: "yes" }, { label: "no" }],
			correctAnswer: "no",
			explanation: "",
		});
		assert.ok(parsed);
		assert.equal(repairMathForDisplay(parsed.question), "Is \\(p\\to q\\) valid?");
	});

	it("control chars OUTSIDE math spans are left alone (real prose/pasted text)", () => {
		const parsed = parseQuizInput({
			question: "Pick:\ta\x0bb",
			options: [{ label: "x" }, { label: "y" }],
			correctAnswer: "x",
			explanation: "",
		});
		assert.ok(parsed);
		assert.equal(parsed.question, "Pick:\ta\x0bb");
	});

	it("unbalanced delimiters pass through untouched (mid-stream safety)", () => {
		const parsed = parseQuizInput({
			question: "\\(\\x0corall",
			options: [{ label: "x" }, { label: "y" }],
			correctAnswer: "x",
			explanation: "",
		});
		assert.ok(parsed);
		assert.equal(parsed.question, "\\(\\x0corall");
	});
});

describe("display-math newline rule (Option A, owner ruling 2026-09-27)", () => {
	// TS literal below: \\[ is \[, \\forall is intact \forall, \n is a REAL newline, \\\\ is the LaTeX \\ line break.
	const MULTILINE = "Compare:\n\\[\n\\forall x, & f(x) = x^2 \\\\\n& g(x) = x^3\n\\]";

	it("real newlines inside display math are kept — multi-line equations pass through untouched", () => {
		const parsed = parseQuizInput({
			question: MULTILINE,
			options: [{ label: "f grows slower" }, { label: "g grows slower" }],
			correctAnswer: "f grows slower",
			explanation: "",
		});
		assert.ok(parsed);
		assert.equal(parsed.question, MULTILINE);
	});

	it("non-newline debris inside display math still restores (the \\right CR case)", () => {
		const parsed = parseQuizInput({
			question: "Evaluate \\[\\left( a \right)\\] carefully.",
			options: [{ label: "a" }, { label: "not a" }],
			correctAnswer: "a",
			explanation: "",
		});
		assert.ok(parsed);
		assert.equal(repairMathForDisplay(parsed.question), "Evaluate \\[\\left( a \\right)\\] carefully.");
	});

	it("sloppy \\neq in display math stays broken — the accepted cost (newline kept, byte-identical to a real line break)", () => {
		const debris = "Is \\[p \neq q\\] valid?";
		const parsed = parseQuizInput({
			question: debris,
			options: [{ label: "yes" }, { label: "no" }],
			correctAnswer: "no",
			explanation: "",
		});
		assert.ok(parsed);
		assert.equal(parsed.question, debris);
	});

	it("inline spans still restore newline debris (inline math is single-line by nature)", () => {
		const parsed = parseQuizInput({
			question: "Is \\(p \neq q\\) valid?",
			options: [{ label: "yes" }, { label: "no" }],
			correctAnswer: "no",
			explanation: "",
		});
		assert.ok(parsed);
		assert.equal(repairMathForDisplay(parsed.question), "Is \\(p \\neq q\\) valid?");
	});
});

describe("dollar-delimiter recognition — existing escape restoration rules", () => {
	it("restores question, option, and explanation debris in dollar math", () => {
		const parsed = parseQuizInput({
			question: "What does $\x0corall x$ mean?",
			options: [{ label: "$\x0barphi$ holds", value: "yes" }, { label: "No", value: "no" }],
			correctAnswer: "yes",
			explanation: "Here $p\to q$ is an implication.",
		});
		assert.ok(parsed);
		assert.equal(repairMathForDisplay(parsed.question), "What does $\\forall x$ mean?");
		assert.equal(repairMathForDisplay(parsed.options[0]!.label), "$\\varphi$ holds");
		assert.equal(repairMathForDisplay(parsed.explanation), "Here $p\\to q$ is an implication.");
	});

	it("keeps the same six-character inline recovery map", () => {
		for (const [debris, command] of [
			["\beta", "\\beta"], ["\to", "\\to"], ["\neq", "\\neq"],
			["\x0barphi", "\\varphi"], ["\x0corall", "\\forall"], ["\rho", "\\rho"],
		]) {
			assert.equal(restoreMathEscapes(`$${debris}$`), `$${command}$`);
		}
	});

	it("preserves display newlines and real LaTeX row breaks", () => {
		const math = "Compare:\n$$\n\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}\n$$";
		assert.equal(restoreMathEscapes(math), math);
	});

	it("restores five display debris characters but keeps newline ambiguity unchanged", () => {
		for (const [debris, command] of [
			["\beta", "\\beta"], ["\to", "\\to"], ["\x0barphi", "\\varphi"],
			["\x0corall", "\\forall"], ["\\left(x \right)", "\\left(x \\right)"],
		]) {
			assert.equal(
				restoreMathEscapes(`Compare:\n$$\n${debris}, p \neq q\n$$`),
				`Compare:\n$$\n${command}, p \neq q\n$$`,
			);
		}
	});

	it("restores all debris in one pass consistently across delimiter syntaxes", () => {
		const body = "p\to q, \rho";
		const legacy = restoreMathEscapes(`\\(${body}\\)`).slice(2, -2);
		assert.equal(restoreMathEscapes(`$${body}$`), `$${legacy}$`);
		assert.equal(legacy, "p\\to q, \\rho", "recovery converges instead of requiring a second render");
	});

	it("shares dollar recovery with ask and free-recall fields", () => {
		const ask = parseAskInput({ question: "Goal?", options: [{ label: "$\x0corall$ rigor" }, { label: "Intuition" }] });
		assert.ok(ask);
		assert.equal(repairMathForDisplay(ask.options![0]!.label), "$\\forall$ rigor");
		const explain = parseExplainInput({ question: "Explain $p\to q$", correctAnswer: "$p\neq q$ is different." });
		assert.ok(explain);
		assert.equal(repairMathForDisplay(explain.question), "Explain $p\\to q$");
		assert.equal(repairMathForDisplay(explain.correctAnswer), "$p\\neq q$ is different.");
	});

	it("leaves non-math debris, escaped opening dollars, and code examples untouched", () => {
		const prose = "Pasted:\t\x0cb. \\$\x0corall x$. A good $x$.";
		assert.equal(restoreMathEscapes(prose), prose);
		const code = "Literal `$\x0corall x$`.\n\n```text\n$\x0barphi$\n```\n\nReal $\x0corall x$.";
		assert.equal(restoreMathEscapes(code), code.replace("Real $\x0corall x$", "Real $\\forall x$"));
	});

	it("leaves unbalanced and mismatched delimiter runs untouched", () => {
		for (const text of ["$\x0corall", "$$\n\x0corall x\n", "$\x0corall$$", "$$\x0corall$"]) {
			assert.equal(restoreMathEscapes(text), text);
		}
	});

	it("recognizes native inline runs and longer display closing fences", () => {
		assert.equal(restoreMathEscapes("Inline $$p\neq q$$."), "Inline $$p\\neq q$$.");
		assert.equal(restoreMathEscapes("$$\n\x0corall x\n$$$"), "$$\n\\forall x\n$$$");
	});

	it("does not add an over-escaping repair or reprocess legacy spans", () => {
		const overescaped = "$$\n\\\\Omega\n$$";
		assert.equal(restoreMathEscapes(overescaped), overescaped);
		const legacy = "\\[\np $a\neq b$\n\\]";
		assert.equal(restoreMathEscapes(legacy), legacy);
	});
});

// ─── parseExplainInput (free-recall display parse, owner 2026-09-27) ───────

describe("parseExplainInput: the dock's display seam for explain calls", () => {
	const good = {
		question: "Explain why Mercury is hard to observe.",
		correctAnswer: "Its small angular separation from the Sun — it never strays far from the Sun in our sky.",
		nodeId: "planet-order", // the teacher's field — STRIPPED by Clean, like quiz
		details: "Think about where it appears at dusk.",
	};

	it("parses a valid call and strips the teacher-only nodeId", () => {
		const parsed = parseExplainInput(good)!;
		assert.equal(parsed.question, "Explain why Mercury is hard to observe.");
		assert.equal(parsed.correctAnswer, "Its small angular separation from the Sun — it never strays far from the Sun in our sky.");
		assert.equal(parsed.details, "Think about where it appears at dusk.");
		assert.ok(!("nodeId" in parsed), "the teacher-only key is cleaned away");
	});

	it("an empty commitment never arms the dock", () => {
		assert.equal(parseExplainInput({ ...good, correctAnswer: "  " }), undefined);
	});

	it("restores LaTeX escape debris inside math spans (the pi-ai streaming wobble)", () => {
		// \f of \forall was eaten by the lenient args parse: U+000C + "orall".
		const dirty = "Because \(orall x\) holds.";
		const parsed = parseExplainInput({ ...good, correctAnswer: dirty })!;
		assert.equal(parsed.correctAnswer, "Because \(\forall x\) holds.");
	});

	it("wrong-shape input never arms the dock (numeric strings DO coerce — the seam's leniency)", () => {
		assert.equal(parseExplainInput("just a string"), undefined);
		assert.equal(parseExplainInput({ explanation: "e", correctAnswer: "a" }), undefined, "missing question");
		assert.equal(parseExplainInput({ question: "q", explanation: "e", correctAnswer: { nested: true } }), undefined);
		// 42 → "42": the same numeric coercion the quiz seam pins.
		assert.equal(parseExplainInput({ question: "q", explanation: "e", correctAnswer: 42 })?.correctAnswer, "42");
	});
});

describe("over-escaped command recovery after shape parsing", () => {
	// Keep these real authoring shapes, but recover only for presentation.
	// Parsed source is also used to build durable answers and identities.
	const CLEAN =
		"Let $f : \\mathbb{R}^n \\to \\mathbb{R}$ be differentiable at $x$, with $\\nabla f(x) \\neq 0$. Among all unit directions $\\|u\\|_2 = 1$, which makes $D_u f(x)$ most negative?";
	const DOUBLE = (s: string): string => s.replace(/\\/g, "\\\\");
	const BASE = {
		options: [
			{ label: "$u^\\star = -\\nabla f(x)$", value: "neg" },
			{ label: "$u^\\star = \\nabla f(x)$", value: "pos" },
		],
		correctAnswer: "neg",
		explanation: "By Cauchy\u2013Schwarz: $$u^\\star = -\\frac{\\nabla f(x)}{\\|\\nabla f(x)\\|_2}$$",
	};

	it("presentation heals a doubled question field (the gradient-descent msg-3 shape)", () => {
		const parsed = parseQuizInput({ ...BASE, question: DOUBLE(CLEAN) });
		assert.ok(parsed, "parses");
		assert.equal(parsed.question, DOUBLE(CLEAN), "shape parsing retains source");
		assert.equal(repairMathForDisplay(parsed.question), CLEAN);
		// The CLEAN sibling fields of the same call stay byte-identical.
		assert.equal(parsed.options[0]!.label, BASE.options[0]!.label);
		assert.equal(parsed.explanation, BASE.explanation);
	});

	it("presentation heals a quadrupled field (the agent's over-correction, msg 6)", () => {
		const parsed = parseQuizInput({ ...BASE, question: DOUBLE(DOUBLE(CLEAN)) });
		assert.ok(parsed, "parses");
		assert.equal(parsed.question, DOUBLE(DOUBLE(CLEAN)), "shape parsing retains source");
		assert.equal(repairMathForDisplay(parsed.question), CLEAN);
	});

	it("doubled option labels and explanations heal too (the inference-runtime msg-7 shape)", () => {
		const parsed = parseQuizInput({
			question: "Let $A \\in \\mathbb{R}^{m \\times k}$ and $C = AB$.",
			options: [
				{ label: DOUBLE("$mkn$"), value: "mkn" },
				{ label: DOUBLE("$2mkn$"), value: "2" },
			],
			correctAnswer: "mkn",
			explanation: DOUBLE("$$c_{ij} = \\sum_{\\ell=1}^{k} a_{i\\ell}\\, b_{\\ell j}$$"),
		});
		assert.ok(parsed, "parses");
		assert.equal(parsed.options[0]!.label, "$mkn$");
		assert.equal(parsed.options[1]!.label, "$2mkn$");
		assert.equal(repairMathForDisplay(parsed.explanation), "$$c_{ij} = \\sum_{\\ell=1}^{k} a_{i\\ell}\\, b_{\\ell j}$$");
	});

	it("presentation heals doubled ask-option descriptions the same way", () => {
		const parsed = parseAskInput({
			question: "Depth?",
			options: [
				{ label: "Rigorous", description: DOUBLE("why $-\\nabla f$ is steepest descent") },
				{ label: "Intuition" },
			],
		});
		assert.ok(parsed, "parses");
		assert.equal(repairMathForDisplay(parsed.options![0]!.description!), "why $-\\nabla f$ is steepest descent");
	});

	it("clean records pass through byte-identical (no over-heal)", () => {
		const parsed = parseQuizInput({ ...BASE, question: CLEAN });
		assert.ok(parsed, "parses");
		assert.equal(parsed.question, CLEAN);
		assert.equal(parsed.explanation, BASE.explanation);
	});

	it("legitimate row breaks inside matrices survive the seam", () => {
		const matrix =
			"Which matrix matches? $$\\begin{pmatrix} 1 \\ 2 \\\\ 3 \\ 4\\end{pmatrix}$$";
		const parsed = parseQuizInput({ ...BASE, question: matrix });
		assert.ok(parsed, "parses");
		assert.equal(parsed.question, matrix);
	});
});
