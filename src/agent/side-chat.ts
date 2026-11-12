/**
 * The SIDE-QUESTION model call: #487's tool-less streamed generation,
 * using the session's conversation model. No agent loop, no tools, and no
 * Claude Code session identity — a Claude Code call without a session id
 * never retains or reuses the lesson's live CLI process
 * (docs/claude-code.md "Questions, reuse, and cancellation"). Every other
 * provider gets the chat id: pi-ai only adds OpenCode's required
 * `x-opencode-session` routing header when the request carries a session
 * id, so omitting it fails OpenCode Go side questions with 400
 * MissingSessionID before any token is used.
 *
 * Instructions: the side-chat base, then the curated shared appendix the
 * practice agent also composes (voice, accuracy, formatting — one law
 * across every learner-facing agent; the LaTeX/markdown contract matters
 * because answers render through the same markdown pipeline). Shared
 * fragments honor the learner's enabled overrides, by the same key the
 * other agents use. A final side-only style fragment keeps replies brief
 * after the shared appendix; neither side-specific fragment is editable.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeContext, type AssistantMessage, type Message, type Usage } from "@earendil-works/pi-ai";
import { backgroundCaptureStream, createBackgroundCapture } from "./background-capture.ts";
import { CLAUDE_CODE_PROVIDER } from "./claude-code/constants.ts";
import { providerEventObserver } from "./provider-events.ts";
import { PATHS } from "../../config.ts";
import type { SideModelTurn } from "../core/side-chat.ts";
import type { PiEngine } from "./models.ts";
import { readPromptOverride } from "./prompt-segments.ts";

const PROMPTS_DIR = path.join(PATHS.root, "src", "agent", "prompts");
const SIDE_BASE = path.join(PROMPTS_DIR, "side-chat", "00-base.md");
const SIDE_STYLE = path.join(PROMPTS_DIR, "side-chat", "90-style.md");
/** The shared appendix, in composition order (keys = override paths). */
const SIDE_SHARED_FRAGMENTS = ["shared/10-voice.md", "shared/15-accuracy.md", "shared/40-formatting.md"];

function readSource(file: string): string {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return "";
	}
}

/** The side model's system prompt, composed fresh per call (an override
 *  switched on between questions lands on the next one). */
export function composeSideChatInstructions(switches: Record<string, boolean> = {}): string {
	const segments = [readSource(SIDE_BASE)];
	for (const key of SIDE_SHARED_FRAGMENTS) {
		const override = switches[key] === true ? readPromptOverride(key) : null;
		segments.push(override ?? readSource(path.join(PROMPTS_DIR, ...key.split("/"))));
	}
	segments.push(readSource(SIDE_STYLE));
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
	/** Existing opt-in diagnostic identity, NOT a reusable provider session. */
	chatId?: string;
	runId?: string;
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
	let failure: unknown;
	const capture = createBackgroundCapture({ role: "sideQuestion", runId: opts.runId ?? randomUUID(), sourceId: opts.chatId });
	const providerEvents = opts.chatId ? providerEventObserver(opts.chatId, "sideQuestion") : undefined;
	// OpenCode Go rejects requests without `x-opencode-session`; pi-ai derives
	// it from this option. Claude Code treats it as a live process to resume,
	// which a side question must never do.
	const sessionId = opts.chatId && opts.engine.model.provider !== CLAUDE_CODE_PROVIDER ? opts.chatId : undefined;
	try {
		const stream = backgroundCaptureStream(opts.engine.streamFn, capture)(opts.engine.model, normalizeContext({ systemPrompt: opts.instructions, messages, tools: [] }), {
			signal: opts.signal,
			reasoning: opts.engine.level === "off" ? undefined : opts.engine.level,
			...(sessionId ? { sessionId } : {}),
			...(providerEvents ? { onProviderStreamEvent: providerEvents } : {}),
		});
		for await (const event of stream) {
			if (event.type === "text_delta" || event.type === "text_end") {
				const next = textOf(event.partial);
				if (next !== text) {
					text = next;
					opts.onText?.(text);
				}
			} else if (event.type === "done") {
				capture?.reply(event.message);
				return { text: textOf(event.message) || text, usage: event.message.usage, outcome: "done" };
			} else if (event.type === "error") {
				capture?.reply(event.error);
				failure = new Error(event.error.errorMessage ?? event.reason);
				const partial = textOf(event.error) || text;
				if (event.reason === "aborted") return { text: partial, usage: event.error.usage, outcome: "aborted" };
				return { text: partial, usage: event.error.usage, outcome: "error", errorMessage: event.error.errorMessage ?? "The model call failed." };
			}
		}
		failure = new Error("The model stream ended without a result.");
		return { text, outcome: "error", errorMessage: (failure as Error).message };
	} catch (err) {
		failure = err;
		if (opts.signal?.aborted) return { text, outcome: "aborted" };
		return { text, outcome: "error", errorMessage: err instanceof Error ? err.message : String(err) };
	} finally {
		capture?.finish(failure);
	}
}
