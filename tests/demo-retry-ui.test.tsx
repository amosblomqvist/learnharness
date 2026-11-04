import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DispatchCard } from "../components/artifacts/dispatch-card.tsx";
import { JobsContext } from "../components/jobs-context.ts";
import { ChatActionsContext } from "../components/chat.tsx";
import { latestJobAttempt } from "../components/job-attempt.ts";
import type { JobRecord } from "../src/core/contracts.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLElement | undefined;
const failed: JobRecord = { id: "original", kind: "demo", chatId: "c1", toolCallId: "t1", status: "error", error: "FAILED: terminated", activity: "", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" };
const running: JobRecord = { ...failed, id: "retry", retryOf: failed.id, status: "running", error: undefined, activity: "Building demo", createdAt: "2026-10-02T00:00:00Z" };
async function render(jobs: JobRecord[] = [failed]) {
	if (!root) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
	await act(async () => root!.render(<JobsContext.Provider value={jobs}><ChatActionsContext.Provider value={{ chatId: "c1", syncFromServer: async () => {}, sendText: () => {}, openSetup: () => {} }}><DispatchCard toolCallId="t1" kind="demo" /></ChatActionsContext.Provider></JobsContext.Provider>));
}
function button() { const value = host!.querySelector<HTMLButtonElement>('[data-testid="dispatch-retry"]'); assert.ok(value); return value; }
function click() { button().dispatchEvent(new dom.window.Event("click", { bubbles: true })); }
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; globalThis.fetch = originalFetch; });

test("Retry sends the original job once and displays the new build before the feed updates", async () => {
	let resolve!: (response: Response) => void;
	let requests = 0;
	globalThis.fetch = async (url, init) => {
		requests++;
		assert.equal(url, "/api/jobs"); assert.equal(init?.method, "POST");
		assert.deepEqual(JSON.parse(String(init?.body)), { chatId: "c1", jobId: "original" });
		return new Promise<Response>((done) => { resolve = done; });
	};
	await render();
	await act(async () => { click(); click(); });
	assert.equal(requests, 1); assert.equal(button().disabled, true); assert.equal(button().textContent, "Retrying…");
	await act(async () => resolve(Response.json({ job: running })));
	assert.match(host!.textContent!, /Building demo/); assert.equal(host!.querySelector('[data-testid="dispatch-retry"]'), null);
	await render([{ ...failed, updatedAt: "2026-11-01T00:00:00Z" }, running]);
	assert.match(host!.textContent!, /Building demo/);
	await render([failed, { ...running, status: "done" }]);
	assert.match(host!.textContent!, /finished/);
});

test("A failed retry request shows an error and permits another click", async () => {
	let requests = 0;
	globalThis.fetch = async () => { requests++; return Response.json({ error: "Retry is unavailable. Try again." }, { status: 503 }); };
	await render(); await act(async () => click());
	assert.match(host!.querySelector('[role="alert"]')!.textContent!, /Retry is unavailable/);
	assert.equal(button().disabled, false);
	globalThis.fetch = async () => { requests++; return Response.json({ job: running }); };
	await act(async () => click()); assert.equal(requests, 2);
	assert.match(host!.textContent!, /Building demo/);
});

test("The retry remains visible with the model setup action", async () => {
	await render([{ ...failed, error: "No model configured — set up your models first (missing: cheap)" }]);
	assert.ok(host!.querySelector('[data-testid="dispatch-setup-link"]')); assert.ok(button());
});

test("Attempt lineage wins over activity order and equal creation timestamps", () => {
	const retry = { ...running, createdAt: failed.createdAt };
	const newest = { ...retry, id: "retry2", retryOf: retry.id, status: "error" as const };
	assert.equal(latestJobAttempt([failed, newest, retry], "t1")!.id, newest.id);
	assert.equal(latestJobAttempt([failed], "unknown"), null);
});
