import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { normalizeContext, type Api, type AssistantMessage, type AssistantMessageEvent, type Model, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { ModelMenuList } from "../components/settings/model-menu.tsx";
import { opencodePlanLabel, type ModelCatalogEntry } from "../src/core/index.ts";
import { openCodeStream, withOpenCodePlanHint } from "../src/agent/opencode-errors.ts";
import { piEngineForSpec } from "../src/agent/models.ts";

const GO = "This is an OpenCode Go model. It needs a Go subscription.";
const ZEN = "This is an OpenCode Zen model. It uses your Zen balance, not Go.";

test("plan labels name only the OpenCode providers", () => {
	assert.equal(opencodePlanLabel("opencode"), "OpenCode Zen");
	assert.equal(opencodePlanLabel("opencode-go"), "OpenCode Go");
	assert.equal(opencodePlanLabel("openrouter"), undefined);
});

test("a 402/403 from an OpenCode plan keeps the upstream text and adds the plan line", () => {
	assert.equal(withOpenCodePlanHint("opencode", '402: {"message":"insufficient funds"}'), `402: {"message":"insufficient funds"}\n${ZEN}`);
	assert.equal(withOpenCodePlanHint("opencode-go", "403: Go subscription required"), `403: Go subscription required\n${GO}`);
	assert.equal(withOpenCodePlanHint("opencode-go", "opencode-go API error (403): denied"), `opencode-go API error (403): denied\n${GO}`);
	assert.equal(withOpenCodePlanHint("opencode", "403 status code (no body)"), `403 status code (no body)\n${ZEN}`);
});

test("other statuses, other providers and missing messages pass through unchanged", () => {
	assert.equal(withOpenCodePlanHint("opencode", "429: rate limited"), "429: rate limited");
	assert.equal(withOpenCodePlanHint("opencode", "500: upstream 4030 tokens"), "500: upstream 4030 tokens");
	assert.equal(withOpenCodePlanHint("openrouter", "403: forbidden"), "403: forbidden");
	assert.equal(withOpenCodePlanHint("opencode-go", undefined), undefined);
});

function message(model: Model<Api>, extra: Partial<AssistantMessage>): AssistantMessage {
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "stop", timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra };
}
function fakeSource(events: (model: Model<Api>) => AssistantMessageEvent[]): StreamFunction<Api, SimpleStreamOptions> {
	return (model) => {
		const s = new AssistantMessageEventStream();
		queueMicrotask(() => { for (const e of events(model)) s.push(e); s.end(); });
		return s;
	};
}
const goModel = { id: "kimi-k3", name: "Kimi K3", provider: "opencode-go", api: "openai-completions" } as unknown as Model<Api>;

test("the OpenCode stream adds the hint to the terminal error event and result", async () => {
	const stream = openCodeStream(fakeSource((m) => {
		const error = message(m, { stopReason: "error", errorMessage: "402: insufficient funds" });
		return [{ type: "start", partial: message(m, {}) }, { type: "error", reason: "error", error }];
	}))(goModel, normalizeContext({ messages: [] }));
	const seen: AssistantMessageEvent[] = [];
	for await (const e of stream) seen.push(e);
	assert.deepEqual(seen.map((e) => e.type), ["start", "error"]);
	const last = seen[1] as Extract<AssistantMessageEvent, { type: "error" }>;
	assert.equal(last.error.errorMessage, `402: insufficient funds\n${GO}`);
	assert.equal((await stream.result()).errorMessage, `402: insufficient funds\n${GO}`);
});

test("the OpenCode stream passes a successful response through untouched", async () => {
	const done = message(goModel, { content: [{ type: "text", text: "hi" }] });
	const stream = openCodeStream(fakeSource(() => [{ type: "done", reason: "stop", message: done }]))(goModel, normalizeContext({ messages: [] }));
	assert.deepEqual(await stream.result(), done);
});

test("an OpenCode Go engine surfaces a real 402 with the plan line", async () => {
	const realFetch = globalThis.fetch, realKey = process.env.OPENCODE_API_KEY;
	process.env.OPENCODE_API_KEY = "oc-scratch-key-never-sent";
	globalThis.fetch = async () => new Response(JSON.stringify({ type: "error", message: "insufficient funds" }), { status: 402, headers: { "content-type": "application/json" } });
	try {
		const engine = piEngineForSpec({ provider: "opencode-go", id: "kimi-k3" } as Parameters<typeof piEngineForSpec>[0]);
		const stream = await engine.streamFn!(engine.model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), { maxRetries: 0 });
		const result = await stream.result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /402/);
		assert.ok(result.errorMessage?.endsWith(`\n${GO}`), result.errorMessage);
	} finally {
		globalThis.fetch = realFetch;
		if (realKey === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = realKey;
	}
});

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

test("the model menu names the OpenCode plan on Zen and Go rows of the same model", async () => {
	const base: ModelCatalogEntry = { id: "kimi-k3", name: "Kimi K3", provider: "opencode", input: ["text"], reasoning: true, supportedLevels: ["off"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
	const models = [base, { ...base, provider: "opencode-go" }, { ...base, provider: "openrouter", id: "moonshot/kimi-k3" }];
	const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<ModelMenuList models={models} effectiveId={undefined} onPick={() => {}} />));
	const rows = [...document.querySelectorAll('[data-testid="model-list"] li')].map((li) => li.textContent ?? "");
	assert.ok(rows.some((t) => t.includes("OpenCode Zen · kimi-k3")), rows.join(" | "));
	assert.ok(rows.some((t) => t.includes("OpenCode Go · kimi-k3")), rows.join(" | "));
	assert.ok(rows.some((t) => t.includes("openrouter · moonshot/kimi-k3")), rows.join(" | "));
});
