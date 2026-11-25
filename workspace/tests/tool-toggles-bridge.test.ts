/**
 * The P2 tool-toggle bridge (2026-09-19): AgentBuildOptions.toolToggles is
 * first-class — the agent constructors thread it to the factories' enabled?
 * param (an explicit opts.tools registry is never filtered), and the
 * settings write side rejects unknown tool keys against TOGGLEABLE_TOOLS
 * (the definitive adjudicated list — a persisted `quiz: false` would
 * genuinely drop the quiz once the bridge honors the delta).
 *
 * Parser tests are PURE (no fs — parallel-test discipline); the agent
 * construction tests use an in-memory chat fixture like
 * question-tools.test.ts.
 */
import assert from "node:assert/strict";
import { z } from "zod";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { questionResult } from "../src/agent/tool-execute.ts";
import { createProberAgent, createTeacherAgent } from "../src/agent/teacher-agent.ts";
import type { ProberToolContext } from "../src/agent/tools.ts";
import { jobStore } from "../src/store/jobs.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";
import { chatStore } from "../src/store/chats.ts";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";

/** A scripted pi engine — the agent builds need an injected engine since
 *  BYOK removed the factory pins (owner, 2026-09-22). */
function fauxEngine(): PiEngine {
	const faux = createFauxCore({});
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}
import type { AgentSettings } from "../src/core/settings.ts";

describe("AgentBuildOptions.toolToggles (the P2 bridge)", () => {
	const toolNames = (agent: { state: { tools: Array<{ name: string }> } }) =>
		agent.state.tools.map((t) => t.name).sort();

	it("flows into the teacher's registry: a job-tool delta is a no-op on the bare set", () => {
		// No ctx → bare agent: quiz/ask only. A job-tool delta names tools
		// that don't exist there — the bridge must not crash on it.
		const bare = createTeacherAgent(undefined, { engine: fauxEngine(), toolToggles: { research: false } });
		assert.deepEqual(toolNames(bare), ["ask_user_question", "quiz"]);
	});

	it("flows into the prober's registry; probe_done survives everything", () => {
		const chatId = chatStore.createChat("Toggle bridge test").id;
		const ctx: ProberToolContext = { chatId, chatStore, deliver: () => {}, jobStore, spawn: () => {} };
		const prober = createProberAgent(ctx, { engine: fauxEngine(), toolToggles: { ask_user_question: false } });
		const names = toolNames(prober);
		assert.ok(!names.includes("ask_user_question"), "the delta dropped the tool");
		assert.ok(names.includes("probe_done"), "probe_done always-on");
	});

	it("an explicitly injected opts.tools registry is NEVER toggle-filtered", () => {
		const teacher = createTeacherAgent(undefined, {
			engine: fauxEngine(),
			tools: {
				quiz: {
					name: "quiz",
					label: "quiz",
					description: "test",
					parameters: Type.Object({}),
					execute: async () => questionResult(),
				},
			},
			toolToggles: { quiz: false },
		});
		assert.deepEqual(toolNames(teacher), ["quiz"]);
	});
});

describe("parseAgentSettingsBody: tool keys validate at write time", () => {
	const parse = (tools: Record<string, boolean>) =>
		parseAgentSettingsBody({ tools }) as
			| { ok: true; settings: AgentSettings }
			| { ok: false; error: string };

	it("a valid job-tool delta parses", () => {
		const r = parse({ research: false, pdf: false });
		assert.equal(r.ok, true);
		assert.deepEqual(r.ok && r.settings.tools, { research: false, pdf: false });
	});

	it("the quizzing-mechanics key (explain) is writable (owner 2026-09-27)", () => {
		const r = parse({ explain: true });
		assert.equal(r.ok, true);
		assert.deepEqual(r.ok && r.settings.tools, { explain: true });
	});

	it("unknown keys are rejected with the supported list (the quiz wedge never persists)", () => {
		const r = parse({ quiz: false });
		assert.equal(r.ok, false);
		assert.match(!r.ok && r.error, /unknown tool "quiz" \(supported: research, demo, visual, pdf, explain\)/);
		const typo = parse({ reasearch: false });
		assert.equal(typo.ok, false);
		assert.match(!typo.ok && typo.error, /unknown tool "reasearch"/);
	});

	it("absent tools field is fine (absent = enabled everywhere)", () => {
		const r = parseAgentSettingsBody({}) as { ok: boolean };
		assert.equal(r.ok, true);
	});
});
