/** Display repair is shared, not a mutation of saved practice/teaching arguments. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { problemInputObject } from "../src/agent/tools/practice.ts";
import { PracticeDock } from "../components/practice-dock.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { LatexGlyph } from "../components/latex-glyph.tsx";
import { ProblemCard, ConcludeCard } from "../components/practice-cards.tsx";
import { MessageResponse, ToolContentResponse } from "../components/ai-elements/message.tsx";
import {
	repairMathForDisplay, healOverescapedCommands, restoreMathEscapes,
	parseQuizInput, parseAskInput, parseExplainInput, activeProblemOf, projectView,
	toLlmMessages, type LhMessage, type ArtifactPartProps,
} from "../src/core/index.ts";

const tex = String.raw`\nabla f(x) \in \mathbb{R}^{m \times n}`;
const clean = `$${tex}$`;
const doubled = clean.replace(/\\/g, "\\\\");
const quadrupled = clean.replace(/\\/g, "\\\\\\\\");
const debris = "$\forall x \\in \\mathbb{R}$"; // JSON's form feed consumed the f.
const repairedDebris = String.raw`\forall x \in \mathbb{R}`;
const matrix = "$$\n" + String.raw`\\begin{pmatrix}1 & 2 \\ 3 & 4\\end{pmatrix}` + "\n$$";
const repairedMatrix = String.raw`\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}`;
const part = (input: unknown, over: Partial<ArtifactPartProps["part"]> = {}): ArtifactPartProps["part"] => ({
	type: "tool-problem", state: "input-available", toolCallId: "call_math", input, ...over,
});
const dock = (input: { statement: string }, expanded = true) => (
	<PracticeDock problemCallId="call_math" input={input} expanded={expanded} onExpand={() => {}} onSubmit={() => {}} />
);

function math(html: string) {
	const { document } = parseHTML(html);
	return {
		annotations: [...document.querySelectorAll('annotation[encoding="application/x-tex"]')].map((n) => n.textContent),
		glyphs: [...document.querySelectorAll(".katex-html")].map((n) => n.textContent).join(""),
		errors: document.querySelectorAll(".katex-error").length,
	};
}
function assertMath(html: string, expected = [tex], glyphs = ["∇", "∈", "×"]) {
	const actual = math(html);
	assert.deepEqual(actual.annotations, expected, "exact TeX, not merely absence of errors");
	assert.equal(actual.errors, 0);
	for (const glyph of glyphs) assert.ok(actual.glyphs.includes(glyph), `rendered glyph ${glyph}`);
}

describe("repairMathForDisplay — the existing composition, unchanged", () => {
	const unchanged = [
		clean,
		String.raw`outside \\nabla`,
		String.raw`$a \\\nabla b$`,
		String.raw`$a \\\\\nabla b$`,
		String.raw`$a \\ 2 \\& 3 \\[6pt] 4$`,
		"$$\na \\\\\\\\ 2\nb\n$$", // four real row-break slashes survive too.
		"`" + doubled + "`",
		"```tex\n" + doubled + "\n```",
		"`" + debris + "`",
		"```tex\n" + debris + "\n```",
		String.raw`$\\nabla`,
		"$$A = \\\\begin{pmatrix}\n1 & 2\n\\\\end{pmatrix}$$", // unsupported midline display close.
	];
	for (const [index, value] of [...unchanged, doubled, quadrupled, debris, matrix,
		String.raw`\(\\nabla\)`, "\\[\n\\\\nabla\n\\]"].entries()) {
		it(`matches the old composition byte-for-byte (${index})`, () => {
			assert.equal(repairMathForDisplay(value), healOverescapedCommands(restoreMathEscapes(value)));
		});
	}
	it("preserves clean math, odd runs, row breaks, code, prose and existing recognition limits", () => {
		for (const value of unchanged) assert.equal(repairMathForDisplay(value), value);
		assert.equal(repairMathForDisplay(doubled), clean);
		assert.equal(repairMathForDisplay(quadrupled), clean);
		assert.equal(repairMathForDisplay(debris), `$${repairedDebris}$`);
		assert.equal(repairMathForDisplay(matrix), `$$\n${repairedMatrix}\n$$`);
	});
});

describe("upgraded KaTeX rendering on real question and practice surfaces", () => {
	for (const [name, formula, glyphs] of [
		["fraction and root", String.raw`\frac{1}{\sqrt{x}}`, ["1", "x"]],
		["accents", String.raw`\hat{x}+\bar{y}`, ["x", "y"]],
		["sum", String.raw`\sum_{i=1}^{n}i`, ["∑", "i", "n"]],
		["matrix rows", String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`, ["1", "2", "3", "4"]],
		["aligned rows", String.raw`\begin{aligned}a&=b\\ c&=d\end{aligned}`, ["a", "b", "c", "d", "="]],
	] as const) {
		it(`${name}: dollar and legacy delimiters preserve glyphs and copied TeX`, () => {
			for (const raw of [`$${formula}$`, `\\(${formula}\\)`, `$$\n${formula}\n$$`, `\\[\n${formula}\n\\]`]) {
				for (const element of [
					<MessageResponse mode="static">{raw}</MessageResponse>,
					<QuestionDock toolName="ask_user_question" toolCallId="security_question" input={{ question: raw }} expanded onExpand={() => {}} onSubmit={() => {}} />,
					dock({ statement: raw }),
				]) {
					const html = renderToStaticMarkup(element);
					assertMath(html, [formula], [...glyphs]);
					const { document } = parseHTML(html);
					assert.ok(document.querySelector(".katex-base .katex-strut"), "matching 0.18 internal layout classes");
					if (name === "fraction and root") assert.ok(document.querySelector(".mfrac .sqrt"));
					if (name === "accents") assert.ok(document.querySelectorAll(".katex-accent").length >= 2);
					if (name.endsWith("rows")) assert.ok(document.querySelectorAll(".mtable .mtr").length >= 2 || document.querySelectorAll(".mtable .vlist > span").length >= 2, "two real rows, not repaired-away slashes");
				}
			}
		});
	}
	it("preserves escaped currency and code on both dock surfaces", () => {
		const raw = "Costs \\$5 and \\$10. `" + clean + "`\n\n```text\n" + doubled + "\n```";
		for (const element of [dock({ statement: raw }), <QuestionDock toolName="ask_user_question" toolCallId="security_code" input={{ question: raw }} expanded onExpand={() => {}} onSubmit={() => {}} />]) {
			const html = renderToStaticMarkup(element);
			assert.deepEqual(math(html).annotations, []);
			assert.ok(parseHTML(html).document.firstElementChild?.textContent?.includes("$5 and $10"));
			assert.ok(parseHTML(html).document.querySelector("code")?.textContent?.includes(clean));
		}
	});
	it("renders direct LatexGlyph connectors through the upgraded root", () => {
		for (const [command, glyph] of [[String.raw`\Rightarrow`, "⇒"], [String.raw`\land`, "∧"], [String.raw`\neg`, "¬"]]) {
			const html = renderToStaticMarkup(<LatexGlyph cmd={command!} />);
			const { document } = parseHTML(html);
			assert.equal(document.querySelectorAll(".katex-error").length, 0);
			assert.ok(document.querySelector(".katex-base .katex-strut"));
			assert.ok(document.querySelector(".katex-html")?.textContent?.includes(glyph!));
		}
	});
});

describe("practice display surfaces", () => {
	for (const [name, raw, expected, glyphs] of [
		["two command slashes", doubled, tex, ["∇", "∈", "×"]],
		["four command slashes", quadrupled, tex, ["∇", "∈", "×"]],
		["JSON debris", debris, repairedDebris, ["∀", "∈"]],
		["clean math", clean, tex, ["∇", "∈", "×"]],
		["matrix with legitimate row break", matrix, repairedMatrix, ["1", "2", "3", "4"]],
	] as const) {
		it(`${name}: expanded dock, settled statement, verdict, committed reveal and legacy fallback`, () => {
			const input = Object.freeze({ statement: raw, modelSolution: `HIDDEN COMMITMENT ${raw}` });
			const conclusion = Object.freeze({ outcome: "solved", verdict: raw, solutionReveal: raw });
			const before = JSON.stringify({ input, conclusion });
			for (const element of [dock(input), <ProblemCard part={part(input)} />]) {
				const html = renderToStaticMarkup(element);
				assertMath(html, [expected], [...glyphs]);
				assert.ok(!html.includes("HIDDEN COMMITMENT"));
			}
			assertMath(renderToStaticMarkup(<ConcludeCard part={part(conclusion, { type: "tool-conclude", reveal: raw })} />),
				[expected, expected], [...glyphs]);
			assertMath(renderToStaticMarkup(<ConcludeCard part={part({ outcome: "solved", solutionReveal: raw })} />),
				[expected], [...glyphs]);
			assert.equal(JSON.stringify({ input, conclusion }), before);
		});
	}

	it("keeps a boundary-converted numeric statement raw and preserves prior dock passthrough", () => {
		const raw = { statement: 17, mode: "recall", modelSolution: "Committed solution." };
		const call = { type: "toolCall", id: "numeric_problem", name: "problem", arguments: raw };
		const validated = validateToolArguments(
			{ name: "problem", parameters: problemInputObject } as never,
			call as never,
		) as { statement: unknown };
		assert.equal(validated.statement, "17", "the actual tool boundary converts its cloned arguments");
		assert.equal(raw.statement, 17, "saved arguments retain the number");
		const messages = [
			{ id: "numeric_pose", role: "assistant", content: [call], timestamp: 1 },
			{ id: "numeric_ack", role: "toolResult", toolCallId: call.id, toolName: "problem", content: [{ type: "text", text: "Problem posed" }], details: null, isError: false, timestamp: 2 },
		] as unknown as LhMessage[];
		const before = structuredClone(messages);
		const active = activeProblemOf(messages);
		assert.ok(active);
		assert.equal((active.input as { statement: unknown }).statement, 17);
		// Mirror the existing runtime cast at the Chat -> PracticeDock seam.
		const input = active.input as { statement: string };
		let expanded = "";
		assert.doesNotThrow(() => { expanded = renderToStaticMarkup(dock(input)); });
		const { document } = parseHTML(expanded);
		assert.equal(document.querySelector(".lh-prose")!.innerHTML,
			parseHTML(renderToStaticMarkup(<MessageResponse>{input.statement}</MessageResponse>)).document.firstElementChild!.outerHTML,
			"non-string values pass through exactly as before, without string coercion or a new fallback");
		const collapsed = renderToStaticMarkup(dock(input, false));
		assert.match(collapsed, /data-testid="practice-dock-bar"/);
		assert.equal(parseHTML(collapsed).document.querySelector("span.truncate")!.textContent, "17");
		assert.deepEqual(math(collapsed).annotations, []);
		assert.deepEqual(messages, before);
		assert.equal(raw.statement, 17);
	});

	it("preserves code spans/fences across every repaired display surface", () => {
		const raw = "`" + doubled + "`\n\n```text\n" + doubled + "\n```";
		for (const element of [dock({ statement: raw }), <ProblemCard part={part({ statement: raw })} />,
			<ConcludeCard part={part({ outcome: "solved", verdict: raw }, { reveal: raw })} />]) {
			const html = renderToStaticMarkup(element);
			assert.deepEqual(math(html).annotations, []);
			const { document } = parseHTML(html);
			assert.ok(document.querySelector("code")?.textContent?.includes(doubled));
		}
	});

	it("does not change the collapsed preview, dismissal or global prose renderer", () => {
		const preview = renderToStaticMarkup(dock({ statement: doubled }, false));
		assert.ok(preview.includes(doubled));
		assert.deepEqual(math(preview).annotations, []);
		const dismissed = renderToStaticMarkup(<ConcludeCard part={part({ outcome: "dismissed", verdict: doubled }, { reveal: doubled })} />);
		assert.ok(dismissed.includes("Problem dismissed."));
		assert.deepEqual(math(dismissed).annotations, []);
		const plain = math(renderToStaticMarkup(<MessageResponse>{doubled}</MessageResponse>));
		assert.deepEqual(plain.annotations, [doubled.slice(1, -1)]);
		assert.ok(!plain.glyphs.includes("∇")); // Same unchanged assistant/user MessageResponse path.
	});

	it("teaching shape parsing retains source bytes; presentation alone recovers them", () => {
		const quiz = { question: doubled, options: [{ label: "yes" }, { label: "no" }], correctAnswer: "yes", explanation: debris };
		const ask = { question: doubled };
		const explain = { question: doubled, correctAnswer: debris };
		const before = structuredClone({ quiz, ask, explain });
		assert.equal(parseQuizInput(quiz)?.question, doubled);
		assert.equal(parseQuizInput(quiz)?.explanation, debris);
		assert.equal(parseAskInput(ask)?.question, doubled);
		assert.equal(parseExplainInput(explain)?.question, doubled);
		assert.equal(parseExplainInput(explain)?.correctAnswer, debris);
		assertMath(renderToStaticMarkup(<ToolContentResponse>{parseAskInput(ask)!.question}</ToolContentResponse>));
		assert.deepEqual({ quiz, ask, explain }, before);
	});

	it("native history, active args and the view join remain raw; commitment appears only at conclusion", () => {
		const stamps = { api: "faux", provider: "test", model: "test-model", timestamp: 1, stopReason: "toolUse" };
		const input = { statement: doubled, modelSolution: `COMMITTED ${quadrupled}` };
		const messages = [
			{ ...stamps, id: "a1", role: "assistant", content: [{ type: "toolCall", id: "p1", name: "problem", arguments: input }] },
			{ id: "r1", role: "toolResult", toolCallId: "p1", toolName: "problem", content: [{ type: "text", text: "Problem posed" }], details: null, isError: false, timestamp: 2 },
		] as unknown as LhMessage[];
		const concluded = [...messages,
			{ ...stamps, id: "a2", role: "assistant", content: [{ type: "toolCall", id: "c1", name: "conclude", arguments: { outcome: "solved", verdict: doubled } }] },
			{ id: "r2", role: "toolResult", toolCallId: "c1", toolName: "conclude", content: [{ type: "text", text: "Problem concluded" }], details: null, isError: false, timestamp: 3 },
		] as unknown as LhMessage[];
		const before = structuredClone(concluded);
		const history = structuredClone(toLlmMessages(concluded));
		assert.deepEqual(activeProblemOf(messages)?.input, input);
		const problem = projectView(messages)[0]!.parts.find((p) => p.type === "tool-problem")!;
		assert.ok(problem.state && problem.toolCallId);
		assert.deepEqual(problem.input, input);
		const statementHtml = renderToStaticMarkup(<ProblemCard part={{ ...problem, state: problem.state, toolCallId: problem.toolCallId }} />);
		assertMath(statementHtml);
		assert.ok(!statementHtml.includes("COMMITTED"));
		const conclusion = projectView(concluded).flatMap((m) => m.parts).find((p) => p.type === "tool-conclude")!;
		assert.ok(conclusion.state && conclusion.toolCallId);
		assert.equal(conclusion.reveal, input.modelSolution);
		const revealHtml = renderToStaticMarkup(<ConcludeCard part={{ ...conclusion, state: conclusion.state, toolCallId: conclusion.toolCallId }} />);
		assert.ok(revealHtml.includes("COMMITTED"));
		assertMath(revealHtml, [tex, tex]);
		assert.deepEqual(concluded, before);
		assert.deepEqual(toLlmMessages(concluded), history);
	});
});
