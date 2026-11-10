/**
 * LESSON PROMPT PINS (lesson mode): the lesson agent's composition —
 * order (teaching base → lesson/ fragments sorted → shared/ appendix
 * sorted), discovery (numeric-prefix fragments only), the override path
 * (switch + file → override text; either missing → source), and the
 * isolation pin (the existing agents' composed bytes are unchanged by
 * the new directory — no lesson doctrine leaks into teacher/prober and
 * no teaching method leaks into lesson). The 35-sources source-reading
 * doctrine is pinned present (book-scale sources degrade gracefully
 * instead of blowing the context budget).
 *
 * TEST-DIR ISOLATION (the prompt-overrides discipline): this file owns
 * its temp LH_DATA_DIR — set before any config-loading import, so every
 * app-module import is dynamic. Override-writing tests stay per-file.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lesson-prompts-"));
process.env.LH_DATA_DIR = TMP_DATA;

const teacherAgent = await import("../src/agent/teacher-agent.ts");
const { allSegmentPaths, effectivePromptSegments } = await import("../src/agent/prompt-segments.ts");
const { promptOverrides } = await import("../src/store/prompt-overrides.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

/** A scripted pi engine (pi-ai's faux provider) — agent builds need one. */
function fauxEngine(): PiEngine {
	const faux = createFauxCore({});
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** The pre-lesson loader, rebuilt inline (the prompt-overrides pin's shape):
 *  base + the agent's own fragments + the shared appendix — for the
 *  byte-identity check of the EXISTING agents against the live loader. */
function oldLoader(kind: "prober" | "teacher"): string {
	const fragmentsOf = (dir: string) =>
		fs
			.readdirSync(dir)
			.filter((f) => /^\d+-[\w.-]+\.md$/.test(f))
			.sort()
			.map((f) => fs.readFileSync(path.join(dir, f), "utf-8").trim())
			.filter(Boolean);
	const base = fs.readFileSync("src/agent/system-prompt.md", "utf-8").trim();
	return [base, ...fragmentsOf(`src/agent/prompts/${kind}`), ...fragmentsOf("src/agent/prompts/shared")].join(
		"\n\n---\n\n",
	);
}

describe("lesson composition (lesson mode)", () => {
	it("composes base → lesson/ fragments sorted → shared/ appendix sorted", () => {
		const { composeInstructions } = teacherAgent;
		const segments = effectivePromptSegments("lesson", {}).map((s) => s.path);
		assert.deepEqual(segments, [
			"system-prompt.md",
			"lesson/05-syllabus.md",
			"lesson/10-sections.md",
			"lesson/20-checks.md",
			"lesson/30-calibration.md",
			"lesson/35-sources.md",
			"lesson/40-adaptation.md",
			"shared/10-voice.md",
			"shared/15-accuracy.md",
			"shared/16-mental-model.md",
			"shared/20-question-tools.md",
			"shared/25-confidence.md",
			"shared/30-learner-files.md",
			"shared/40-formatting.md",
		]);
		// The lesson doctrine rides its own fragments; the shared register
		// (documents-not-chat-messages) composes like the teacher's.
		const composed = composeInstructions("lesson");
		assert.ok(composed.includes("# The syllabus"));
		assert.ok(composed.includes("# Sections — documents, not dialogue"));
		assert.ok(composed.includes("# Exit tickets — one check per section"));
		assert.ok(composed.includes("# Calibration — brief, never a probe"));
		assert.ok(composed.includes("# Source material — structure first, spans on demand"));
		assert.ok(composed.includes("# Steering — his words move the lesson"));
		assert.ok(composed.includes("he receives documents, not chat messages"), "the shared formatting law composes");
	});

	it("byte-identity: composition is base + own dir + shared, trimmed, joined with the separator", () => {
		const { composeInstructions } = teacherAgent;
		const inline = [
			fs.readFileSync("src/agent/system-prompt.md", "utf-8").trim(),
			...["05-syllabus.md", "10-sections.md", "20-checks.md", "30-calibration.md", "35-sources.md", "40-adaptation.md"]
				.map((f) => fs.readFileSync(path.join("src/agent/prompts/lesson", f), "utf-8").trim()),
			...["10-voice.md", "15-accuracy.md", "16-mental-model.md", "20-question-tools.md", "25-confidence.md", "30-learner-files.md", "40-formatting.md"]
				.map((f) => fs.readFileSync(path.join("src/agent/prompts/shared", f), "utf-8").trim()),
		].join("\n\n---\n\n");
		assert.equal(composeInstructions("lesson"), inline);
	});

	it("the EXISTING agents' bytes are unchanged by the new directory", () => {
		const { composeInstructions } = teacherAgent;
		assert.equal(composeInstructions("teacher"), oldLoader("teacher"));
		assert.equal(composeInstructions("prober"), oldLoader("prober"));
		// No cross-contamination: lesson doctrine never enters the teacher…
		assert.ok(!composeInstructions("teacher").includes("# The syllabus"));
		// …and the teacher's per-step method never enters lesson.
		assert.ok(!composeInstructions("lesson").includes("# Teach — one step at a time"));
	});

	it("discovery: numeric-prefix fragments only, and lesson segments join the route-known paths", () => {
		const lessonPaths = effectivePromptSegments("lesson", {}).map((s) => s.path);
		for (const p of allSegmentPaths()) {
			if (p.startsWith("lesson/")) assert.ok(lessonPaths.includes(p), `${p} is route-known`);
		}
		assert.ok(allSegmentPaths().includes("lesson/35-sources.md"), "the sources doctrine segment is discovered");
		assert.ok(!allSegmentPaths().some((p) => p.includes("README")), "README never loads");
	});

	it("the override path works: switch + file swaps the lesson fragment; either missing composes source", () => {
		const { composeInstructions } = teacherAgent;
		promptOverrides.writeOverride("lesson/20-checks.md", "MY EXIT-TICKET DOCTRINE");
		try {
			const on = composeInstructions("lesson", { "lesson/20-checks.md": true });
			assert.ok(on.includes("MY EXIT-TICKET DOCTRINE"), "override composes when switch on");
			assert.ok(!on.includes("# Exit tickets — one check per section"), "source text is replaced");
			const off = composeInstructions("lesson", {});
			assert.ok(off.includes("# Exit tickets — one check per section"), "switch off → source default");
			const noFile = composeInstructions("lesson", { "lesson/05-syllabus.md": true });
			assert.ok(noFile.includes("# The syllabus"), "switch on with no file → source default");
		} finally {
			promptOverrides.deleteOverride("lesson/20-checks.md");
		}
	});

	it("createLessonAgent composes the lesson prompt into the agent's system prompt", () => {
		const { createLessonAgent } = teacherAgent;
		const engine = fauxEngine();
		const agent = createLessonAgent(undefined, { engine });
		assert.ok(agent.state.systemPrompt.includes("# The syllabus"));
		assert.ok(agent.state.systemPrompt.includes("# Source material — structure first, spans on demand"));
		assert.ok(!agent.state.systemPrompt.includes("# Teach — one step at a time"));
	});
});
