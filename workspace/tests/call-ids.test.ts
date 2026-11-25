import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { ToolCallIdUniquifier, collectToolCallIds } from "../src/server/pi/call-ids.ts";

/**
 * THE LACAN INCIDENT (owner-approved fix, 2026-10-04): DeepSeek (via
 * OpenRouter) returns tool-call ids that reset every response — a
 * one-call-per-turn session names EVERY call `call_0`. The uniquifier sits
 * at the wire boundary (runPiTurn): colliding ids remint once, and the
 * same minting applies at settlement, so wire + record + next-turn context
 * agree. These pins drive it as a pure unit: event sequences in, remapped
 * events and settled messages out.
 *
 * REFERENCE-IDENTITY CONTRACT: streaming messages carry no ids (stamped
 * at persist), so tables key by object identity — the message_end object
 * is the object agent.state.messages holds (verified against
 * pi-agent-core). The pins hold references the same way.
 */

const assistantMsg = (id: string, callIds: string[]): any => ({
	id,
	role: "assistant",
	content: callIds.map((cid) => ({ type: "toolCall", id: cid, name: "quiz", arguments: {} })),
});
const toolResultMsg = (callId: string): any => ({
	id: `r_${callId}`,
	role: "toolResult",
	toolCallId: callId,
	content: [],
	details: { kind: "quiz" },
});
const asEvent = (e: unknown): AgentEvent => e as AgentEvent;
const firstCallId = (e: AgentEvent): string => (e as any).message.content[0].id;

describe("ToolCallIdUniquifier", () => {
	it("unique ids pass through verbatim — the wire stays honest when the provider is", () => {
		const u = new ToolCallIdUniquifier(["call_9"]);
		const e = u.event(asEvent({ type: "message_end", message: assistantMsg("m1", ["toolu_abc"]) }));
		assert.equal(firstCallId(e), "toolu_abc");
	});

	it("a colliding id mints `orig~2` — on the message, the execution events, and the settle, identically", () => {
		const u = new ToolCallIdUniquifier(["call_0"]);
		const m1 = assistantMsg("m1", ["call_0"]);
		// the streaming shape: start/update/end — same logical message
		for (const t of ["message_start", "message_update", "message_end"]) {
			const e = u.event(asEvent({ type: t, message: m1 }));
			assert.equal(firstCallId(e), "call_0~2", `${t} shows the mint`);
		}
		const exec = u.event(asEvent({ type: "tool_execution_end", toolCallId: "call_0", toolName: "quiz", result: null, isError: false })) as { toolCallId: string };
		assert.equal(exec.toolCallId, "call_0~2");
		// settle: the SAME mint, paired call + result (m1 is the state object)
		const settled = u.remapSettled([m1, toolResultMsg("call_0")]) as Array<{
			role: string;
			content?: Array<{ id: string }>;
			toolCallId?: string;
		}>;
		assert.equal(settled[0]!.content![0]!.id, "call_0~2");
		assert.equal(settled[1]!.toolCallId, "call_0~2");
	});

	it("the same id in a SECOND message of the turn (a retry step) gets its own mint", () => {
		const u = new ToolCallIdUniquifier(["call_0"]);
		const m1 = assistantMsg("m1", ["call_0"]);
		const m2 = assistantMsg("m2", ["call_0"]);
		u.event(asEvent({ type: "message_end", message: m1 }));
		// message_start opens the second message's epoch (the loop's shape)
		u.event(asEvent({ type: "message_start", message: assistantMsg("m2", []) }));
		assert.equal(firstCallId(u.event(asEvent({ type: "message_end", message: m2 }))), "call_0~3");
		// each result pairs with ITS message's call (the scope walk)
		const settled = u.remapSettled([m1, toolResultMsg("call_0"), m2, toolResultMsg("call_0")]) as Array<{
			role: string;
			content?: Array<{ id: string }>;
			toolCallId?: string;
		}>;
		assert.equal(settled[0]!.content![0]!.id, "call_0~2");
		assert.equal(settled[1]!.toolCallId, "call_0~2");
		assert.equal(settled[2]!.content![0]!.id, "call_0~3");
		assert.equal(settled[3]!.toolCallId, "call_0~3");
	});

	it("mint candidates skip ids already used (a provider that counts globally can't be ambushed)", () => {
		const u = new ToolCallIdUniquifier(["call_0", "call_0~2"]);
		assert.equal(firstCallId(u.event(asEvent({ type: "message_end", message: assistantMsg("m1", ["call_0"]) }))), "call_0~3");
	});

	it("parallel calls in one message keep their distinct provider ids unless they collide", () => {
		const u = new ToolCallIdUniquifier(["call_1"]);
		const e = u.event(asEvent({ type: "message_end", message: assistantMsg("m1", ["call_0", "call_1"]) })) as unknown as {
			message: { content: Array<{ id: string }> };
		};
		assert.equal(e.message.content[0]!.id, "call_0", "non-colliding sibling untouched");
		assert.equal(e.message.content[1]!.id, "call_1~2", "colliding sibling minted");
	});

	it("agent_end carries the full state: prior-turn history verbatim, this turn remapped", () => {
		const priorTurn = [assistantMsg("m0", ["call_0"]), toolResultMsg("call_0")]; // legacy dupes in the record
		// seeded exactly as chat-handler seeds it: the record's ids
		const u = new ToolCallIdUniquifier(collectToolCallIds(priorTurn));
		const m1 = assistantMsg("m1", ["call_0"]);
		u.event(asEvent({ type: "message_end", message: m1 }));
		const e = u.event(asEvent({ type: "agent_end", messages: [...priorTurn, m1, toolResultMsg("call_0")] })) as unknown as {
			messages: Array<{ id?: string; role: string; content?: Array<{ id: string }>; toolCallId?: string }>;
		};
		// history is NEVER rewritten (its dupes heal at the fold, view.ts)
		assert.equal(e.messages[0]!.content![0]!.id, "call_0");
		assert.equal(e.messages[1]!.toolCallId, "call_0");
		// this turn's pair is the mint
		assert.equal(e.messages[2]!.content![0]!.id, "call_0~2");
		assert.equal(e.messages[3]!.toolCallId, "call_0~2");
	});

	it("turn_end remaps its message and toolResults together", () => {
		const u = new ToolCallIdUniquifier(["call_0"]);
		const m1 = assistantMsg("m1", ["call_0"]);
		u.event(asEvent({ type: "message_end", message: m1 }));
		const e = u.event(asEvent({ type: "turn_end", message: m1, toolResults: [toolResultMsg("call_0")] })) as unknown as {
			message: { content: Array<{ id: string }> };
			toolResults: Array<{ toolCallId: string }>;
		};
		assert.equal(e.message.content[0]!.id, "call_0~2");
		assert.equal(e.toolResults[0]!.toolCallId, "call_0~2");
	});

	it("non-message events pass through untouched", () => {
		const u = new ToolCallIdUniquifier([]);
		assert.deepEqual(u.event({ type: "agent_start" }), { type: "agent_start" });
	});
});

describe("collectToolCallIds (the seen-set seed)", () => {
	it("gathers call ids and result ids from a record", () => {
		const ids = collectToolCallIds([
			{ id: "a", role: "user", content: "hi" },
			assistantMsg("m1", ["call_0", "toolu_x"]),
			toolResultMsg("call_0"),
			{ id: "m2", role: "assistant", content: [{ type: "text", text: "no calls" }] },
		]);
		assert.deepEqual(ids, ["call_0", "toolu_x", "call_0"]);
	});
});
