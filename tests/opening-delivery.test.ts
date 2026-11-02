import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionModel } from "../components/session-core.ts";
import { newUserMessage } from "../src/core/native-messages.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

describe("new-session opening delivery acceptance", () => {
	it("notifies acceptance before the record read or teacher stream completes", async () => {
		const record = deferred<Response>();
		const accepted = deferred<void>();
		const calls: string[] = [];
		const m = new SessionModel({ chatId: "c1", initialMessages: [], fetch: async url => {
			calls.push(String(url));
			if (String(url) === "/api/chat") return Response.json({ ok: true });
			if (String(url).endsWith("/stream")) return new Response("data: [DONE]\n\n");
			return record.promise;
		} });
		let completed = false;
		const sending = m.send({ type: "text", text: "my syllabus" }, () => accepted.resolve()).then(result => { completed = true; return result; });
		await accepted.promise;
		assert.equal(completed, false);
		assert.equal(m.getState().hasConfirmedConversation, false, "optimistic user text is not canonical proof");
		record.resolve(Response.json({ messages: [newUserMessage("my syllabus")] }));
		assert.equal(await sending, true);
		assert.equal(m.getState().hasConfirmedConversation, true);
		assert.equal(calls.filter(url => url === "/api/chat").length, 1);
	});

	it("a teardown racing the POST still cleans up on acknowledgment without attaching", async () => {
		const post = deferred<Response>();
		let notified = 0;
		const m = new SessionModel({ chatId: "c1", initialMessages: [], fetch: async url => {
			assert.equal(String(url), "/api/chat");
			return post.promise;
		} });
		const sending = m.send({ type: "text", text: "hello" }, () => { notified++; });
		m.stop();
		post.resolve(Response.json({ ok: true }));
		assert.equal(await sending, true);
		assert.equal(notified, 1);
	});

	for (const failure of ["refusal", "409", "lost acknowledgment"] as const) {
		it(`${failure} does not notify acceptance or leave a false confirmed conversation`, async () => {
			let notified = false;
			const m = new SessionModel({ chatId: "c1", initialMessages: [], waitMaxMs: 0, fetch: async () => {
				if (failure === "lost acknowledgment") throw new TypeError("connection lost");
				return new Response("refused", { status: failure === "409" ? 409 : 503 });
			} });
			assert.equal(await m.send({ type: "text", text: "keep this" }, () => { notified = true; }), false);
			assert.equal(notified, false);
			assert.equal(m.getState().hasConfirmedConversation, false);
			assert.equal(m.getState().nativeMessages.length, 0, "restore the opening draft, not a stranded optimistic bubble");
			assert.equal(m.status, "error");
		});
	}

	for (const failure of ["network", "503"] as const) {
		it(`a teardown racing an opening ${failure} failure restores the bubble/error recovery state`, async () => {
			const post = deferred<Response>();
			let notified = 0;
			const envelope = JSON.stringify({ code: "models_not_configured", missing: ["strong"] });
			const m = new SessionModel({ chatId: "c1", initialMessages: [], fetch: async url => {
				assert.equal(String(url), "/api/chat", "failure must not attach or resend");
				return post.promise;
			} });
			const sending = m.send({ type: "text", text: "recover this opening" }, () => { notified++; });
			m.stop(); // StrictMode's cleanup detaches the consume, NOT this POST.
			if (failure === "network") post.reject(new TypeError("opening connection lost"));
			else post.resolve(new Response(envelope, { status: 503 }));
			assert.equal(await sending, false);
			assert.equal(notified, 0);
			assert.equal(m.getState().nativeMessages.length, 0, "no stranded optimistic opening bubble");
			assert.equal(m.status, "error");
			assert.equal(m.getState().error?.message, failure === "network" ? "opening connection lost" : envelope,
				"the raw refusal must reach the existing setup-recovery effect");
		});

		it(`an older opening ${failure} failure removes only its own bubble while a newer send owns state`, async () => {
			const first = deferred<Response>();
			const second = deferred<Response>();
			let posts = 0;
			const m = new SessionModel({ chatId: "c1", initialMessages: [], fetch: async url => {
				assert.equal(String(url), "/api/chat");
				return ++posts === 1 ? first.promise : second.promise;
			} });
			const older = m.send({ type: "text", text: "older opening" }, () => assert.fail("not accepted"));
			m.stop();
			const newer = m.send({ type: "text", text: "newer text" });
			if (failure === "network") first.reject(new TypeError("older lost acknowledgment"));
			else first.resolve(new Response("older refusal", { status: 503 }));
			assert.equal(await older, false);
			assert.equal(m.status, "submitted", "older failure must not settle the newer send");
			assert.equal(m.getState().error, null);
			assert.deepEqual(m.getState().nativeMessages.map(message => message.content), ["newer text"]);
			second.resolve(new Response("newer failure", { status: 503 }));
			assert.equal(await newer, false);
			assert.equal(m.getState().error?.message, "newer failure");
			assert.deepEqual(m.getState().nativeMessages.map(message => message.content), ["newer text"],
				"ordinary text retains its existing optimistic failure presentation");
		});
	}

	it("a newer send remains the owner even after it fails and is stopped", async () => {
		const first = deferred<Response>();
		let posts = 0;
		const m = new SessionModel({ chatId: "c1", initialMessages: [], fetch: async () => {
			return ++posts === 1 ? first.promise : new Response("newer failure", { status: 503 });
		} });
		const older = m.send({ type: "text", text: "older opening" }, () => assert.fail("not accepted"));
		m.stop();
		await m.send({ type: "text", text: "newer text" });
		m.stop();
		first.reject(new TypeError("older failure"));
		assert.equal(await older, false);
		assert.equal(m.status, "ready");
		assert.equal(m.getState().error?.message, "newer failure");
		assert.deepEqual(m.getState().nativeMessages.map(message => message.content), ["newer text"]);
	});

	it("a replacement reattach owns state instead of the older stopped opening POST", async () => {
		const post = deferred<Response>();
		const record = deferred<Response>();
		const saved = newUserMessage("server-owned text");
		const m = new SessionModel({ chatId: "c1", initialMessages: [], fetch: async url => {
			if (String(url) === "/api/chat") return post.promise;
			if (String(url).endsWith("/stream")) return new Response("data: [DONE]\n\n");
			return record.promise;
		} });
		const older = m.send({ type: "text", text: "older opening" }, () => assert.fail("not accepted"));
		m.stop();
		const replacement = m.resumeStream();
		post.reject(new TypeError("older failure"));
		assert.equal(await older, false);
		assert.equal(m.status, "submitted");
		assert.equal(m.getState().error, null);
		record.resolve(Response.json({ messages: [saved] }));
		await replacement;
		assert.equal(m.status, "ready");
		assert.deepEqual(m.getState().nativeMessages, [saved]);
		assert.equal(m.getState().error, null);
	});

	it("a stopped replacement reattach still supersedes the older opening refusal", async () => {
		const post = deferred<Response>();
		const record = deferred<Response>();
		const m = new SessionModel({ chatId: "c1", initialMessages: [], fetch: async url => {
			return String(url) === "/api/chat" ? post.promise : record.promise;
		} });
		const older = m.send({ type: "text", text: "older opening" }, () => assert.fail("not accepted"));
		m.stop();
		const replacement = m.resumeStream();
		m.stop();
		post.resolve(new Response("older refusal", { status: 503 }));
		assert.equal(await older, false);
		assert.equal(m.status, "ready");
		assert.equal(m.getState().error, null);
		assert.equal(m.getState().nativeMessages.length, 0);
		record.resolve(Response.json({ messages: [] }));
		await replacement;
		assert.equal(m.status, "ready");
		assert.equal(m.getState().error, null);
	});

	it("a stopped ordinary text failure retains the pre-existing teardown behavior", async () => {
		const post = deferred<Response>();
		const m = new SessionModel({ chatId: "c1", initialMessages: [], fetch: async () => post.promise });
		const sending = m.send({ type: "text", text: "ordinary text" });
		m.stop();
		post.reject(new TypeError("connection lost"));
		assert.equal(await sending, false);
		assert.equal(m.status, "ready");
		assert.equal(m.getState().error, null);
		assert.deepEqual(m.getState().nativeMessages.map(message => message.content), ["ordinary text"]);
	});

	it("post-acceptance attachment failure remains accepted and does not resend input", async () => {
		let posts = 0;
		let notified = 0;
		const m = new SessionModel({ chatId: "c1", initialMessages: [], fetch: async url => {
			if (String(url) === "/api/chat") { posts++; return Response.json({ ok: true }); }
			throw new TypeError("record read failed");
		} });
		assert.equal(await m.send({ type: "text", text: "hello" }, () => { notified++; }), true);
		assert.equal(notified, 1);
		assert.equal(posts, 1);
		assert.equal(m.status, "error");
	});

	it("a busy gate sends nothing, then canonical adoption can confirm an earlier lost acknowledgment", async () => {
		const m = new SessionModel({ chatId: "c1", initialMessages: [], fetch: async () => { throw new Error("must not post"); } });
		m.readyRef = false;
		assert.equal(await m.send({ type: "text", text: "hello" }, () => assert.fail("must not acknowledge")), false);
		m.setMessages([newUserMessage("hello")]);
		assert.equal(m.getState().hasConfirmedConversation, true);
	});
});
