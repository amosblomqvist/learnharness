import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ModelSpeedControl, FAST_MODE_TOOLTIP, offersFastMode, tierForModel, speedLabel } from "../components/model-speed-control.tsx";
import { AgentSection, composeSlotModel } from "../components/settings/agent-section.tsx";
import { prefillTierFromPin, tierAfterPick } from "../components/setup-dialog.tsx";
import { ModelControl } from "../components/model-picker.tsx";
import type { ModelCatalogEntry } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, localStorage: { getItem: () => null, setItem() {} } });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => {
	if (root) await act(async () => root!.unmount());
	host?.remove(); root = undefined; host = undefined;
	globalThis.fetch = originalFetch;
});

const CODEX = { provider: "chatgpt", id: "gpt-6-sol" };
const entry = (over: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
	provider: CODEX.provider, id: CODEX.id, supportedLevels: ["low", "high"], input: ["text"], contextWindow: 1000, cost: null, supportsFastMode: true, ...over,
} as ModelCatalogEntry);
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("speed control render", () => {
	it("shows Standard/Fast, selected state, and the factual tooltip text", () => {
		const html = renderToStaticMarkup(<ModelSpeedControl value="priority" onChange={() => {}} />);
		const doc = parseHTML(`<body>${html}</body>`).document;
		assert.equal(doc.querySelector('[data-testid="model-speed-fast"]')!.getAttribute("aria-pressed"), "true");
		assert.equal(doc.querySelector('[data-testid="model-speed-standard"]')!.getAttribute("aria-pressed"), "false");
		assert.match(html, /2\.5x/);
		assert.match(html, /2x purchased credits/);
		assert.match(FAST_MODE_TOOLTIP, /depends on the model and your account/);
		assert.doesNotMatch(FAST_MODE_TOOLTIP, /guarantee|always faster/i);
	});
	it("absent tier reads Standard; helpers are pure", () => {
		assert.equal(speedLabel(undefined), "Standard");
		assert.equal(speedLabel("priority"), "Fast");
		assert.equal(offersFastMode(entry()), true);
		assert.equal(offersFastMode(entry({ supportsFastMode: undefined })), false);
		assert.equal(tierForModel(entry(), "priority"), "priority");
		assert.equal(tierForModel(entry({ supportsFastMode: false }), "priority"), undefined);
	});
	it("interaction: click fires onChange once; disabled blocks it", async () => {
		const seen: string[] = [];
		host = document.createElement("div"); document.body.append(host); root = createRoot(host);
		await act(async () => root!.render(<ModelSpeedControl value="default" onChange={(t) => seen.push(t)} />));
		await act(async () => byTest("model-speed-standard")!.click()); // already selected
		await act(async () => byTest("model-speed-fast")!.click());
		assert.deepEqual(seen, ["priority"]);
		await act(async () => root!.render(<ModelSpeedControl value="default" disabled onChange={(t) => seen.push(t)} />));
		assert.equal(byTest("model-speed-fast")!.hasAttribute("disabled"), true);
	});
});

describe("composeSlotModel speed", () => {
	it("old callers keep working and keep the tier on eligible models", () => {
		const prev = { strong: { model: CODEX, thinkingLevel: "low" as const, serviceTier: "priority" as const } };
		const after = composeSlotModel(prev, "strong", CODEX.provider, CODEX.id, "high");
		assert.deepEqual(after.strong, { model: CODEX, thinkingLevel: "high", serviceTier: "priority" });
	});
	it("explicit default is stored, not erased", () => {
		const after = composeSlotModel({ strong: { model: CODEX, serviceTier: "priority" } }, "strong", CODEX.provider, CODEX.id, "low", "default");
		assert.equal(after.strong!.serviceTier, "default");
	});
	it("null clears; unsupported model clears; thinking-only edit keeps it", () => {
		const prev = { strong: { model: CODEX, serviceTier: "priority" as const }, cheap: { model: { provider: "x", id: "y" } } };
		assert.equal(composeSlotModel(prev, "strong", CODEX.provider, CODEX.id, "low", null).strong!.serviceTier, undefined);
		assert.equal(composeSlotModel(prev, "strong", "openrouter", "z", "low").strong!.serviceTier, undefined);
		assert.equal(composeSlotModel(prev, "strong", "", "", "high").strong!.serviceTier, "priority");
	});
	it("never gives a tier to an unsupported model and keeps siblings", () => {
		const prev = { cheap: { model: { provider: "x", id: "y" } }, vision: { model: CODEX, serviceTier: "default" as const } };
		const after = composeSlotModel(prev, "cheap", "x", "y", "low", "priority");
		assert.equal(after.cheap!.serviceTier, undefined);
		assert.deepEqual(after.vision, prev.vision);
	});
});

describe("setup dialog speed helpers", () => {
	it("prefill: absent tier = Standard on eligible, none on ineligible", () => {
		assert.equal(prefillTierFromPin(entry(), {}), "default");
		assert.equal(prefillTierFromPin(entry(), { serviceTier: "priority" }), "priority");
		assert.equal(prefillTierFromPin(entry({ supportsFastMode: false }), { serviceTier: "priority" }), undefined);
	});
	it("pick: keeps Fast across eligible models, clears on unsupported", () => {
		assert.equal(tierAfterPick(entry(), "priority"), "priority");
		assert.equal(tierAfterPick(entry(), undefined), "default");
		assert.equal(tierAfterPick(entry({ supportsFastMode: false }), "priority"), undefined);
	});
});

describe("ModelControl chat mode", () => {
	function stubFetch(session: Record<string, unknown>, models: Record<string, unknown>, catalog: ModelCatalogEntry[], putStatus = 200) {
		const puts: unknown[] = [];
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
			if (init?.method === "PUT") { puts.push(JSON.parse(String(init.body))); return putStatus === 200 ? json({ settings: puts.at(-1) }) : json({ error: "nope" }, putStatus); }
			if (url === "/api/models") return json({ models: catalog, providers: [], slots: {} });
			if (url.startsWith("/api/chats/")) return json({ settings: session });
			return json({ settings: { models } });
		}) as typeof fetch;
		return puts;
	}
	async function mount() {
		host = document.createElement("div"); document.body.append(host); root = createRoot(host);
		await act(async () => root!.render(<ModelControl chatId="c1" />));
		await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
	}
	it("pinned session without tier shows Standard despite a Fast new-session default", async () => {
		stubFetch({ model: CODEX }, { strong: { model: CODEX, serviceTier: "priority" } }, [entry()]);
		await mount();
		assert.equal(byTest("stats-speed-standard")!.getAttribute("aria-pressed"), "true");
	});
	it("unpinned legacy session inherits the strong tier; hidden for unsupported models", async () => {
		stubFetch({}, { strong: { model: CODEX, serviceTier: "priority" } }, [entry()]);
		await mount();
		assert.equal(byTest("stats-speed-fast")!.getAttribute("aria-pressed"), "true");
		await act(async () => root!.unmount()); host!.remove();
		stubFetch({ model: CODEX }, {}, [entry({ supportsFastMode: false })]);
		await mount();
		assert.equal(byTest("stats-speed"), null);
	});
	it("Fast write replaces the whole object, keeping other fields; failure shows error and no success", async () => {
		const puts = stubFetch({ model: CODEX, thinkingLevel: "low", extra: 1 }, {}, [entry()]);
		await mount();
		await act(async () => byTest("stats-speed-fast")!.click());
		await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
		assert.deepEqual(puts[0], { model: CODEX, thinkingLevel: "low", extra: 1, serviceTier: "priority" });
		assert.equal(byTest("stats-speed-fast")!.getAttribute("aria-pressed"), "true");
		await act(async () => root!.unmount()); host!.remove();
		stubFetch({ model: CODEX, thinkingLevel: "low" }, {}, [entry()], 500);
		await mount();
		await act(async () => byTest("stats-speed-fast")!.click());
		await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
		assert.equal(byTest("stats-speed-standard")!.getAttribute("aria-pressed"), "true");
		assert.match(byTest("model-control-error")!.textContent ?? "", /nope/);
	});
	it("pending save disables model, thinking and speed, then re-enables", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
			if (init?.method === "PUT") { await gate; return json({ settings: JSON.parse(String(init.body)) }); }
			if (url === "/api/models") return json({ models: [entry()], providers: [], slots: {} });
			if (url.startsWith("/api/chats/")) return json({ settings: { model: CODEX, thinkingLevel: "low" } });
			return json({ settings: { models: {} } });
		}) as typeof fetch;
		host = document.createElement("div"); document.body.append(host); root = createRoot(host);
		await act(async () => root!.render(<ModelControl chatId="c1" />));
		await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
		await act(async () => byTest("stats-speed-fast")!.click());
		for (const id of ["stats-model", "stats-thinking", "stats-speed-fast", "stats-speed-standard"]) {
			assert.equal(byTest(id)!.hasAttribute("disabled"), true, id + " disabled while pending");
		}
		await act(async () => { window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-open-model-picker")); });
		assert.equal(byTest("model-menu"), null, "no menu opens while pending");
		await act(async () => { release(); await new Promise((r) => setTimeout(r, 10)); });
		for (const id of ["stats-model", "stats-thinking", "stats-speed-fast", "stats-speed-standard"]) {
			assert.equal(byTest(id)!.hasAttribute("disabled"), false, id + " re-enabled");
		}
	});
});

describe("AgentSection speed write", () => {
	it("disables every slot's model and thinking triggers while a Fast write is pending", async () => {
		globalThis.fetch = (async (url: string) => {
			const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
			if (url === "/api/models") return json({ models: [entry()], slots: { strong: null, cheap: null, vision: null } });
			if (url.includes("prompts")) return json({ prober: [], teacher: [] });
			return json({});
		}) as typeof fetch;
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const writes: unknown[] = [];
		host = document.createElement("div"); document.body.append(host); root = createRoot(host);
		await act(async () => root!.render(
			<AgentSection agent={undefined} graph={undefined} compaction={undefined}
				models={{ strong: { model: CODEX, thinkingLevel: "low" }, cheap: { model: CODEX, thinkingLevel: "low" } }}
				onSectionChange={() => {}} onCompactionChange={() => {}}
				onModelsChange={(next) => { writes.push(next); return gate; }} />,
		));
		await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
		await act(async () => byTest("slot-speed-strong-fast")!.click());
		assert.equal(writes.length, 1);
		for (const slot of ["strong", "cheap", "vision"]) {
			assert.equal(byTest(`slot-model-${slot}`)!.hasAttribute("disabled"), true, slot + " model");
			assert.equal(byTest(`slot-thinking-${slot}`)!.hasAttribute("disabled"), true, slot + " thinking");
		}
		assert.equal(byTest("slot-speed-cheap-fast")!.hasAttribute("disabled"), true);
		await act(async () => { release(); await new Promise((r) => setTimeout(r, 10)); });
		assert.equal(byTest("slot-model-strong")!.hasAttribute("disabled"), false);
		assert.equal(byTest("slot-thinking-cheap")!.hasAttribute("disabled"), false);
	});
});
