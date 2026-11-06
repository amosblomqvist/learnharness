import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ModelMenuList } from "../components/settings/model-menu.tsx";
import { AgentSection } from "../components/settings/agent-section.tsx";
import { SetupDialog } from "../components/setup-dialog.tsx";
import { StatsBar } from "../components/stats-bar.tsx";
import type { ChatSettings, ModelCatalogEntry, ModelCatalogResponse, ModelsSettings } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
Object.assign(dom.document, { oninput: null });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

const sol: ModelCatalogEntry = { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "chatgpt", input: ["text", "image"], reasoning: true, supportedLevels: ["low", "medium", "high"], cost: null, contextWindow: 400_000, maxTokens: 1024, fast: { description: "2x speed, increased usage" } };
const mini: ModelCatalogEntry = { ...sol, id: "gpt-6.1-mini", name: "GPT-6.1 Mini", fast: { description: "" } };
const codex: ModelCatalogEntry = { ...sol, id: "gpt-5-codex", name: "GPT-5 Codex", fast: undefined };
const claude: ModelCatalogEntry = { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic", input: ["text"], reasoning: true, supportedLevels: ["off", "high"], cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 1024 };
delete codex.fast;
const solPin = { provider: sol.provider, id: sol.id };

function catalog(models: ModelCatalogEntry[] = [sol, mini, codex, claude], slots: Partial<ModelCatalogResponse["slots"]> = {}): ModelCatalogResponse {
	return {
		models, defaults: null,
		rolePins: { researcher: null, demoBuilder: null, visualMaker: null, extractor: null, auditor: null },
		slots: { strong: { model: solPin, thinkingLevel: "medium" }, cheap: { model: solPin, thinkingLevel: "low" }, vision: { model: solPin, thinkingLevel: "low" }, ...slots },
		providers: [{ id: "chatgpt", envVar: "", keyPresent: true }, { id: "anthropic", envVar: "ANTHROPIC_API_KEY", keyPresent: true }],
	} as ModelCatalogResponse;
}

async function render(children: React.ReactNode) {
	// Imported after the DOM globals so React sees document.oninput (search typing).
	const { createRoot } = await import("react-dom/client");
	if (!root) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
	await act(async () => root!.render(children));
	await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}
function element(testid: string) { const e = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`); assert.ok(e, testid); return e; }
async function click(testid: string) { await act(async () => element(testid).click()); }
const options = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="model-list"] button')];
const optionIds = () => options().map((o) => o.dataset.testid);
const selected = (testid: string) => /(^|\s)bg-muted\/60(\s|$)/.test(element(testid).className);
const hasBolt = (testid: string) => element(testid).querySelector("svg") !== null;
async function search(value: string) {
	const input = element("model-search") as HTMLInputElement;
	await act(async () => {
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
}

/** Answers every route these surfaces read; records the two write routes. */
function installFetch(opts: { models?: ModelCatalogResponse; session?: ChatSettings; globals?: ModelsSettings }) {
	const chatWrites: ChatSettings[] = [];
	const modelWrites: ModelsSettings[] = [];
	globalThis.fetch = async (input, init) => {
		const path = String(input);
		if (path === "/api/models") return Response.json(opts.models ?? catalog());
		if (path === "/api/settings") return Response.json({ settings: { models: opts.globals } });
		if (path === "/api/chats/fixture") return Response.json({ settings: opts.session });
		if (path === "/api/chats/fixture/settings") { const next = JSON.parse(String(init?.body)); chatWrites.push(next); return Response.json({ settings: next }); }
		if (path === "/api/settings/models") { const next = JSON.parse(String(init?.body)); modelWrites.push(next); opts.globals = next; return Response.json({ settings: { models: next } }); }
		if (path === "/api/keys") return Response.json({ providers: [], keys: [] });
		if (path === "/api/settings/prompts") return Response.json({ prober: [], teacher: [], practice: [] });
		if (path === "/api/search") return Response.json({ available: false, engine: null, reason: "fixture" });
		throw new Error(`Unexpected request ${path}`);
	};
	return { chatWrites, modelWrites };
}

afterEach(async () => {
	await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined;
	globalThis.fetch = originalFetch;
});

// S7, S4, S9: rows, text, adjacency and search.
test("each Fast-capable model gets a tagged Fast row right after its base row, with OpenAI's text; others get none", async () => {
	await render(<ModelMenuList models={[sol, mini, codex, claude]} effectiveId={undefined} onPick={() => {}} />);
	assert.deepEqual(optionIds(), [
		"model-option-claude-sonnet-5-5",
		"model-option-gpt-5-codex",
		"model-option-gpt-6_1-mini",
		"model-option-gpt-6_1-mini-fast",
		"model-option-gpt-6_1-sol",
		"model-option-gpt-6_1-sol-fast",
	]);
	const fast = element("model-option-gpt-6_1-sol-fast");
	assert.equal(fast.textContent, "GPT-6.1 SolFastChatGPTChatGPT (subscription) · gpt-6.1-sol · 2x speed, increased usage400k");
	const tag = [...fast.querySelectorAll("span")].find((s) => s.textContent === "Fast");
	assert.ok(tag, "the Fast tag");
	assert.match(tag.className, /rounded-sm/); assert.match(tag.className, /border/); assert.match(tag.className, /px-1/); assert.match(tag.className, /text-xs/);
	assert.ok(tag.querySelector("svg[aria-hidden]"), "the bolt is decorative");
	assert.equal(element("model-option-gpt-6_1-mini-fast").textContent, "GPT-6.1 MiniFastChatGPTChatGPT (subscription) · gpt-6.1-mini400k", "an empty description adds nothing");
	assert.equal(element("model-option-gpt-6_1-sol").textContent, "GPT-6.1 SolChatGPTChatGPT (subscription) · gpt-6.1-sol400k", "the base row is unchanged");
	assert.equal(element("model-option-gpt-6_1-sol").querySelector("svg"), null);
});

test("searching \"fast\" shows only Fast rows; ranking never separates a Fast row from a visible base row", async () => {
	await render(<ModelMenuList models={[sol, mini, codex, claude]} effectiveId={undefined} onPick={() => {}} />);
	await search("fast");
	assert.deepEqual(optionIds(), ["model-option-gpt-6_1-mini-fast", "model-option-gpt-6_1-sol-fast"]);
	// "s" ranks the word "fast" above "sol": the Fast row still follows its base.
	await search("s");
	const ids = optionIds();
	const at = ids.indexOf("model-option-gpt-6_1-sol-fast");
	assert.equal(ids[at - 1], "model-option-gpt-6_1-sol", ids.join(","));
});

test("the selected mark follows fast, and a pick reports whether Fast was picked", async () => {
	const picked: Array<[ModelCatalogEntry, boolean]> = [];
	await render(<ModelMenuList models={[sol, codex]} effectiveId={sol.id} effectiveProvider="chatgpt" onPick={(m, fast) => picked.push([m, fast])} />);
	assert.equal(selected("model-option-gpt-6_1-sol"), true);
	assert.equal(selected("model-option-gpt-6_1-sol-fast"), false);
	await render(<ModelMenuList models={[sol, codex]} effectiveId={sol.id} effectiveProvider="chatgpt" effectiveFast onPick={(m, fast) => picked.push([m, fast])} />);
	assert.equal(selected("model-option-gpt-6_1-sol"), false);
	assert.equal(selected("model-option-gpt-6_1-sol-fast"), true);
	await click("model-option-gpt-6_1-sol-fast");
	await click("model-option-gpt-6_1-sol");
	assert.equal(picked[0]![0], sol); assert.equal(picked[0]![1], true);
	assert.equal(picked[1]![0], sol); assert.equal(picked[1]![1], false);
});

// S3, S5, S7: the session picker.
test("session pill: Fast rows write fast, thinking edits and the cycle preserve it, base rows drop it", async () => {
	const { chatWrites } = installFetch({ session: { model: solPin, thinkingLevel: "medium", fast: true } });
	await render(<StatsBar turns={[]} chatId="fixture" />);
	assert.equal(element("stats-model").textContent, "gpt-6.1-sol▾");
	assert.equal(hasBolt("stats-model"), true, "pin and catalog both have Fast");
	await click("stats-thinking"); await click("thinking-option-high");
	assert.deepEqual(chatWrites.at(-1), { model: solPin, thinkingLevel: "high", fast: true });
	await act(async () => { window.dispatchEvent(new CustomEvent("lh:kbd-cycle-thinking")); });
	assert.deepEqual(chatWrites.at(-1), { model: solPin, thinkingLevel: "low", fast: true });
	await click("stats-model");
	assert.equal(selected("model-option-gpt-6_1-sol-fast"), true);
	await click("model-option-gpt-6_1-sol");
	assert.deepEqual(chatWrites.at(-1), { model: solPin, thinkingLevel: "low" });
	assert.equal(hasBolt("stats-model"), false);
	await click("stats-model"); await click("model-option-gpt-6_1-mini-fast");
	assert.deepEqual(chatWrites.at(-1), { model: { provider: "chatgpt", id: mini.id }, thinkingLevel: "low", fast: true });
	assert.equal(hasBolt("stats-model"), true);
});

test("session pill drops the bolt when the catalog stops offering Fast (S5)", async () => {
	installFetch({ models: catalog([{ ...sol, fast: undefined }, codex]), session: { model: solPin, thinkingLevel: "medium", fast: true } });
	await render(<StatsBar turns={[]} chatId="fixture" />);
	assert.equal(element("stats-model").textContent, "gpt-6.1-sol▾");
	assert.equal(hasBolt("stats-model"), false);
});

test("legacy chat (no own model): a thinking edit carries Strong's Fast while the catalog offers it", async () => {
	const offered = installFetch({ models: catalog([sol, codex]), session: { thinkingLevel: "medium" }, globals: { strong: { model: solPin, thinkingLevel: "medium", fast: true } } });
	await render(<StatsBar turns={[]} chatId="fixture" />);
	await click("stats-thinking"); await click("thinking-option-high");
	assert.deepEqual(offered.chatWrites.at(-1), { model: solPin, thinkingLevel: "high", fast: true });
});

test("legacy chat: once the catalog drops Fast, a thinking edit does not copy Strong's Fast into the chat (S5)", async () => {
	const dropped = installFetch({ models: catalog([{ ...sol, fast: undefined }, codex]), session: { thinkingLevel: "medium" }, globals: { strong: { model: solPin, thinkingLevel: "medium", fast: true } } });
	await render(<StatsBar turns={[]} chatId="fixture" />);
	await click("stats-thinking"); await click("thinking-option-high");
	assert.deepEqual(dropped.chatWrites.at(-1), { model: solPin, thinkingLevel: "high" });
});

test("draft pill writes the strong slot's fast and keeps it across thinking edits", async () => {
	const { modelWrites, chatWrites } = installFetch({ globals: { strong: { model: solPin, thinkingLevel: "medium", fast: true }, cheap: { model: solPin } } });
	await render(<StatsBar turns={[]} />);
	assert.equal(hasBolt("stats-model"), true);
	await click("stats-thinking"); await click("thinking-option-high");
	assert.deepEqual(modelWrites.at(-1), { strong: { model: solPin, thinkingLevel: "high", fast: true }, cheap: { model: solPin } });
	await click("stats-model"); await click("model-option-gpt-6_1-sol");
	assert.deepEqual(modelWrites.at(-1), { strong: { model: solPin, thinkingLevel: "high" }, cheap: { model: solPin } });
	await click("stats-model"); await click("model-option-gpt-6_1-sol-fast");
	assert.deepEqual(modelWrites.at(-1), { strong: { model: solPin, thinkingLevel: "high", fast: true }, cheap: { model: solPin } });
	assert.deepEqual(chatWrites, []);
});

// S3, S7: Settings → Agent model slots.
test("agent slots: same rows and picks; thinking and cache edits keep fast; the trigger shows the bolt", async () => {
	installFetch({});
	const changes: ModelsSettings[] = [];
	const initial: ModelsSettings = { strong: { model: solPin, thinkingLevel: "medium", fast: true }, cheap: { model: solPin, thinkingLevel: "low" } };
	function Settings() {
		const [models, setModels] = React.useState(initial);
		return <AgentSection agent={undefined} models={models} graph={undefined} compaction={undefined} onCompactionChange={() => {}} onSectionChange={() => {}} onModelsChange={(next) => { changes.push(next); setModels(next); }} />;
	}
	await render(<Settings />);
	assert.equal(hasBolt("slot-model-strong"), true);
	assert.equal(hasBolt("slot-model-cheap"), false);
	await click("slot-thinking-strong"); await click("thinking-option-high");
	assert.deepEqual(changes.at(-1)?.strong, { model: solPin, thinkingLevel: "high", fast: true });
	await click("models-advanced"); await click("slot-cache-strong"); await click("cache-retention-option-long");
	assert.deepEqual(changes.at(-1)?.strong, { model: solPin, thinkingLevel: "high", fast: true, cacheRetention: "long" });
	await click("slot-model-strong");
	assert.equal(selected("model-option-gpt-6_1-sol-fast"), true);
	await click("model-option-gpt-6_1-sol");
	assert.deepEqual(changes.at(-1)?.strong, { model: solPin, thinkingLevel: "high", cacheRetention: "long" });
	assert.equal(hasBolt("slot-model-strong"), false);
	await click("slot-model-cheap"); await click("model-option-gpt-6_1-mini-fast");
	assert.deepEqual(changes.at(-1)?.cheap, { model: { provider: "chatgpt", id: mini.id }, thinkingLevel: "low", fast: true });
	assert.deepEqual(changes.at(-1)?.strong, { model: solPin, thinkingLevel: "high", cacheRetention: "long" });
	assert.equal(hasBolt("slot-model-cheap"), true);
});

// S3, S7: setup dialog.
test("setup dialog: a saved Fast pin survives Save; Fast rows write fast, base rows drop it", async () => {
	const { modelWrites } = installFetch({ models: catalog(undefined, { strong: { model: solPin, thinkingLevel: "medium", fast: true } }) });
	await render(<SetupDialog open onClose={() => {}} onDone={() => {}} />);
	await click("setup-trigger-strong");
	assert.equal(selected("model-option-gpt-6_1-sol-fast"), true);
	assert.equal(selected("model-option-gpt-6_1-sol"), false);
	await click("setup-trigger-strong");
	await click("setup-save");
	assert.deepEqual(modelWrites[0], {
		strong: { model: solPin, thinkingLevel: "medium", fast: true },
		cheap: { model: solPin, thinkingLevel: "low" },
		vision: { model: solPin, thinkingLevel: "low" },
	});
	await render(<SetupDialog key="second" open onClose={() => {}} onDone={() => {}} />);
	await click("setup-trigger-strong"); await click("model-option-gpt-6_1-sol");
	await click("setup-trigger-cheap"); await click("model-option-gpt-6_1-mini-fast");
	await click("setup-save");
	assert.deepEqual(modelWrites[1], {
		strong: { model: solPin, thinkingLevel: "medium" },
		cheap: { model: { provider: "chatgpt", id: mini.id }, thinkingLevel: "low", fast: true },
		vision: { model: solPin, thinkingLevel: "low" },
	});
});
