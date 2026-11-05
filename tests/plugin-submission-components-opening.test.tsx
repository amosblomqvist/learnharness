import React, { act, useEffect, useRef, useState } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { usePageSurfaceBoundary, SurfaceRegion } from "../components/plugin-surfaces.tsx";
import { findSurfaceBoundary } from "../components/plugin-surface-targets.ts";
import { scheduleOpeningSubmission } from "../components/plugin-submission-opening.ts";
import { PluginSubmissionRunner } from "../components/plugin-submission-runner.ts";
import { SessionModel } from "../components/session-core.ts";
import type { PluginSubmission, PluginSubmissionTarget } from "../src/core/index.ts";
import { installModalDom } from "./modal-dom.ts";

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
async function fixture(run: (f: { state: { active: boolean; key: string; hooks: number; posts: number; finalizes: number; draft: string }; render(): Promise<void>; runner(): PluginSubmissionRunner; entered: Promise<void>; finish(): void }) => Promise<void>, waitInHook = false) {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	const globals = { React, window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, SVGElement: dom.window.SVGElement, ShadowRoot: dom.window.ShadowRoot, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])); Object.assign(globalThis, globals);
	const restoreModalDom = installModalDom(dom), root = createRoot(document.querySelector("#root")!);
	const state = { active: true, key: "chat", hooks: 0, posts: 0, finalizes: 0, draft: "opening prompt" };
	const entered = deferred<void>(), finish = deferred<void>(); let activeRunner!: PluginSubmissionRunner;
	function Boundary() {
		const body = useRef<HTMLDivElement>(null), claimed = useRef(false);
		const target = usePageSurfaceBoundary({ active: state.active, viewKey: state.key, bodyRef: body });
		const live = useRef(target); live.current = target;
		const [runner] = useState(() => new PluginSubmissionRunner()); activeRunner = runner;
		useEffect(() => () => runner.dispose(), [target, runner]);
		useEffect(() => {
			if (!target || claimed.current) return;
			return scheduleOpeningSubmission(() => !claimed.current && live.current === target && !!findSurfaceBoundary(target), () => {
				claimed.current = true;
				const submissionTarget: PluginSubmissionTarget = { type: "text", channels: ["content"], sessionId: state.key, sessionKind: "teaching", surfaceTarget: target };
				const attempt = runner.begin(submissionTarget, [{ pluginId: "fixture", pluginName: "Fixture", signal: new AbortController().signal, isCurrent: () => true, report() {}, interceptor: { id: "opening", async intercept() { state.hooks++; entered.resolve(); if (waitInHook) await finish.promise; } } }], () => live.current === target && !!findSurfaceBoundary(target))!;
				void (async () => {
					try {
						const input = await attempt.finalize(async () => { state.finalizes++; return { type: "text", content: { text: state.draft, images: [] } } as PluginSubmission; });
						const prepared = await attempt.prepare(input, []); if (!prepared || prepared.type !== "text") return;
						attempt.deliver();
						const model = new SessionModel({ chatId: state.key, initialMessages: [], fetch: async url => { if (String(url) === "/api/chat") { state.posts++; return Response.json({ accepted: true }); } if (String(url).endsWith("/stream")) return new Response("data: [DONE]\n\n"); return Response.json({ messages: [] }); } });
						await model.send({ type: "text", text: prepared.content.text }, () => { state.draft = ""; attempt.accepted(); }, undefined, attempt.refused);
					} catch { attempt.cancel(); /* Captured input stays in the native draft. */ }
				})();
			});
		}, [target, runner]);
		return <div ref={body}><div>Native body</div><SurfaceRegion target={target} /></div>;
	}
	const render = async () => { await act(async () => { root.render(<React.StrictMode><InteractionLayersProvider><Boundary /></InteractionLayersProvider></React.StrictMode>); }); };
	try { await render(); await run({ state, render, runner: () => activeRunner, entered: entered.promise, finish: () => finish.resolve() }); }
	finally { await act(async () => { root.unmount(); }); restoreModalDom(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
}

test("StrictMode opening setup claims only the live committed effect: exactly one finalization/hook/POST", async () => {
	await fixture(async f => { assert.equal(f.state.finalizes, 1); assert.equal(f.state.hooks, 1); assert.equal(f.state.posts, 1); assert.equal(f.state.draft, ""); await f.render(); assert.equal(f.state.posts, 1); });
});
test("real native navigation expiry after hooks begin refuses without POST or retargeting/re-hooking", async () => {
	await fixture(async f => {
		await f.entered; assert.equal(f.state.hooks, 1);
		f.state.active = false; await f.render(); f.finish(); await f.render();
		f.state.active = true; f.state.key = "replacement"; await f.render();
		assert.equal(f.state.posts, 0); assert.equal(f.state.hooks, 1); assert.equal(f.state.draft, "opening prompt"); assert.equal(f.runner().occupied, false);
	}, true);
});
test("manual preparation cancellation retains opening draft and never automatically starts another hook", async () => {
	await fixture(async f => {
		await f.entered; await act(async () => { f.runner().cancel(); }); f.finish(); await f.render();
		assert.equal(f.state.posts, 0); assert.equal(f.state.hooks, 1); assert.equal(f.state.draft, "opening prompt"); assert.equal(f.runner().occupied, false);
	}, true);
});
