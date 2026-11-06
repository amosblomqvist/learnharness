/**
 * The SIDE-QUESTION model call (inline side questions, owner design
 * 2026-11-02): one tool-less streamed generation on the session's own
 * engine. No agent loop, no tools, no session identity — a Claude Code
 * call without a session id never retains or reuses the lesson's live
 * CLI process (docs/claude-code.md "Questions, reuse, and cancellation").
 *
 * Instructions: the side-chat base, then the curated shared appendix the
 * practice agent also composes (voice, accuracy, formatting — one law
 * across every learner-facing agent; the LaTeX/markdown contract matters
 * because answers render through the same markdown pipeline). Shared
 * fragments honor the learner's enabled overrides, by the same key the
 * other agents use; the side base itself is not an editable segment.
 */

import fs from "node:fs";
import path from "node:path";
import { normalizeContext, type AssistantMessage, type Message, type Usage } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import type { SideModelTurn } from "../core/side-chat.ts";
import type { PiEngine } from "./models.ts";
import { readPromptOverride } from "./prompt-segments.ts";

export const PROMPTS_DIR = path.join(PATHS.root, "src", "agent", "prompts");
export const SIDE_CHAT_BASE = "side-chat/00-base.md";
/** The shared appendix, in composition order (keys = override paths). */
const SIDE_SHARED_FRAGMENTS = ["shared/10-voice.md", "shared/15-accuracy.md", "shared/40-formatting.md"];

export function readSource(file: string): string {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return "";
	}
}

/** The side model's system prompt, composed fresh per call (an override
 *  switched on between questions lands on the next one). */
export function composeSideChatInstructions(switches: Record<string, boolean> = {}, base = SIDE_CHAT_BASE): string {
	const segments = [readSource(path.join(PROMPTS_DIR, ...base.split("/")))];
	for (const key of SIDE_SHARED_FRAGMENTS) {
		const override = switches[key] === true ? readPromptOverride(key) : null;
		segments.push(override ?? readSource(path.join(PROMPTS_DIR, ...key.split("/"))));
	}
	return segments
		.map((s) => s.trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
}

export interface SideAnswerResult {
	/** The answer text (partial when stopped or failed). */
	text: string;
	/** Present when the provider reported usage (also on failures). */
	usage?: Usage;
	/** How the call ended. */
	outcome: "done" | "aborted" | "error";
	/** The provider's failure text (outcome "error"). */
	errorMessage?: string;
	/** Why a finished call stopped ("length": cut off at the output limit). */
	stopReason?: AssistantMessage["stopReason"];
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}

/**
 * Stream one side answer. `onText` receives the FULL text so far on every
 * text delta (replace, never append — the same slot discipline as the
 * turn stream). Never throws for provider failures or aborts: the outcome
 * says how it ended and `text` keeps whatever arrived.
 */
export async function streamSideAnswer(opts: {
	engine: PiEngine;
	instructions: string;
	turns: readonly SideModelTurn[];
	signal?: AbortSignal;
	onText?: (text: string) => void;
}): Promise<SideAnswerResult> {
	const now = Date.now();
	const messages: Message[] = opts.turns.map((turn) =>
		turn.role === "user"
			? { role: "user", content: turn.text, timestamp: now }
			: ({
					role: "assistant",
					content: [{ type: "text", text: turn.text }],
					api: opts.engine.model.api,
					provider: opts.engine.model.provider,
					model: opts.engine.model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: now,
				} as AssistantMessage),
	);
	let text = "";
	try {
		const stream = opts.engine.streamFn(opts.engine.model, normalizeContext({ systemPrompt: opts.instructions, messages, tools: [] }), {
			signal: opts.signal,
		} as never);
		for await (const event of stream) {
			if (event.type === "text_delta" || event.type === "text_end") {
				const next = textOf(event.partial);
				if (next !== text) {
					text = next;
					opts.onText?.(text);
				}
			} else if (event.type === "done") {
				return { text: textOf(event.message) || text, usage: event.message.usage, outcome: "done", stopReason: event.message.stopReason };
			} else if (event.type === "error") {
				const partial = textOf(event.error) || text;
				if (event.reason === "aborted") return { text: partial, usage: event.error.usage, outcome: "aborted" };
				return { text: partial, usage: event.error.usage, outcome: "error", errorMessage: event.error.errorMessage ?? "The model call failed." };
			}
		}
		return { text, outcome: "error", errorMessage: "The model stream ended without a result." };
	} catch (err) {
		if (opts.signal?.aborted) return { text, outcome: "aborted" };
		return { text, outcome: "error", errorMessage: err instanceof Error ? err.message : String(err) };
	}
}
