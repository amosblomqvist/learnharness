import React, { act, StrictMode, type ReactNode } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { PluginQuestionAnswered, PluginQuestionPresentation } from "../components/plugin-question-slots.tsx";
import type { PluginCleanup, PluginQuestionAnswer, PluginQuestionRenderer, PluginQuestionSnapshot } from "../src/core/index.ts";
import type { QuestionRendererRegistration } from "../components/plugin-manager.ts";

(globalThis as Record<string, unknown>).React = React;

const snapshot: PluginQuestionSnapshot = {
	protocolVersion: 2, requiresGrading: true, pluginId: "fixture", typeId: "code", label: "Code", variant: "probe", questionId: "q1", contractVersion: 1,
	occurrence: { messageId: "assistant", contentIndex: 0, toolCallId: "call", toolName: "code" },
	input: { question: "Saved question", payload: { nested: [1] } },
	questionSchema: { type: "object" }, answerSchema: { type: "object" }, showThinking: false, requiresAnswerRefinement: false,
};
const answer: PluginQuestionAnswer = {
	kind: "plugin-question", questionId: "q1", pluginId: "fixture", typeId: "code", contractVersion: 1,
	answer: { source: "saved code" }, grading: { result: { tests: [false, null] } }, answeredAt: "2026-11-03T12:00:00.000Z",
};
type AnsweredContext = Parameters<NonNullable<PluginQuestionRenderer["mountAnswered"]>>[1];
const registration = (mountAnswered: NonNullable<PluginQuestionRenderer["mountAnswered"]>): QuestionRendererRegistration => ({
	pluginId: "fixture", renderer: { id: "code", supportedContractVersions: [1], mountAnswerEditor() { throw new Error("not an editor"); }, mountAnswered },
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });
async function harness() {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ window: dom.window, document: dom.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(dom.document.getElementById("root")!);
	let closed = false;
	cleanup = async () => {
		if (closed) return;
		closed = true;
		try { await act(async () => { root.unmount(); }); }
		finally { for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		} }
	};
	return { document: dom.document, render: async (node: ReactNode) => { await act(async () => { root.render(node); }); }, close: cleanup };
}
function card(renderer?: QuestionRendererRegistration) {
	return <PluginQuestionAnswered snapshot={snapshot} answer={answer} chatId="chat" registration={renderer} />;
}
function hostHeading(document: Document) {
	return document.querySelector('[data-testid="plugin-question-answered"]')!.firstElementChild!;
}
function paint(body: HTMLElement, context: AnsweredContext, text: string) {
	body.textContent = `body ${text}`;
	assert.ok(context.headerContainer, "answered host supplies the optional header suffix");
	context.headerContainer.textContent = `badge ${text}`;
	assert.ok(context.footerContainer, "answered host supplies the optional footer");
	context.footerContainer.textContent = `footer ${text}`;
}

test("answered header is an isolated inline suffix after the untouched host label; JSON stays frozen and capabilities stay live", async () => {
	const h = await harness();
	let body!: HTMLElement, context!: AnsweredContext;
	let disposed = 0, aborted = 0;
	await h.render(card(registration((container, props) => {
		body = container; context = props; paint(container, props, "current");
		props.signal.addEventListener("abort", () => { aborted++; });
		return () => { disposed++; props.headerContainer!.replaceChildren(); container.replaceChildren(); };
	})));
	assert.ok(context, "renderer ran");
	const heading = hostHeading(h.document);
	assert.ok(heading.classList.contains("flex"));
	assert.ok(heading.classList.contains("items-center"));
	assert.equal(heading.firstChild!.textContent, "Code");
	assert.equal(heading.textContent, "Codebadge current");
	assert.ok(heading.contains(context.headerContainer!));
	assert.notEqual(context.headerContainer, heading, "plugin does not receive the host heading");
	assert.equal(body.contains(context.headerContainer!), false, "suffix is not inside the body slot");
	assert.equal(context.headerContainer!.contains(body), false);
	assert.ok(Object.isFrozen(context)); assert.ok(Object.isFrozen(context.answer)); assert.ok(Object.isFrozen(context.input.payload));
	assert.ok(Object.isFrozen(context.grading));
	assert.notEqual(context.answer, answer.answer); assert.notEqual(context.grading, answer.grading);
	assert.equal(Object.isFrozen(context.signal), false); assert.equal(Object.isFrozen(context.headerContainer), false);
	assert.equal(Object.isFrozen(context.footerContainer), false);
	assert.equal(body.contains(context.footerContainer!), false);
	assert.notEqual(context.footerContainer, body.parentElement?.parentElement, "plugin gets an isolated child, not the host card");
	context.headerContainer!.replaceChildren(h.document.createTextNode("replacement badge"));
	assert.equal(heading.firstChild!.textContent, "Code", "replacing the suffix cannot erase the host label");
	await h.close();
	assert.equal(context.signal.aborted, true); assert.equal(aborted, 1); assert.equal(disposed, 1);
	assert.equal(context.headerContainer!.isConnected, false); assert.equal(body.isConnected, false);
	assert.equal(context.footerContainer!.isConnected, false);
});

test("StrictMode replay gives body and header fresh isolated generations and disposes late replay cleanup once", async () => {
	const h = await harness();
	const pending = deferred<PluginCleanup>();
	const seen: { body: HTMLElement; context: AnsweredContext }[] = [];
	const cleaned: number[] = [];
	const renderer = registration((body, context) => {
		const index = seen.length; seen.push({ body, context }); paint(body, context, String(index));
		if (index === 0) return pending.promise;
		return () => { cleaned.push(index); };
	});
	await h.render(<StrictMode>{card(renderer)}</StrictMode>);
	assert.equal(seen.length, 2);
	assert.equal(seen[0]!.context.signal.aborted, true); assert.equal(seen[1]!.context.signal.aborted, false);
	assert.notEqual(seen[0]!.body, seen[1]!.body);
	assert.notEqual(seen[0]!.context.headerContainer, seen[1]!.context.headerContainer);
	assert.notEqual(seen[0]!.context.footerContainer, seen[1]!.context.footerContainer);
	assert.equal(seen[0]!.context.headerContainer!.isConnected, false);
	assert.equal(seen[0]!.context.footerContainer!.isConnected, false);
	await act(async () => {
		paint(seen[0]!.body, seen[0]!.context, "stale deferred callback");
		pending.resolve(() => { cleaned.push(0); seen[0]!.context.headerContainer!.replaceChildren(); seen[0]!.body.replaceChildren(); });
	});
	assert.equal(hostHeading(h.document).textContent, "Codebadge 1");
	assert.match(h.document.body.textContent!, /body 1/); assert.doesNotMatch(h.document.body.textContent!, /stale/);
	assert.deepEqual(cleaned, [0]);
	await h.close(); assert.deepEqual(cleaned, [0, 1]);
});

for (const asynchronous of [false, true]) test(`${asynchronous ? "async" : "sync"} mount failure removes partial header/body and aborts shared resources without changing host label`, async () => {
	const h = await harness();
	const pending = deferred<void>();
	let body!: HTMLElement, context!: AnsweredContext;
	let activeResources = 0;
	await h.render(card(registration((container, props) => {
		body = container; context = props; paint(container, props, "partial");
		activeResources++;
		props.signal.addEventListener("abort", () => { activeResources--; }, { once: true });
		if (asynchronous) return pending.promise;
		throw new Error("failed after mounting badge");
	})));
	if (asynchronous) await act(async () => { pending.reject(new Error("async failed after mounting badge")); });
	assert.ok(context, "renderer ran before failing");
	assert.equal(context.signal.aborted, true); assert.equal(activeResources, 0);
	assert.equal(body.isConnected, false); assert.equal(context.headerContainer!.isConnected, false);
	assert.equal(context.footerContainer!.isConnected, false);
	assert.equal(hostHeading(h.document).textContent, "Code");
	assert.match(h.document.body.textContent!, /saved code/); assert.doesNotMatch(h.document.body.textContent!, /partial/);
	paint(body, context, "late failed callback");
	assert.equal(hostHeading(h.document).textContent, "Code"); assert.doesNotMatch(h.document.body.textContent!, /late failed/);
	let replacementContext!: AnsweredContext;
	await h.render(card(registration((container, props) => { replacementContext = props; paint(container, props, "recovered"); })));
	assert.notEqual(replacementContext.headerContainer, context.headerContainer);
	assert.notEqual(replacementContext.footerContainer, context.footerContainer);
	assert.equal(replacementContext.signal.aborted, false);
	assert.equal(hostHeading(h.document).textContent, "Codebadge recovered");
	assert.match(h.document.body.textContent!, /body recovered/); assert.doesNotMatch(h.document.body.textContent!, /saved code/);
	await h.close(); assert.equal(activeResources, 0);
});

test("renderer replacement isolates stale callbacks, deferred cleanup and stale rejection from the live header", async () => {
	const h = await harness();
	const oldMount = deferred<PluginCleanup>(), oldCleanup = deferred<void>(), rejectedMount = deferred<void>();
	let oldBody!: HTMLElement, oldContext!: AnsweredContext, rejectedContext!: AnsweredContext, liveContext!: AnsweredContext;
	let cleaned = 0;
	await h.render(card(registration((body, context) => {
		oldBody = body; oldContext = context; paint(body, context, "old"); return oldMount.promise;
	})));
	const heading = hostHeading(h.document), label = heading.firstChild;
	await h.render(card(registration((body, context) => {
		rejectedContext = context; paint(body, context, "rejected"); return rejectedMount.promise;
	})));
	await h.render(card(registration((body, context) => {
		liveContext = context; paint(body, context, "live"); return () => { cleaned++; };
	})));
	assert.equal(oldContext.signal.aborted, true); assert.equal(rejectedContext.signal.aborted, true);
	assert.equal(liveContext.signal.aborted, false); assert.equal(heading.firstChild, label);
	assert.equal(oldContext.headerContainer!.isConnected, false); assert.equal(rejectedContext.headerContainer!.isConnected, false);
	assert.equal(oldContext.footerContainer!.isConnected, false); assert.equal(rejectedContext.footerContainer!.isConnected, false);
	await act(async () => {
		paint(oldBody, oldContext, "stale callback");
		oldMount.resolve(async () => { cleaned++; await oldCleanup.promise; oldBody.replaceChildren(); oldContext.headerContainer!.replaceChildren(); });
		rejectedMount.reject(new Error("stale rejection"));
	});
	assert.equal(cleaned, 1);
	await act(async () => { oldCleanup.resolve(); });
	assert.equal(hostHeading(h.document), heading); assert.equal(heading.firstChild, label);
	assert.equal(heading.textContent, "Codebadge live");
	assert.match(h.document.body.textContent!, /body live/); assert.doesNotMatch(h.document.body.textContent!, /stale|saved code/);
	await h.render(card());
	assert.equal(liveContext.signal.aborted, true); assert.equal(cleaned, 2);
	assert.equal(heading.textContent, "Code"); assert.match(h.document.body.textContent!, /saved code/);
	await h.close(); assert.equal(cleaned, 2);
});

test("deferred completion after unmount cannot reattach its header and still disposes its cleanup", async () => {
	const h = await harness();
	const pending = deferred<PluginCleanup>();
	let body!: HTMLElement, context!: AnsweredContext, disposed = 0;
	await h.render(card(registration((container, props) => { body = container; context = props; paint(container, props, "mounted"); return pending.promise; })));
	await h.render(<div>another surface</div>);
	assert.equal(context.signal.aborted, true); assert.equal(context.headerContainer!.isConnected, false);
	assert.equal(context.footerContainer!.isConnected, false);
	await act(async () => {
		paint(body, context, "late unmounted callback");
		pending.resolve(() => { disposed++; });
	});
	assert.equal(disposed, 1); assert.equal(h.document.body.textContent, "another surface");
});

test("question context has no header capability; direct answered slots may omit it for body fallback", async () => {
	const h = await harness();
	let questionSeen = false, answeredSeen = false;
	const renderer: QuestionRendererRegistration = { pluginId: "fixture", renderer: {
		id: "code", supportedContractVersions: [1], mountAnswerEditor() { throw new Error("not an editor"); },
		mountQuestion(body, context) { questionSeen = true; assert.equal(Object.hasOwn(context, "headerContainer"), false); assert.equal(Object.hasOwn(context, "footerContainer"), false); body.textContent = "question body"; },
		mountAnswered(body, context) { answeredSeen = true; assert.equal(Object.hasOwn(context, "headerContainer"), false); assert.equal(Object.hasOwn(context, "footerContainer"), false); (context.headerContainer ?? body).textContent = "body fallback badge"; },
	} };
	await h.render(<PluginQuestionPresentation snapshot={snapshot} chatId="chat" registration={renderer} />);
	assert.ok(questionSeen); assert.equal(h.document.body.textContent, "question body");
	await h.render(<PluginQuestionPresentation snapshot={snapshot} answer={answer} chatId="chat" registration={renderer} />);
	assert.ok(answeredSeen); assert.equal(h.document.body.textContent, "body fallback badge");
});


test("footer is after host thinking, stays generation-owned on adoption, and cannot overwrite thinking", async () => {
	const h = await harness();
	let context!: AnsweredContext;
	let mounts = 0;
	const renderer = registration((body, props) => { context = props; mounts++; paint(body, props, "solution"); });
	const thinkingAnswer = { ...answer, thinking: "Learner reasoning" };
	await h.render(<PluginQuestionAnswered snapshot={snapshot} answer={thinkingAnswer} chatId="chat" registration={renderer} />);
	const card = h.document.querySelector('[data-testid="plugin-question-answered"]')!;
	const thinking = card.querySelector('[data-testid="your-thinking"]')!;
	assert.equal(thinking.nextElementSibling, context.footerContainer!.parentElement);
	assert.equal(card.lastElementChild, context.footerContainer!.parentElement);
	assert.equal(context.footerContainer!.contains(thinking), false);
	const original = context.footerContainer;
	await h.render(<PluginQuestionAnswered snapshot={{ ...snapshot }} answer={{ ...thinkingAnswer }} chatId="chat" registration={renderer} />);
	assert.equal(mounts, 1, "canonical adoption does not remount any slot");
	assert.equal(context.footerContainer, original);
	context.footerContainer!.replaceChildren(h.document.createTextNode("replacement model solution"));
	assert.equal(thinking.querySelector("button")!.textContent, "YOUR THINKING");
	assert.match(card.textContent!, /replacement model solution/);
	await h.close();
	assert.equal(original!.isConnected, false);
});
