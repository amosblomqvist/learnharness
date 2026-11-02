import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { SetupDialog } from "../components/setup-dialog.tsx";
import { AgentSection } from "../components/settings/agent-section.tsx";
import { providerKeyLabel, classifyKeys } from "../components/settings/keys-section.tsx";
import { useModelCatalog } from "../components/model-catalog.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { useModelSetup, savedSlotsConfigured, selectedModelUnavailable, openModelPicker } from "../components/setup-cta.tsx";
import { StatsBar } from "../components/stats-bar.tsx";
import type { ModelCatalogEntry, ModelCatalogResponse, ModelsSettings } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let requests: ReturnType<typeof deferred<Response>>[] = [];
let writes: ModelsSettings[] = [];
let snapshot: ReturnType<typeof useModelCatalog>;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
const provider = { id: "fixture", envVar: "FIXTURE_KEY", label: "Fixture" };
const a: ModelCatalogEntry = { id: "vendor/model:free", name: "Model free", provider: provider.id, input: ["text", "image"], reasoning: true, supportedLevels: ["off", "low", "high"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
const b: ModelCatalogEntry = { ...a, id: "claude-opus-5-5", name: "Claude Opus 5.5", supportedLevels: ["off", "medium"] };
function catalog(connected = true): ModelCatalogResponse {
	return {
		models: connected ? [a, b] : [], defaults: null,
		rolePins: { researcher: null, demoBuilder: null, visualMaker: null, extractor: null, auditor: null },
		slots: { strong: { model: { provider: a.provider, id: a.id }, thinkingLevel: "low" }, cheap: { model: { provider: a.provider, id: a.id }, thinkingLevel: "high" }, vision: { model: { provider: a.provider, id: a.id }, thinkingLevel: "low" } },
		providers: [{ ...provider, keyPresent: connected }],
	};
}
function Reader() { snapshot = useModelCatalog(); return null; }
function setup(onClose = () => {}, onDone = (_models: ModelsSettings) => {}) { return <SetupDialog open onClose={onClose} onDone={onDone} />; }
function installFetch() {
	requests = []; writes = [];
	globalThis.fetch = async (input, init) => {
		const path = String(input);
		if (path === "/api/models") { const request = deferred<Response>(); requests.push(request); return request.promise; }
		if (path === "/api/settings/models") { writes.push(JSON.parse(String(init?.body))); return Response.json({ settings: { models: writes.at(-1) } }); }
		if (path === "/api/keys") return Response.json({ providers: [provider], keys: [] });
		if (path === "/api/settings/prompts") return Response.json({ prober: [], teacher: [] });
		if (path === "/api/search") return Response.json({ available: false, engine: null, reason: "fixture" });
		throw new Error(`Unexpected request ${path}`);
	};
}
async function render(children: React.ReactNode) {
	if (!root) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
	await act(async () => root!.render(children));
}
async function answer(index: number, body: ModelCatalogResponse | null) { await act(async () => requests[index]!.resolve(body ? Response.json(body) : new Response("unavailable", { status: 503 }))); }
function element(testid: string) { const e = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`); assert.ok(e, testid); return e; }
async function click(testid: string) { await act(async () => element(testid).click()); }
function levels() { return [...document.querySelectorAll('[data-testid^="thinking-option-"]')].map((e) => e.textContent); }
async function warm(body = catalog()) { await render(<Reader />); await answer(0, body); }

afterEach(async () => {
	await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined;
	globalThis.fetch = originalFetch;
});

test("cold setup is loading, not keyless; failure/Retry does not invent a key stage", async () => {
	installFetch(); await render(setup());
	assert.ok(element("setup-stage-loading"));
	assert.equal(document.querySelector('[data-testid="setup-stage-keys"]'), null);
	await answer(0, null);
	assert.ok(element("setup-catalog-error"));
	assert.equal(document.querySelector('[data-testid="setup-stage-keys"]'), null);
	await click("setup-retry"); assert.ok(element("setup-stage-loading"));
	const empty = catalog(false); empty.slots = { strong: null, cheap: null, vision: null };
	await answer(1, empty); assert.ok(element("setup-stage-keys"));
});

test("cached setup is immediately usable; fresh metadata/untouched slots update without wiping model or thinking edits; failed refresh still allows exact-ID Save", async () => {
	installFetch(); await warm();
	await render(<><Reader />{setup()}</>);
	assert.equal(requests.length, 2);
	assert.ok(element("setup-stage-pickers"));
	assert.equal(document.querySelector('[data-testid="setup-stage-keys"]'), null);
	assert.equal(element("setup-trigger-strong").textContent, "model:free▾");
	await click("setup-trigger-strong"); await click("model-option-claude-opus-5-5");
	await click("setup-thinking-strong"); await click("thinking-option-medium");
	const fresh = catalog(); fresh.slots.cheap = { model: { provider: b.provider, id: b.id }, thinkingLevel: "off" };
	fresh.models[1] = { ...b, supportedLevels: ["off", "medium", "high"] };
	await answer(1, fresh);
	assert.equal(element("setup-trigger-strong").textContent, "claude-opus-5-5▾");
	assert.equal(element("setup-thinking-strong").textContent?.trim(), "medium▾");
	assert.equal(element("setup-trigger-cheap").textContent, "claude-opus-5-5▾");
	await click("setup-thinking-strong"); assert.deepEqual(levels(), ["off", "medium✓", "high"]);
	await click("setup-thinking-strong");
	await act(async () => snapshot.refresh()); await answer(2, null);
	assert.ok(element("setup-catalog-error")); assert.equal(element("setup-save").hasAttribute("disabled"), false);
	await click("setup-save");
	assert.deepEqual(writes[0], {
		strong: { model: { provider: b.provider, id: b.id }, thinkingLevel: "medium" },
		cheap: { model: { provider: b.provider, id: b.id }, thinkingLevel: "off" },
		vision: { model: { provider: a.provider, id: a.id }, thinkingLevel: "low" },
	});
});

test("zero providers always means exclusive connection stage; reconnect with all saved slots only closes, even if every selection remains unavailable", async () => {
	installFetch(); await warm();
	let closed = 0, completed = 0;
	await render(<><Reader />{setup(() => { closed++; }, () => { completed++; })}</>); await answer(1, catalog());
	await click("setup-trigger-strong");
	await act(async () => notifySettingsSaved("keys"));
	assert.ok(element("setup-stage-loading"));
	assert.equal(document.querySelector('[data-testid="model-option-claude-opus-5-5"]'), null);
	await answer(2, catalog(false));
	assert.ok(element("setup-stage-keys"));
	assert.equal(document.querySelector('[data-testid="setup-stage-pickers"]'), null);
	assert.equal(document.querySelector('[data-testid="setup-add-provider"]'), null);
	assert.equal(document.querySelector('[data-testid="setup-save"]'), null);
	await act(async () => notifySettingsSaved("keys"));
	const other = catalog(false); other.providers = [{ id: "other", envVar: "OTHER_KEY", keyPresent: true }];
	await answer(3, other);
	assert.equal(closed, 1); assert.equal(completed, 0); assert.deepEqual(writes, []);
	assert.equal(document.querySelector('[data-testid="setup-dialog"]'), null, "no intermediate picker frame after reconnect");
});

test("cold saved disconnected pins still enter the provider stage, without any model-selector frame", async () => {
	installFetch(); await warm();
	await act(async () => notifySettingsSaved("keys"));
	const stages: Array<string | undefined> = [];
	function Probe() {
		const { catalog } = useModelCatalog();
		React.useLayoutEffect(() => { stages.push(document.querySelector<HTMLElement>('[data-testid^="setup-stage-"]')?.dataset.testid); }, [catalog]);
		return null;
	}
	await render(<><Reader />{setup()}<Probe /></>);
	await answer(1, catalog(false));
	assert.deepEqual(stages, ["setup-stage-loading", "setup-stage-keys"]);
});

for (const count of [0, 1, 2]) test(`connecting with ${count} saved slots only requires the missing slots; stale identities/thinking survive`, async () => {
	installFetch(); const before = catalog(false);
	if (count < 1) before.slots.strong = null;
	if (count < 2) before.slots.cheap = null;
	before.slots.vision = null;
	if (before.slots.strong) before.slots.strong.thinkingLevel = "xhigh";
	await warm(before);
	let closed = 0; await render(<><Reader />{setup(() => { closed++; })}</>); await answer(1, before);
	assert.ok(element("setup-stage-keys"));
	const connected = { ...before, models: [{ ...b, provider: "other" }], providers: [{ id: "other", envVar: "OTHER_KEY", keyPresent: true }] };
	await act(async () => notifySettingsSaved("keys")); await answer(2, connected);
	assert.ok(element("setup-stage-pickers")); assert.equal(document.querySelector('[data-testid="setup-stage-keys"]'), null); assert.equal(closed, 0);
	for (const slot of ["strong", "cheap", "vision"] as const) {
		if (before.slots[slot]) continue;
		await click(`setup-trigger-${slot}`); await click("model-option-claude-opus-5-5");
	}
	if (count > 0) assert.equal(element("setup-thinking-strong").textContent?.trim(), "xhigh▾");
	await click("setup-save");
	for (const slot of ["strong", "cheap", "vision"] as const) {
		if (before.slots[slot]) assert.deepEqual(writes[0]?.[slot], before.slots[slot]);
		else assert.equal(writes[0]?.[slot]?.model?.provider, "other");
	}
});

test("a partial setup's model/thinking edits survive exclusive provider recovery, but reopening discards the abandoned draft", async () => {
	installFetch(); const before = catalog(); before.slots.cheap = null; before.slots.vision = null;
	await warm(before); await render(<><Reader />{setup()}</>); await answer(1, before);
	await click("setup-trigger-strong"); await click("model-option-claude-opus-5-5");
	await click("setup-thinking-strong"); await click("thinking-option-medium");
	await act(async () => notifySettingsSaved("keys")); await answer(2, { ...before, models: [], providers: [] });
	assert.ok(element("setup-stage-keys")); assert.equal(document.querySelector('[data-testid="setup-stage-pickers"]'), null);
	await act(async () => notifySettingsSaved("keys")); await answer(3, before);
	assert.equal(element("setup-trigger-strong").textContent, "claude-opus-5-5▾");
	assert.equal(element("setup-thinking-strong").textContent?.trim(), "medium▾");
	await render(<Reader />); await render(<><Reader />{setup()}</>);
	assert.equal(element("setup-trigger-strong").textContent, "model:free▾");
	assert.equal(element("setup-thinking-strong").textContent?.trim(), "low▾"); await answer(4, before);
});

test("Agent opens with cached thinking metadata; refresh and disconnect never clear saved levels", async () => {
	installFetch(); await warm();
	const models: ModelsSettings = { strong: { model: { provider: a.provider, id: a.id }, thinkingLevel: "low" } };
	let changed: ModelsSettings | undefined;
	await render(<><Reader /><AgentSection agent={undefined} models={models} graph={undefined} compaction={undefined} onSectionChange={() => {}} onModelsChange={(next) => { changed = next; }} onCompactionChange={() => {}} /></>);
	await click("slot-thinking-strong"); assert.deepEqual(levels(), ["off", "low✓", "high"]);
	assert.equal(element("slot-model-strong").textContent, "model:free▾");
	await answer(1, catalog());
	await act(async () => notifySettingsSaved("keys")); await answer(2, catalog(false));
	assert.equal(element("slot-thinking-strong").textContent, "low▾");
	await click("thinking-option-xhigh"); assert.equal(changed?.strong?.thinkingLevel, "xhigh"); assert.equal(changed?.strong?.model?.id, a.id);
});

test("saved completeness follows ordinary repairs and survives temporary connection invalidation", async () => {
	installFetch(); let state: ReturnType<typeof useModelSetup>;
	function StateReader() { state = useModelSetup(false); return null; }
	await render(<StateReader />); await answer(0, catalog());
	assert.equal(state!.configured, true);
	await act(async () => notifySettingsSaved("keys")); assert.equal(state!.configured, true);
	const partial = catalog(false); partial.slots.vision = null;
	await answer(1, partial); assert.equal(state!.configured, false); assert.equal(state!.zeroKeys, true);
	await act(async () => notifySettingsSaved("models")); await answer(2, catalog(false));
	assert.equal(state!.configured, true); assert.equal(state!.zeroKeys, true, "saved is not connected");
});

test("blocked session recovery opens its ordinary picker, never changes Strong or substitutes a model", async () => {
	installFetch(); const available = { ...b, provider: "other" }; const body = catalog();
	body.models = [available]; body.providers = [{ id: "other", envVar: "OTHER_KEY", keyPresent: true }];
	body.slots.strong = { model: { provider: "other", id: b.id }, thinkingLevel: "medium" };
	const globals: ModelsSettings = { strong: body.slots.strong };
	const session = { model: { provider: a.provider, id: a.id }, thinkingLevel: "xhigh" };
	const requestsOnly = globalThis.fetch; const sessionWrites: unknown[] = [];
	globalThis.fetch = async (input, init) => {
		if (input === "/api/settings") return Response.json({ settings: { models: globals } });
		if (input === "/api/chats/fixture") return Response.json({ settings: session });
		if (input === "/api/chats/fixture/settings") { const next = JSON.parse(String(init?.body)); sessionWrites.push(next); return Response.json({ settings: next }); }
		return requestsOnly(input, init);
	};
	await warm(body); let selected: string | undefined;
	await render(<><Reader /><StatsBar turns={[]} chatId="fixture" onModelChange={(id) => { selected = id; }} /></>);
	assert.equal(selected, `${a.provider}:${a.id}`, "current session does not inherit a different Strong pin");
	assert.equal(selectedModelUnavailable(body, selected), true);
	assert.deepEqual(sessionWrites, []);
	await act(async () => openModelPicker());
	assert.ok(element("model-menu")); assert.equal(document.querySelector('[data-testid="setup-dialog"]'), null);
	assert.equal(document.querySelector('[data-testid="model-option-vendor_model_free"]'), null);
	await click("model-option-claude-opus-5-5");
	assert.deepEqual(sessionWrites, [{ model: { provider: "other", id: b.id }, thinkingLevel: "xhigh" }]);
	assert.equal(selected, `other:${b.id}`); assert.deepEqual(globals, { strong: body.slots.strong });
});

for (const result of ["override", "legacy", "http-failure", "network-failure"] as const) test(`known catalog never enforces provisional Strong on a pending session; session read ${result}`, async () => {
	installFetch(); const available = { ...b, provider: "other" }; const body = catalog();
	body.models = [available]; body.providers = [{ id: "other", envVar: "OTHER_KEY", keyPresent: true }];
	// Global Strong is unavailable, but this existing session owns a valid
	// model. Resolve global settings first while keeping its record pending.
	const globals: ModelsSettings = { strong: { model: { provider: a.provider, id: a.id }, thinkingLevel: "xhigh" } };
	let resolveSession!: (response: Response) => void;
	let rejectSession!: (reason: Error) => void;
	const sessionRead = new Promise<Response>((resolve, reject) => { resolveSession = resolve; rejectSession = reject; });
	const requestsOnly = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		if (input === "/api/settings") return Response.json({ settings: { models: globals } });
		if (input === "/api/chats/fixture") return sessionRead;
		return requestsOnly(input, init);
	};
	await warm(body); const identities: Array<string | undefined> = [];
	await render(<><Reader /><StatsBar turns={[]} chatId="fixture" onModelChange={(id) => { identities.push(id); }} /></>);
	assert.ok(snapshot.catalog, "catalog is already known, not the deferred unknown-catalog case");
	assert.equal(element("stats-model").textContent, "—▾");
	assert.equal(identities.at(-1), undefined);
	assert.equal(selectedModelUnavailable(snapshot.catalog, identities.at(-1)), false, "pending session cannot block Send using global Strong");
	await act(async () => {
		if (result === "network-failure") rejectSession(new Error("fixture connection failure"));
		else if (result === "http-failure") resolveSession(Response.json({ error: "fixture unavailable" }, { status: 503 }));
		else resolveSession(Response.json(result === "legacy" ? {} : { settings: { model: { provider: available.provider, id: available.id }, thinkingLevel: "medium" } }));
	});
	const expected = result === "legacy" ? `${a.provider}:${a.id}` : result === "override" ? `other:${b.id}` : undefined;
	assert.equal(identities.at(-1), expected);
	assert.equal(selectedModelUnavailable(snapshot.catalog, identities.at(-1)), result === "legacy", "only a confirmed legacy record may inherit the unavailable Strong pin");
	assert.equal(document.querySelector('[data-testid="model-menu"]'), null);
	assert.deepEqual(writes, []);
});

test("availability and setup completeness never conflate missing metadata, disconnected providers or saved identities", () => {
	const body = catalog(false);
	assert.equal(savedSlotsConfigured(body.slots), true);
	assert.equal(selectedModelUnavailable(body, `${a.provider}:${a.id}`), true);
	assert.equal(selectedModelUnavailable(undefined, `${a.provider}:${a.id}`), false);
	assert.equal(selectedModelUnavailable(body, undefined), false);
	body.models = [b]; body.providers = [{ ...provider, keyPresent: true }];
	assert.equal(selectedModelUnavailable(body, `${b.provider}:${b.id}`), false);
	body.slots.cheap = null; assert.equal(savedSlotsConfigured(body.slots), false);
});

test("shared refresh fences late failure as well as late success, and Retry clears a current error", async () => {
	installFetch(); await warm();
	await act(async () => snapshot.refresh()); await act(async () => snapshot.refresh());
	const fresh = catalog(); fresh.models = [b];
	await answer(2, fresh); await answer(1, null);
	assert.equal(snapshot.failed, false); assert.equal(snapshot.catalog?.models[0]?.id, b.id);
	await act(async () => snapshot.refresh()); await answer(3, null);
	assert.equal(snapshot.failed, true); assert.equal(snapshot.catalog?.models[0]?.id, b.id);
	await act(async () => snapshot.refresh()); assert.equal(snapshot.failed, false);
	await answer(4, fresh);
});

test("cache retention is hidden by default, slot-specific, resettable, and preserved by model/thinking edits", async () => {
	installFetch(); await warm();
	const changes: ModelsSettings[] = [];
	const initial: ModelsSettings = {
		strong: { model: { provider: a.provider, id: a.id }, thinkingLevel: "low", cacheRetention: "long" },
		cheap: { model: { provider: a.provider, id: a.id }, thinkingLevel: "high" },
		vision: { model: { provider: a.provider, id: a.id }, thinkingLevel: "low", cacheRetention: "none" },
	};
	function Settings() {
		const [models, setModels] = React.useState(initial);
		return <AgentSection agent={undefined} models={models} graph={undefined} compaction={undefined} onCompactionChange={() => {}} onSectionChange={() => {}} onModelsChange={(next) => { changes.push(next); setModels(next); }} />;
	}
	await render(<Settings />); await answer(1, catalog());
	assert.equal(element("models-advanced").textContent, "Show advanced settings");
	assert.equal(element("models-advanced").getAttribute("aria-expanded"), "false");
	assert.equal(document.querySelector('[data-testid="slot-cache-strong"]'), null);
	assert.equal(changes.length, 0, "mounting untouched controls writes nothing");
	await click("models-advanced");
	assert.equal(element("models-advanced").textContent, "Hide advanced settings");
	assert.equal(element("slot-cache-strong").textContent, "Cache: long▾");
	assert.equal(element("slot-cache-cheap").textContent, "Cache: default▾");
	assert.equal(element("slot-cache-vision").textContent, "Cache: not requested▾");
	await click("slot-cache-strong");
	const escape = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(escape, { key: "Escape" });
	await act(async () => { element("slot-cache-menu-strong").dispatchEvent(escape); });
	assert.equal(document.querySelector('[data-testid="slot-cache-menu-strong"]'), null);
	assert.equal(escape.defaultPrevented, true, "Escape is claimed before the outer dialog's document listener");
	for (const value of ["short", "none", "long", "default"]) {
		await click("slot-cache-strong");
		assert.match(element("slot-cache-menu-strong").textContent ?? "", /Providers may still cache automatically/);
		assert.match(element("slot-cache-menu-strong").textContent ?? "", /does not guarantee a cache hit/);
		await click(`cache-retention-option-${value}`);
		assert.equal(changes.at(-1)?.strong?.cacheRetention, value === "default" ? undefined : value);
		assert.deepEqual(changes.at(-1)?.cheap, initial.cheap);
		assert.deepEqual(changes.at(-1)?.vision, initial.vision);
	}
	assert.equal(Object.hasOwn(changes.at(-1)!.strong!, "cacheRetention"), false);
	await click("slot-cache-strong"); await click("cache-retention-option-long");
	await click("slot-model-strong"); await click("model-option-claude-opus-5-5");
	assert.equal(changes.at(-1)?.strong?.cacheRetention, "long");
	await click("slot-thinking-strong"); await click("thinking-option-off");
	assert.equal(changes.at(-1)?.strong?.cacheRetention, "long");
	await click("slot-cache-strong");
	await click("models-advanced");
	assert.equal(document.querySelector('[data-testid="slot-cache-menu-strong"]'), null, "collapse also closes the portaled menu");
	await click("models-advanced");
	assert.equal(element("slot-cache-strong").textContent, "Cache: long▾", "hiding did not reset the preference");
	await render(<Settings key="new-open" />);
	assert.equal(document.querySelector('[data-testid="slot-cache-strong"]'), null, "a new settings mount starts collapsed");
});

test("initial setup exposes no advanced controls and preserves all saved retention preferences on Save", async () => {
	installFetch();
	const body = catalog();
	body.slots.strong!.cacheRetention = "long";
	body.slots.cheap!.cacheRetention = "short";
	body.slots.vision!.cacheRetention = "none";
	await warm(body); await render(<><Reader />{setup()}</>); await answer(1, body);
	assert.equal(document.querySelector('[data-testid="models-advanced"]'), null);
	assert.equal(document.querySelector('[data-testid^="slot-cache-"]'), null);
	await click("setup-trigger-strong"); await click("model-option-claude-opus-5-5");
	await click("setup-save");
	assert.equal(writes[0]?.strong?.cacheRetention, "long");
	assert.equal(writes[0]?.cheap?.cacheRetention, "short");
	assert.equal(writes[0]?.vision?.cacheRetention, "none");
	assert.equal(writes[0]?.strong?.model?.id, b.id);
});

test("OpenCode's saved shared credential names both Pi providers without changing addable-provider semantics", () => {
	const providers = [{ id: "opencode", envVar: "OPENCODE_API_KEY", label: "OpenCode Zen" }, { id: "opencode-go", envVar: "OPENCODE_API_KEY", label: "OpenCode Go" }];
	assert.equal(providerKeyLabel("OPENCODE_API_KEY", providers), "OpenCode (Zen / Go)");
	assert.equal(providerKeyLabel("OPENCODE_API_KEY", [...providers].reverse()), "OpenCode (Zen / Go)");
	assert.equal(providerKeyLabel("FIXTURE_KEY", [provider]), "Fixture");
	assert.equal(classifyKeys([{ id: "OPENCODE_API_KEY", info: null, present: true, masked: "…fake", source: "file", shadowedByEnv: false }], providers).addable.length, 0);
});
