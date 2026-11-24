/**
 * The getApiKey-hook fix (owner, 2026-09-26): both Agent constructions
 * (baseAgentOptions in teacher-agent.ts, runSubagent's loop in
 * subagents/pi-run.ts) used to pass `getApiKey: () => openRouterApiKey()` —
 * and pi-agent-core resolves
 * `(config.getApiKey ? await config.getApiKey(provider) : undefined) || config.apiKey`
 * (agent-loop.js:191), so a provided hook OVERRIDES pi-ai's native
 * per-provider env resolution. The hook ignored its provider arg, so every
 * non-OpenRouter provider was sent the OpenRouter key and 401'd (owner repro:
 * openai:gpt-5.6-luna, anthropic:claude-haiku-4-5 direct).
 *
 * The fix is DELETION: with no hook, pi-ai resolves keys natively from the
 * environment per request — the architecture's stated intent (models.ts:
 * "the keys seam reflects file-saved keys into env"). This file pins that
 * the deletion holds: the built agents must expose NO getApiKey hook, so
 * native resolution runs for every provider.
 *
 * runSubagent's Agent is internal to its promise (no exposed seam); its
 * hook was deleted in the same commit and its behavior is covered by the
 * sub-agent suite's faux engines.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProberAgent, createTeacherAgent, type TeachingAgent } from "../src/agent/teacher-agent.ts";
import type { ProberToolContext } from "../src/agent/tools.ts";
import { jobStore } from "../src/store/jobs.ts";
import { chatStore } from "../src/store/chats.ts";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";

/** A scripted pi engine — the agent builds need an injected engine since
 * BYOK removed the factory pins (owner, 2026-09-22). */
function fauxEngine(): PiEngine {
	const faux = createFauxCore({});
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

describe("the getApiKey-hook fix (native per-provider key resolution)", () => {
	it("teacher and prober builds expose NO getApiKey hook — pi-ai resolves keys natively", () => {
		const chatId = chatStore.createChat("getApiKey pin").id;
		const ctx: ProberToolContext = { chatId, chatStore, deliver: () => {}, jobStore, spawn: () => {} };
		const builds: TeachingAgent[] = [
			createTeacherAgent(undefined, { engine: fauxEngine() }),
			createProberAgent(ctx, { engine: fauxEngine() }),
		];
		for (const agent of builds) {
			assert.equal(
				(agent as unknown as { getApiKey?: unknown }).getApiKey,
				undefined,
				"the OpenRouter-pinning hook must stay deleted — a set hook overrides pi-ai's native per-provider env resolution for EVERY provider",
			);
		}
	});
});