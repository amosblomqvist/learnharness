import assert from "node:assert/strict";
import { test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import type { ImageContent } from "@earendil-works/pi-ai";
import { SessionModel } from "../components/session-core.ts";
import { newThinkingMessage, newUserMessage, type ChatInput, type LhMessage } from "../src/core/index.ts";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function image(width: number, height: number): ImageContent {
	const canvas = createCanvas(width, height), ctx = canvas.getContext("2d");
	ctx.fillStyle = "#11bb66"; ctx.fillRect(0, 0, width, height);
	return { type: "image", mimeType: "image/png", data: canvas.toBuffer("image/png").toString("base64") };
}
// Valid original and resized representations of the same synthetic solid-color
// image. No provider, server-store initialization or real learner data required.
const original = image(8, 4), processed = image(2, 1);
assert.notEqual(original.data, processed.data);

for (const type of ["text", "thinking"] as const) {
	test(`${type}: append-only canonical adoption must absorb a normalized image optimistic entry`, async () => {
		const ack = deferred<Response>();
		const canonical = { ...(type === "text" ? newUserMessage("same learner text", [processed]) : newThinkingMessage("problem", "same learner text", [processed])), id: "canonical-submission" } as LhMessage;
		const model = new SessionModel({ chatId: "chat", initialMessages: [], fetch: async url => {
			if (String(url) === "/api/chat") return ack.promise;
			if (String(url).endsWith("/stream")) return new Response("data: [DONE]\n\n");
			return Response.json({ messages: [canonical] });
		} });
		const input: ChatInput = type === "text" ? { type, text: "same learner text", images: [original] } : { type, problemCallId: "problem", text: "same learner text", images: [original] };
		const sending = model.send(input);
		assert.equal(model.getState().nativeMessages.length, 1, "instant original-image preview exists before acknowledgment");
		model.adoptRecord([canonical]);
		const busy = model.getState();
		ack.resolve(Response.json({ ok: true })); await sending;
		assert.equal(busy.nativeMessages.length, 1, "unacknowledged POST keeps its instant preview without duplicate normalized transcript input");
		assert.match(busy.nativeMessages[0]!.id, /^c_/);
		assert.equal(busy.canonicalMessages.length, 0, "deferred append is not certified as applied canonical authority");
		assert.equal(model.getState().nativeMessages.length, 1);
		assert.equal(model.getState().nativeMessages[0]!.id, canonical.id, "acknowledged send adopts fresh normalized canonical bytes");
	});
}

test("deferred append/replace GETs return no applied snapshot; read-only none remains available", async () => {
	const ack = deferred<Response>(); const canonical = { ...newUserMessage("normalized", [processed]), id: "canonical" } as LhMessage;
	const model = new SessionModel({ chatId: "chat", initialMessages: [], fetch: async url => String(url) === "/api/chat" ? ack.promise : String(url).endsWith("/stream") ? new Response("data: [DONE]\n\n") : Response.json({ messages: [canonical] }) });
	const sending = model.send({ type: "text", text: "normalized", images: [original] });
	assert.equal(await model.readRecord({ adoption: "append" }), undefined);
	assert.equal(await model.readRecord({ allowInFlight: true }), undefined);
	assert.equal((await model.readRecord({ adoption: "none" }))?.messages[0]!.id, "canonical");
	assert.equal(model.getState().canonicalMessages.length, 0);
	assert.match(model.getState().nativeMessages[0]!.id, /^c_/);
	ack.resolve(Response.json({ ok: true })); await sending;
	assert.equal(model.getState().nativeMessages[0]!.id, "canonical");
});

for (const type of ["text", "thinking"] as const) {
	for (const outcome of ["refusal", "lost-ack"] as const) {
		test(`${type}: ${outcome} refreshes canonical truth without clearing drafts or notifying acceptance`, async () => {
			let reject!: (error: unknown) => void; const ack = new Promise<Response>((_resolve, no) => { reject = no; }); const response = deferred<Response>();
			const canonical = { ...(type === "text" ? newUserMessage("learner draft", [processed]) : newThinkingMessage("problem", "learner draft", [processed])), id: "canonical" } as LhMessage;
			let posts = 0, reads = 0, callbacks = 0, draft = "learner draft", pending = true;
			const model = new SessionModel({ chatId: "chat", initialMessages: [], fetch: async url => {
				if (String(url) === "/api/chat") { posts++; return outcome === "refusal" ? response.promise : ack; }
				reads++; return Response.json({ messages: outcome === "lost-ack" ? [canonical] : [] });
			} });
			const input: ChatInput = type === "text" ? { type, text: draft, images: [original] } : { type, problemCallId: "problem", text: draft, images: [original] };
			const sending = model.send(input, () => { callbacks++; draft = ""; pending = false; });
			model.adoptRecord([canonical]); assert.equal(model.getState().canonicalMessages.length, 0);
			if (outcome === "refusal") response.resolve(new Response("refused", { status: 412 })); else reject(new Error("acknowledgment connection lost"));
			assert.equal(await sending, false);
			assert.equal(callbacks, 0); assert.equal(draft, "learner draft"); assert.equal(pending, true);
			assert.equal(posts, 1); assert.equal(reads, 1, "failure causes only one fresh read-only GET, never a resubmission");
			assert.deepEqual(model.getState().nativeMessages.map(message => message.id), outcome === "lost-ack" ? ["canonical"] : []);
		});
	}
}

test("failed refusal refresh retires only its own preview so a later normalized append cannot duplicate it", async () => {
	const preserved = { ...newUserMessage("earlier"), id: "earlier" } as LhMessage;
	const model = new SessionModel({ chatId: "chat", initialMessages: [preserved], fetch: async url => {
		if (String(url) === "/api/chat") throw new Error("lost acknowledgment");
		throw new Error("canonical refresh also unavailable");
	} });
	let callbacks = 0;
	assert.equal(await model.send({ type: "thinking", problemCallId: "problem", text: "retained", images: [original] }, () => { callbacks++; }), false);
	assert.deepEqual(model.getState().nativeMessages.map(message => message.id), ["earlier"]);
	const canonical = { ...newThinkingMessage("problem", "retained", [processed]), id: "normalized" } as LhMessage;
	model.adoptRecord([preserved, canonical]);
	assert.deepEqual(model.getState().nativeMessages.map(message => message.id), ["earlier", "normalized"]);
	assert.equal(callbacks, 0);
});

test("stop/supersession release only the old image owner; delayed ACK/GET cannot unblock or overwrite a newer owner", async () => {
	const oldAck = deferred<Response>(), newAck = deferred<Response>(), staleGet = deferred<Response>();
	const oldCanonical = { ...newUserMessage("old", [processed]), id: "old-canonical" } as LhMessage;
	const base = { ...newUserMessage("new owner base"), id: "new-base" } as LhMessage;
	const newCanonical = { ...newUserMessage("new", [processed]), id: "new-canonical" } as LhMessage;
	let posts = 0, reads = 0;
	const model = new SessionModel({ chatId: "chat", initialMessages: [], fetch: async url => {
		if (String(url) === "/api/chat") return ++posts === 1 ? oldAck.promise : newAck.promise;
		if (String(url).endsWith("/stream")) return new Response("data: [DONE]\n\n");
		return ++reads === 1 ? staleGet.promise : Response.json({ messages: [base, newCanonical] });
	} });
	const oldSend = model.send({ type: "text", text: "old", images: [original] });
	const oldRead = model.readRecord({ adoption: "append" });
	model.stop(); assert.equal(model.getState().nativeMessages.length, 0, "stop retires only the original image preview, without aborting POST");
	model.setMessages([base]); assert.equal(model.getState().canonicalMessages[0]!.id, "new-base", "old gate does not block the next owner");
	const newSend = model.send({ type: "text", text: "new", images: [original] });
	oldAck.resolve(Response.json({ ok: true })); assert.equal(await oldSend, true);
	assert.equal(await model.readRecord({ adoption: "append" }), undefined, "old ACK cannot release the newer unresolved image POST gate");
	assert.deepEqual(model.getState().canonicalMessages.map(message => message.id), ["new-base"]);
	newAck.resolve(Response.json({ ok: true })); assert.equal(await newSend, true);
	staleGet.resolve(Response.json({ messages: [oldCanonical] })); assert.equal(await oldRead, undefined);
	assert.deepEqual(model.getState().nativeMessages.map(message => message.id), ["new-base", "new-canonical"]);
});

test("replacement stream retires unresolved preview/gate, and an old delayed ACK cannot invalidate its terminal GET", async () => {
	const ack = deferred<Response>(), terminal = deferred<Response>(), readStarted = deferred<void>();
	const current = { ...newUserMessage("replacement stream truth", [processed]), id: "replacement-terminal" } as LhMessage;
	let reads = 0;
	const model = new SessionModel({ chatId: "chat", initialMessages: [], fetch: async (url, init) => {
		if (String(url) === "/api/chat") { assert.equal(init?.signal, undefined, "view supersession must not abort the accepted-POST path"); return ack.promise; }
		if (String(url).endsWith("/stream")) return new Response("data: [DONE]\n\n");
		reads++; readStarted.resolve(); return terminal.promise;
	} });
	const oldSend = model.send({ type: "text", text: "old preview", images: [original] });
	const replacement = model.resumeStream(false); await readStarted.promise;
	assert.equal(model.getState().nativeMessages.length, 0);
	ack.resolve(Response.json({ ok: true })); assert.equal(await oldSend, true);
	terminal.resolve(Response.json({ messages: [current] })); await replacement;
	assert.equal(reads, 1); assert.equal(model.getState().reconciliation, "ready");
	assert.deepEqual(model.getState().nativeMessages.map(message => message.id), ["replacement-terminal"]);
});

test("acknowledged image whose initial canonical refresh fails cannot duplicate a later normalized append", async () => {
	const canonical = { ...newUserMessage("accepted", [processed]), id: "accepted-canonical" } as LhMessage;
	let callbacks = 0;
	const model = new SessionModel({ chatId: "chat", initialMessages: [], fetch: async url => {
		if (String(url) === "/api/chat") return Response.json({ ok: true });
		throw new Error("initial post-ack canonical read unavailable");
	} });
	assert.equal(await model.send({ type: "text", text: "accepted", images: [original] }, () => { callbacks++; }), true);
	assert.equal(callbacks, 1); assert.equal(model.getState().nativeMessages.length, 0);
	model.adoptRecord([canonical]); assert.deepEqual(model.getState().nativeMessages.map(message => message.id), ["accepted-canonical"]);
});
