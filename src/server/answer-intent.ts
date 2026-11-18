import { randomUUID } from "node:crypto";
import { normalizeContext } from "@earendil-works/pi-ai";
import { piEngineForSpec } from "../agent/models.ts";
import { answerIntentPrompt, parseAnswerIntent, type AnswerIntent, type AnswerIntentRequest } from "../core/answer-intent.ts";
import { resolveSlot } from "../core/settings-resolution.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";

/** The learner can fix this in Settings; the route answers 503 with the message. */
export class AnswerIntentUnavailable extends Error {}

/** Read a spoken pick with the Cheap slot's model (see core/answer-intent.ts). */
export async function inferAnswerIntent(req: AnswerIntentRequest, signal?: AbortSignal): Promise<AnswerIntent> {
	const slot = resolveSlot(stores.settingsStore.readSettings()?.models?.cheap);
	if (!slot) throw new AnswerIntentUnavailable("Picking an option from your thinking needs a Cheap model in Settings → Models");
	if (!providerKeyPresent(slot.provider)) throw new AnswerIntentUnavailable(`Picking an option from your thinking needs a key for ${slot.provider}`);
	// Thinking off (or the model's nearest level): the learner is waiting on this submit.
	const engine = piEngineForSpec({ provider: slot.provider, id: slot.id, thinkingLevel: "off" }, false, undefined, () => slot.cacheRetention);
	const { system, user } = answerIntentPrompt(req);
	const context = normalizeContext({ systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] });
	const reply = await engine.streamFn(engine.model, context, { signal, sessionId: randomUUID() }).result();
	if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? "The Cheap model call failed");
	const text = reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
	return parseAnswerIntent(text, req);
}
