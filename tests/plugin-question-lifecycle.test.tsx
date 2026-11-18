import assert from "node:assert/strict";
import React, { act, useEffect } from "react";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useChatSession } from "../components/session.ts";
import { pendingPluginQuestionOf, type LhMessage, type PluginQuestionSnapshot } from "../src/core/index.ts";

const deferred = <T,>() => {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
};
const snapshot: PluginQuestionSnapshot = {
	protocolVersion: 1, pluginId: "fixture", typeId: "code", label: "Code", variant: "probe", questionId: "q1", contractVersion: 1,
	occurrence: { messageId: "a", contentIndex: 0, toolCallId: "call", toolName: "code" },
	input: { question: "Synthetic question", payload: {} }, questionSchema: { type: "object" }, answerSchema: { type: "string" },
	showThinking: false, requiresAnswerRefinement: false,
};
const record = [{ id: "a", role: "assistant", content: [{ type: "toolCall", id: "call", name: "code", arguments: snapshot.input }], stopReason: "toolUse", timestamp: 1, lhQuestions: { "0": snapshot } }] as unknown as LhMessage[];
const saved = () => Response.json({ messages: record, pluginQuestionAvailability: { questionId: "q1", status: "available" } });

type Session = ReturnType<typeof useChatSession>;
async function fixture(strict: boolean, run: (f: {
	requests: { url: string; method: string; response: ReturnType<typeof deferred<Response>> }[];
	state(): Session;
	render(visible?: boolean): Promise<void>;
	respond(index: number): Promise<void>;
	fail(index: number): Promise<void>;
	retry(): Promise<void>;
}) => Promise<void>) {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	const requests: { url: string; method: string; response: ReturnType<typeof deferred<Response>> }[] = [];
	const globals = {
		React, window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: ((url: Parameters<typeof fetch>[0], options?: RequestInit) => {
			const response = deferred<Response>();
			requests.push({ url: String(url), method: options?.method ?? "GET", response });
			return response.promise;
		}) as typeof fetch,
	};
	const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const root = createRoot(document.querySelector("#root")!);
	let current!: Session;
	function Boundary() {
		const state = useChatSession({ chatId: "fixture", initialMessages: record, initiallyInFlight: false });
		current = state;
		// The production Chat effect's stable identity: reconnecting effects
		// must request fresh authority even for the same retained question.
		const identity = pendingPluginQuestionOf(state.canonicalMessages)?.questionId ?? null;
		useEffect(() => { if (identity) void state.reconcile(); }, [identity, state.reconcile]);
		return <output>{state.reconciliation}:{state.pluginQuestionAvailability?.status ?? "unknown"}</output>;
	}
	const render = async (visible = true) => {
		await act(async () => {
			root.render(strict ? <React.StrictMode><Boundary /></React.StrictMode> : <React.Activity mode={visible ? "visible" : "hidden"}><Boundary /></React.Activity>);
		});
	};
	try {
		await render();
		await run({
			requests, state: () => current, render,
			respond: async index => { await act(async () => { requests[index]!.response.resolve(saved()); }); },
			fail: async index => { await act(async () => { requests[index]!.response.reject(new Error("offline")); }); },
			retry: async () => {
				await act(async () => {
					const retry = current.reconcile();
					requests.at(-1)!.response.resolve(saved());
					assert.equal(await retry, true);
				});
			},
		});
		assert.ok(requests.every(request => request.method === "GET" && request.url === "/api/chats/fixture"), "reconnection/retry must never POST a teacher turn");
	} finally {
		await act(async () => { root.unmount(); });
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
}

for (const completion of ["success", "failure"] as const) test(`StrictMode reconnect ignores detached ${completion} and adopts the fresh canonical read`, async () => {
	await fixture(true, async f => {
		assert.equal(f.requests.length, 2, "effect replay starts a replacement GET, not a join of the detached null-owner task");
		const draft = f.state().pluginQuestionDraft(snapshot);
		draft.answer = { status: "unready", value: "local code draft" };
		if (completion === "success") await f.respond(0); else await f.fail(0);
		assert.equal(f.state().reconciliation, "syncing");
		assert.equal(f.state().pluginQuestionAvailability, undefined);
		await f.respond(1);
		assert.equal(f.state().reconciliation, "ready");
		assert.equal(f.state().pluginQuestionAvailability?.status, "available");
		assert.equal(f.state().pluginQuestionDraft(snapshot), draft);
	});
});

for (const timing of ["while hidden", "after reveal", "after replacement"] as const) {
	for (const completion of ["success", "failure"] as const) test(`Activity reconnect: detached ${completion} ${timing} cannot settle replacement authority`, async () => {
		await fixture(false, async f => {
			assert.equal(f.requests.length, 1);
			const draft = f.state().pluginQuestionDraft(snapshot);
			draft.thinking = "retained thinking";
			await f.render(false);
			const finishOld = () => completion === "success" ? f.respond(0) : f.fail(0);
			if (timing === "while hidden") await finishOld();
			await f.render(true);
			assert.equal(f.requests.length, 2);
			assert.equal(f.state().reconciliation, "syncing");
			if (timing === "after reveal") { await finishOld(); assert.equal(f.state().reconciliation, "syncing"); }
			await f.respond(1);
			if (timing === "after replacement") await finishOld();
			assert.equal(f.state().reconciliation, "ready");
			assert.equal(f.state().pluginQuestionAvailability?.status, "available");
			assert.equal(f.state().pluginQuestionDraft(snapshot), draft);
			assert.equal(draft.thinking, "retained thinking");
		});
	});
}

test("Activity reconnect refreshes an already settled question without discarding its draft", async () => {
	await fixture(false, async f => {
		await f.respond(0);
		assert.equal(f.state().reconciliation, "ready");
		const draft = f.state().pluginQuestionDraft(snapshot);
		draft.answer = { status: "ready", value: "answer" };
		await f.render(false); await f.render(true);
		assert.equal(f.requests.length, 2);
		await f.respond(1);
		assert.equal(f.state().reconciliation, "ready");
		assert.equal(f.state().pluginQuestionAvailability?.status, "available");
		assert.equal(f.state().pluginQuestionDraft(snapshot), draft);
	});
});

test("a genuine current offline failure remains failed until explicit read-only Retry", async () => {
	await fixture(false, async f => {
		await f.fail(0);
		assert.equal(f.state().reconciliation, "failed");
		assert.equal(f.state().pluginQuestionAvailability, undefined);
		await f.render();
		assert.equal(f.requests.length, 1, "ordinary renders do not automatically retry a genuine failure");
		await f.retry();
		assert.equal(f.requests.length, 2);
		assert.equal(f.state().reconciliation, "ready");
		assert.equal(f.state().pluginQuestionAvailability?.status, "available");
	});
});
