import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useModelCatalog, catalogLimits } from "../components/model-picker.tsx";
import { useZeroKeys, useStrongKeyless } from "../components/setup-cta.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { SidebarProvider } from "../components/sidebar.tsx";
import { ChatGPTConnection, ChatGPTUIProvider } from "../components/settings/chatgpt-connection.tsx";
import { GraphCostControl } from "../components/graph-view.tsx";
import { graphCostSummary as foldGraphCostSummary, type CostSummaryInput } from "../src/core/cost-summary.ts";
const graphCostSummary = (input: CostSummaryInput) => foldGraphCostSummary(input, () => null);
import type { ModelCatalogResponse, ChatGPTStatus } from "../src/core/index.ts";
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, localStorage: { getItem: () => null, setItem() {} } });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function body(id: string, ready = true): ModelCatalogResponse {
 return { models: ready ? [{ id, name: id, provider: "chatgpt", input: ["text"], contextWindow: 8192, maxTokens: 1024, reasoning: false, supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] : [], providers: [{ id: "chatgpt", envVar: "", keyPresent: ready }], slots: { strong: { model: { provider: "chatgpt", id: "explicit-pin" } }, cheap: null, vision: null }, defaults: {} } as ModelCatalogResponse;
}
let snapshots: Record<string, { catalog?: ModelCatalogResponse; zero: boolean; strong: boolean }> = {};
function Reader({ id }: { id: string }) {
 const { catalog } = useModelCatalog();
 snapshots[id] = { catalog, zero: useZeroKeys(), strong: useStrongKeyless() };
 return <span data-testid={id}>{catalog ? [...catalogLimits(catalog).keys()].join(",") : "unavailable"}</span>;
}
async function mount(children: React.ReactNode) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root!.render(children)); }
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; globalThis.fetch = originalFetch; delete window.lh; snapshots = {}; });

test("shared ChatGPT-only readiness admits without API keys; connection invalidation clears every reader and fences old success/error", async () => {
 const requests: ReturnType<typeof deferred<Response>>[] = [];
 globalThis.fetch = async (input) => { assert.equal(input, "/api/models"); const request = deferred<Response>(); requests.push(request); return request.promise; };
 await mount(<><Reader id="first" /><Reader id="second" /></>);
 assert.equal(requests.length, 1);
 await act(async () => requests[0]!.resolve(Response.json(body("A"))));
 for (const value of Object.values(snapshots)) { assert.equal(value.zero, false); assert.equal(value.strong, false); assert.equal(value.catalog?.models[0]?.id, "A"); }
 await act(async () => notifySettingsSaved("models"));
 assert.equal(requests.length, 2);
 await act(async () => notifySettingsSaved("keys"));
 assert.equal(requests.length, 3);
 for (const value of Object.values(snapshots)) assert.equal(value.catalog, undefined);
 await act(async () => requests[2]!.resolve(Response.json(body("B", false))));
 await act(async () => requests[1]!.resolve(Response.json(body("stale-A"))));
 for (const value of Object.values(snapshots)) { assert.equal(value.catalog?.models.length, 0); assert.equal(value.zero, true); assert.equal(value.strong, true); }
 assert(!document.body.textContent?.includes("chatgpt:A"));
});

test("plan plus unknown graph rows keep the existing unknown suffix without fabricating API dollars", async () => {
 const step = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
 const plan = { model: "chatgpt:gpt-5", steps: [step] };
 const unknown = { model: "unknown:missing", steps: [step] };
 const costs = graphCostSummary({ chats: [{ title: "Scratch", extractions: [{ startedAt: 1, at: "2026-10-24T00:00:00Z", durationMs: 1, stages: { extractor: plan, auditor: unknown } }, { startedAt: 2, at: "2026-10-24T00:00:00Z", durationMs: 1, stages: { extractor: unknown, auditor: plan } }] }], sources: [] });
 await mount(<GraphCostControl costs={costs} />);
 await act(async () => { document.querySelector("button")!.click(); });
 const recent = [...document.querySelectorAll(".border-t .shrink-0.tabular-nums")];
 assert.equal(recent.length, 2);
 for (const row of recent) assert.equal(row.textContent, "ChatGPT +1 unpriced", "both recent two-stage runs disclose their unknown stage");
 assert.equal((document.body.textContent?.match(/\+1 unpriced/g) ?? []).length, 4, "both mixed stage rows also retain their unknown suffix");
 assert(!document.body.textContent?.includes("$0.00"));
});

test("root-lifetime safe bridge publishes with Connections unmounted; commands/panel pushes do not duplicate global signals", async () => {
 let pushes: (() => void)[] = [], subscriptions = 0, unsubscriptions = 0, fetches = 0;
 const safe: ChatGPTStatus = { available: true, pending: false, allowBackgroundUse: false, activeId: "a", accounts: [{ id: "a", email: "dummy@example.invalid", registration: "oaiapp_dummy", connected: true, planEnabled: true }], error: null };
 window.lh = { expandWindow() {}, chatgpt: { status: async () => safe, login: async () => safe, cancel: async () => safe, select: async () => safe, disconnect: async () => safe, logout: async () => safe, consent: async () => safe, onChange: (cb) => { subscriptions++; pushes.push(cb); return () => { unsubscriptions++; pushes = pushes.filter((c) => c !== cb); }; } } };
 globalThis.fetch = async (input) => { assert.equal(input, "/api/models"); fetches++; return Response.json(body(`model-${fetches}`)); };
 await mount(<SidebarProvider><Reader id="root" /></SidebarProvider>);
 assert.equal(subscriptions, 1);
 const before = fetches;
 await act(async () => { for (const callback of pushes) callback(); });
 assert.equal(fetches, before + 1);
 await act(async () => root!.render(<SidebarProvider><Reader id="root" /><ChatGPTUIProvider><ChatGPTConnection /></ChatGPTUIProvider></SidebarProvider>));
 assert.equal(subscriptions, 2);
 const mounted = fetches;
 await act(async () => { for (const callback of pushes) callback(); });
 assert.equal(fetches, mounted + 1, "one global publisher even when panel also reads pushed status");
 await act(async () => root!.render(<SidebarProvider><Reader id="root" /></SidebarProvider>));
 assert.equal(unsubscriptions, 1);
 await act(async () => { for (const callback of pushes) callback(); });
 assert.equal(fetches, mounted + 2);
});
