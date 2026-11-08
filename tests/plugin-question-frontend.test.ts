import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createQuestionEditorLease, controlledPluginAnswer } from "../components/plugin-question-editor.ts";
import { capturePluginQuestionKey, ownPluginQuestionKeys, pluginQuestionKeySuppressed } from "../components/plugin-question-keys.ts";
import { SessionModel } from "../components/session-core.ts";
import { PluginFrontendManager } from "../components/plugin-manager.ts";
import type { LhMessage, PluginInfo } from "../src/core/index.ts";
import type { PluginQuestionSnapshot, PluginQuestionEditorHandle, PluginQuestionEditorProps } from "../src/core/plugin-questions.ts";

const snapshot: PluginQuestionSnapshot = {
	protocolVersion: 1, pluginId: "fixture", typeId: "code", label: "Code", variant: "probe", questionId: "q1", contractVersion: 1,
	occurrence: { messageId: "a1", contentIndex: 0, toolCallId: "call", toolName: "fixture_question" },
	input: { question: "Public question", payload: { reference: "PRIVATE" } }, questionSchema: { type: "object" }, answerSchema: { type: "string" }, showThinking: false, requiresAnswerRefinement: false,
};
const record = [{ id: "a1", role: "assistant", content: [{ type: "toolCall", id: "call", name: "fixture_question", arguments: snapshot.input }], stopReason: "toolUse", timestamp: 0, lhQuestions: { "0": snapshot } }] as unknown as LhMessage[];
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const handle = (dispose = () => {}): PluginQuestionEditorHandle => ({ update() {}, focus() {}, dispose });
const keyEvent = (key: string, extra = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 0, target: null, defaultPrevented: false, preventDefault(this: { defaultPrevented: boolean }) { this.defaultPrevented = true; }, ...extra }) as unknown as KeyboardEvent;
const props = (): PluginQuestionEditorProps => ({ input: snapshot.input, chatId: "chat", questionId: "q1", contractVersion: 1, variant: "probe", signal: new AbortController().signal, answer: { status: "empty" }, active: true, onChange() {} });

describe("bounded plugin question frontend", () => {
	it("publishes synchronously, requires adopted current handle and preserves every finite JSON falsy answer", () => {
		let answer: unknown;
		const lease = createQuestionEditorLease({ props: props(), publish: value => { answer = value; }, changed() {}, failed() { assert.fail("unexpected failure"); } });
		for (const value of [false, 0, null, "", [], "  code\n"]) {
			lease.props.onChange({ status: "ready", value });
			assert.deepEqual(answer, { status: "ready", value });
			assert.equal(lease.ready, false);
		}
		lease.adopt(handle()); assert.equal(lease.ready, true);
		lease.props.onChange({ status: "empty" }); assert.equal(lease.ready, false);
		assert.deepEqual(controlledPluginAnswer({ status: "empty", value: 42 } as never), { status: "empty" });
		assert.throws(() => controlledPluginAnswer({ status: "ready", value: Infinity }));
		lease.dispose();
	});
	it("drops stale publications and disposes handles returned after async abort", () => {
		let published = 0, disposed = 0;
		const lease = createQuestionEditorLease({ props: props(), publish() { published++; }, changed() {}, failed() {} });
		lease.dispose();
		assert.equal(lease.props.signal.aborted, true);
		lease.props.onChange({ status: "ready", value: "old" });
		lease.adopt(handle(() => { disposed++; }));
		assert.equal(disposed, 1); assert.equal(published, 0); assert.equal(lease.ready, false);
	});
	it("awaits async transcript publication before the submission snapshot", async () => {
		const delivery = deferred<void>(); let value = "";
		const lease = createQuestionEditorLease({ props: props(), publish(answer) { if (answer.status !== "empty") value = String(answer.value); }, changed() {}, failed() {} });
		lease.adopt({ ...handle(), async appendTranscript(text) { await delivery.promise; lease.props.onChange({ status: "ready", value: text }); } });
		const pending = lease.append("final chunk"); assert.equal(value, "");
		delivery.resolve(); await pending; assert.equal(value, "final chunk"); assert.equal(lease.ready, true);
	});
	it("privately claims editing keys once without confusing prevented Tab and preserves composing Enter default", () => {
		let calls = 0, cycles = 0, submits = 0, inside = true, eligible = true;
		const off = ownPluginQuestionKeys({ eligible: () => eligible, contains: () => inside, key() { calls++; return "handled"; }, cycle() { cycles++; }, submit() { submits++; } });
		const event = (key: string, extra = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 0, target: null, defaultPrevented: false, preventDefault(this: { defaultPrevented: boolean }) { this.defaultPrevented = true; }, ...extra }) as unknown as KeyboardEvent;
		const tab = event("Tab"); capturePluginQuestionKey(tab); assert.equal(pluginQuestionKeySuppressed(tab), true); assert.equal(calls, 1); assert.equal(cycles, 0);
		const nativePrevented = event("Tab", { defaultPrevented: true }); assert.equal(pluginQuestionKeySuppressed(nativePrevented), false);
		const ime = event("Enter", { isComposing: true }); capturePluginQuestionKey(ime); assert.equal(pluginQuestionKeySuppressed(ime), true); assert.equal(ime.defaultPrevented, false); assert.equal(calls, 1);
		capturePluginQuestionKey(event("Tab", { shiftKey: true })); assert.equal(calls, 1);
		capturePluginQuestionKey(event("Enter", { ctrlKey: true })); assert.equal(submits, 1); assert.equal(calls, 1);
		inside = false; capturePluginQuestionKey(event("Tab")); assert.equal(cycles, 1);
		eligible = false; capturePluginQuestionKey(event("Enter")); assert.equal(calls, 1); off();
	});
	for (const hook of ["absent", "pass"] as const) it(`${hook} key hook delegates Enter submission and Shift+Enter editing to host defaults`, () => {
		let submits = 0;
		const lease = createQuestionEditorLease({ props: props(), publish() {}, changed() {}, failed() { assert.fail("unexpected failure"); } });
		lease.adopt({ ...handle(), ...(hook === "pass" ? { handleKeyDown: () => "pass" as const } : {}) });
		const off = ownPluginQuestionKeys({ eligible: () => true, contains: () => true, key: key => lease.key(key), cycle() {}, submit() { submits++; } });
		const event = (extra = {}) => ({ key: "Enter", defaultPrevented: false, preventDefault(this: { defaultPrevented: boolean }) { this.defaultPrevented = true; }, ...extra }) as unknown as KeyboardEvent;
		try {
			const enter = event(); capturePluginQuestionKey(enter);
			assert.equal(enter.defaultPrevented, true); assert.equal(pluginQuestionKeySuppressed(enter), true); assert.equal(submits, 1);
			const newline = event({ shiftKey: true }); capturePluginQuestionKey(newline);
			assert.equal(newline.defaultPrevented, false); assert.equal(pluginQuestionKeySuppressed(newline), true); assert.equal(submits, 1);
			for (const extra of [{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }]) {
				const chord = event(extra); capturePluginQuestionKey(chord); assert.equal(chord.defaultPrevented, true);
			}
			assert.equal(submits, 4);
			for (const extra of [{ altKey: true }, { ctrlKey: true, altKey: true }, { isComposing: true }, { keyCode: 229 }]) {
				const editing = event(extra); capturePluginQuestionKey(editing); assert.equal(editing.defaultPrevented, false);
			}
			assert.equal(submits, 4);
		} finally { off(); lease.dispose(); }
	});
	it("an explicit handled Enter overrides the host default, but cannot override reserved submit chords", () => {
		const calls: string[] = []; let submits = 0;
		const off = ownPluginQuestionKeys({ eligible: () => true, contains: () => true, key(key) { calls.push(key); return "handled"; }, cycle() {}, submit() { submits++; } });
		const event = (extra = {}) => ({ key: "Enter", defaultPrevented: false, preventDefault(this: { defaultPrevented: boolean }) { this.defaultPrevented = true; }, ...extra }) as unknown as KeyboardEvent;
		try {
			const enter = event(); capturePluginQuestionKey(enter); assert.equal(enter.defaultPrevented, true); assert.equal(submits, 0); assert.deepEqual(calls, ["Enter"]);
			const chord = event({ metaKey: true }); capturePluginQuestionKey(chord); assert.equal(chord.defaultPrevented, true); assert.equal(submits, 1); assert.deepEqual(calls, ["Enter"]);
		} finally { off(); }
	});
	for (const hook of ["absent", "pass"] as const) it(`${hook} Escape hook yields the same event to local host navigation, not submit or global abort`, () => {
		const calls: string[] = []; let cycles = 0, submits = 0;
		const lease = createQuestionEditorLease({ props: props(), publish() {}, changed() {}, failed() { assert.fail("unexpected failure"); } });
		lease.adopt({ ...handle(), ...(hook === "pass" ? { handleKeyDown(key) { calls.push(key); return "pass" as const; } } : {}) });
		const off = ownPluginQuestionKeys({ eligible: () => true, contains: () => true, key: key => lease.key(key), cycle() { cycles++; }, submit() { submits++; } });
		try {
			const escape = keyEvent("Escape"); capturePluginQuestionKey(escape);
			assert.equal(escape.defaultPrevented, true);
			assert.equal(pluginQuestionKeySuppressed(escape), true);
			assert.equal(pluginQuestionKeySuppressed({ nativeEvent: escape }), true, "React and global listeners see the same claim");
			assert.equal(cycles, 1); assert.equal(submits, 0);
			assert.deepEqual(calls, hook === "pass" ? ["Escape"] : []);
		} finally { off(); lease.dispose(); }
	});
	it("handled Escape stays with the editor; modified, composing, ineligible and non-editor Escape never navigate", () => {
		const calls: string[] = []; let cycles = 0, eligible = true, inside = true;
		const off = ownPluginQuestionKeys({ eligible: () => eligible, contains: () => inside, key(key) { calls.push(key); return "handled"; }, cycle() { cycles++; }, submit() { assert.fail("Escape must not submit"); } });
		try {
			const escape = keyEvent("Escape"); capturePluginQuestionKey(escape);
			assert.equal(escape.defaultPrevented, true); assert.equal(pluginQuestionKeySuppressed(escape), true);
			for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }]) {
				const untouched = keyEvent("Escape", extra); capturePluginQuestionKey(untouched);
				assert.equal(untouched.defaultPrevented, false);
				assert.equal(pluginQuestionKeySuppressed(untouched), "isComposing" in extra || "keyCode" in extra);
			}
			eligible = false; const inactive = keyEvent("Escape"); capturePluginQuestionKey(inactive);
			assert.equal(inactive.defaultPrevented, false); assert.equal(pluginQuestionKeySuppressed(inactive), false);
			eligible = true; inside = false; const outside = keyEvent("Escape"); capturePluginQuestionKey(outside);
			assert.equal(outside.defaultPrevented, false); assert.equal(pluginQuestionKeySuppressed(outside), false);
			assert.deepEqual(calls, ["Escape"]); assert.equal(cycles, 0);
		} finally { off(); }
	});
	it("terminal readiness waits explicit GET adoption even without any global settlement event", async () => {
		const saved = deferred<Response>(); const requests: string[] = [];
		const model = new SessionModel({ chatId: "chat", initialMessages: [], fetch: async url => { requests.push(String(url)); return saved.promise; } });
		model.applyWireEvent({ type: "message_end", message: record[0] });
		const terminal = model.consumeStream(new Response("data: [DONE]\n\n"));
		await tick(); assert.equal(model.readyRef, false); assert.equal(model.getState().reconciliation, "syncing");
		assert.equal(model.getState().canonicalMessages.length, 0);
		saved.resolve(Response.json({ messages: record, pluginQuestionAvailability: { questionId: "q1", status: "available" } }));
		await terminal; assert.equal(model.readyRef, true); assert.equal(model.getState().canonicalMessages[0]!.id, "a1");
		assert.deepEqual(requests, ["/api/chats/chat"]);
	});
	it("a superseded terminal GET cannot overwrite or invoke settlement for its replacement consume", async () => {
		const stale = deferred<Response>(); const readStarted = deferred<void>();
		let streams = 0, reads = 0, settled = 0;
		const model = new SessionModel({ chatId: "chat", initialMessages: [], onReattachSettled() { settled++; }, fetch: async url => {
			if (String(url).endsWith("/stream")) { streams++; return new Response("data: [DONE]\n\n"); }
			if (++reads === 1) { readStarted.resolve(); return stale.promise; }
			return Response.json({ messages: [{ id: "replacement", role: "user", content: "current", timestamp: 1 }] });
		} });
		const first = model.resumeStream(false); await readStarted.promise;
		await model.resumeStream(false);
		stale.resolve(Response.json({ messages: record })); await first;
		assert.equal(model.getState().canonicalMessages[0]!.id, "replacement"); assert.equal(model.readyRef, true); assert.equal(streams, 2); assert.equal(settled, 1);
	});
	it("GET failure remains gated and reconciliation retry never POSTs a teacher turn", async () => {
		let fail = true; const requests: string[] = [];
		const model = new SessionModel({ chatId: "chat", initialMessages: record, fetch: async url => { requests.push(String(url)); if (fail) throw new Error("offline"); return Response.json({ messages: record }); } });
		assert.equal(model.readyRef, false); await model.reconcile();
		assert.equal(model.getState().reconciliation, "failed");
		assert.equal(await model.send({ type: "continue" }), false);
		fail = false; await model.reconcile();
		assert.equal(model.getState().reconciliation, "ready");
		assert.deepEqual(requests, ["/api/chats/chat", "/api/chats/chat"]);
		assert.equal(model.getState().pluginQuestionAvailability, undefined);
	});
	it("draft identity survives repeated canonical adoption and native duplicate IDs do not cross occurrences", async () => {
		const model = new SessionModel({ chatId: "chat", initialMessages: record, fetch: async () => Response.json({ messages: record }) });
		const draft = model.pluginQuestionDraft(snapshot); draft.answer = { status: "unready", value: "  incomplete\n" }; draft.thinking = "";
		await model.reconcile(); assert.equal(model.pluginQuestionDraft(snapshot), draft);
		assert.notEqual(model.pluginQuestionDraft({ ...snapshot, occurrence: { ...snapshot.occurrence, messageId: "newer" } }), draft);
		assert.equal(await model.send({ type: "answer", toolCallId: "call", answer: {} as never }), false);
	});
	it("renderer registrations are owner scoped, validated, receiver-bound and removed with activation", async () => {
		const info = (id: string): PluginInfo => ({ id, origin: "community", enabled: true, status: "active", revision: "1", manifest: { apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.3.7", main: "index.js" } });
		const manager = new PluginFrontendManager({ fetch: async () => Response.json({}), pathname: () => "/", navigate() {}, async importModule() { return { activate(context) { const renderer = { id: "code", supportedContractVersions: [1], mountAnswerEditor() { assert.equal(this.id, "code"); return handle(); } }; context.registerQuestionRenderer(renderer); } }; } });
		manager.reconcile([info("one"), info("two")]); await tick();
		const registrations = manager.getSnapshot().questionRenderers!; assert.equal(registrations.length, 2);
		assert.deepEqual(registrations.map(r => r.pluginId), ["one", "two"]);
		registrations[0]!.renderer.mountAnswerEditor({} as HTMLElement, props());
		manager.reconcile([info("two")]); assert.equal(manager.getSnapshot().questionRenderers!.length, 1); manager.dispose();
	});
});
