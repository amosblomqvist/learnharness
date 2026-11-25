import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ClaudeCodeInstallationStatus, claudeCodeStatusLabel } from "../components/settings/claude-code-status.tsx";
import { ConnectionRow } from "../components/settings/connection-controls.tsx";
import { useModelCatalog } from "../components/model-catalog.ts";
import type { ClaudeCodeStatus } from "../src/core/contracts/claude-code.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
const status = (state: ClaudeCodeStatus["state"], version: string | null = null): ClaudeCodeStatus => ({ state, version, minimumVersion: "2.1.259" });
const button = () => document.querySelector<HTMLButtonElement>('[data-testid="claude-code-check-again"]')!;
const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]')!;
const label = () => document.querySelector('[role="status"]')?.textContent;
function fixture(probe: (init?: RequestInit) => Promise<Response>, enabled = true, failSave = false) {
	const calls: string[] = [];
	let on = enabled;
	globalThis.fetch = (async (url, init) => {
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url === "/api/settings") return Response.json({ settings: { version: 1, claudeCode: { enabled: on } } });
		if (url === "/api/settings/claudeCode") {
			assert.equal(init?.method, "PUT"); assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
			if (failSave) return new Response(null, { status: 500 });
			on = JSON.parse(String(init.body)).enabled;
			return Response.json({ settings: { version: 1, claudeCode: { enabled: on } } });
		}
		if (url === "/api/models") return Response.json({ models: on ? [{ provider: "claude-code", id: "sonnet" }] : [] });
		assert.equal(url, "/api/claude-code");
		assert.equal(init?.cache, "no-store");
		assert.equal(new Headers(init?.headers).get("x-learnharness-claude-code"), "1");
		return probe(init);
	}) as typeof fetch;
	return calls;
}
async function mount(extra?: React.ReactNode) {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<><ClaudeCodeInstallationStatus />{extra}</>));
}
afterEach(async () => {
	await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined;
	globalThis.fetch = originalFetch;
});

test("initial render is collapsed and off, with no setup prose or version probe action", () => {
	const html = renderToStaticMarkup(<ClaudeCodeInstallationStatus />);
	assert.match(html, /Claude Code/); assert.match(html, /aria-checked="false"/);
	assert.equal((html.match(/<button/g) ?? []).length, 1);
	assert(!html.includes("Check again")); assert(!html.includes("Authenticate")); assert(!html.includes("Setup ↗"));
});

test("off by default; enabling persists before probing and reveals the version/action row below the toggle", async () => {
	const calls = fixture(async () => Response.json(status("not-found")), false);
	await mount();
	assert.equal(toggle().getAttribute("aria-checked"), "false"); assert(!button());
	assert.deepEqual(calls, ["GET /api/settings"]);
	await act(async () => toggle().click());
	assert.equal(toggle().getAttribute("aria-checked"), "true"); assert.equal(label(), "Not found");
	assert(calls.indexOf("PUT /api/settings/claudeCode") < calls.indexOf("GET /api/claude-code"));
	assert.notEqual(toggle().parentElement, button().parentElement);
	assert.equal(document.querySelector('[role="status"]')?.parentElement, button().parentElement);
	assert.match(document.body.textContent ?? "", /no background process required/);
	assert.match(document.body.textContent ?? "", /not authentication, model access, or quota/);
	assert.match(document.body.textContent ?? "", /Claude Code controls billing/);
	assert.match(document.body.textContent ?? "", /Verify AI claims independently—they may be inaccurate, incomplete, misleading, or outdated\./);
	assert(document.querySelector("strong")?.textContent?.includes("Install and authenticate"));
	assert.equal(document.querySelector("a")?.getAttribute("href"), "https://code.claude.com/docs/en/setup");
	await act(async () => toggle().click());
	assert.equal(toggle().getAttribute("aria-checked"), "false"); assert(!button()); assert.equal(label(), undefined);
	assert.equal(calls.filter((call) => call === "GET /api/claude-code").length, 1);
});

test("recheck matches Connect styling; Manage remains ghost", async () => {
	fixture(async () => Response.json(status("not-found"))); await mount();
	const row = (action: string) => parseHTML(renderToStaticMarkup(<ConnectionRow label="Fixture" action={action} disabled={false} onAction={() => {}} />)).document.querySelector("button")!;
	assert.equal(button().getAttribute("class"), row("Connect").getAttribute("class"));
	assert.equal(button().getAttribute("data-variant"), "outline");
	assert.equal(row("Manage").getAttribute("data-variant"), "ghost");
});

for (const [value, text] of [
	[status("not-found"), "Not found"],
	[status("meets-minimum", "2.1.310"), "Version 2.1.310 · meets minimum"],
	[status("update-required", "2.1.258"), "Version 2.1.258 · update required"],
	[status("version-unchecked"), "Version could not be checked"],
] as const) test(`installation display: ${text}`, () => assert.equal(claudeCodeStatusLabel(value), text));

test("enabled mount checks once; outlined Check again refreshes without probing authentication", async () => {
	let probes = 0;
	const calls = fixture(async () => Response.json(++probes === 1 ? status("not-found") : status("meets-minimum", "2.1.310")));
	await mount(); assert.equal(label(), "Not found");
	await act(async () => button().click()); assert.equal(label(), "Version 2.1.310 · meets minimum");
	assert.equal(calls.filter((call) => call === "GET /api/claude-code").length, 2);
});

test("failed opt-in save stays collapsed/off and never probes", async () => {
	const calls = fixture(async () => assert.fail("must not probe"), false, true);
	await mount(); await act(async () => toggle().click());
	assert.equal(toggle().getAttribute("aria-checked"), "false"); assert(!button());
	assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /Could not save/);
	assert(!calls.includes("GET /api/claude-code"));
});

test("slow checks disable recheck; switching off aborts pending version work without starting another probe", async () => {
	let signal: AbortSignal | null | undefined;
	let resolve!: (response: Response) => void;
	fixture((init) => { signal = init?.signal; return new Promise<Response>((done) => { resolve = done; }); });
	await mount(); assert.equal(label(), "Checking…"); assert(button().disabled); assert(!toggle().disabled);
	await act(async () => toggle().click()); assert(signal?.aborted); assert(!button());
	await act(async () => resolve(Response.json(status("meets-minimum", "2.1.310")))); assert.equal(label(), undefined);
});

for (const failure of ["network", "http", "payload"] as const) test(`${failure} failure never retains a stale meets-minimum status`, async () => {
	let calls = 0;
	fixture(async () => {
		if (++calls === 1) return Response.json(status("meets-minimum", "2.1.310"));
		if (failure === "network") throw new Error("offline");
		return failure === "http" ? new Response(null, { status: 503 }) : Response.json({ state: "authenticated" });
	});
	await mount(); assert.equal(label(), "Version 2.1.310 · meets minimum");
	await act(async () => button().click()); assert.equal(label(), "Version could not be checked"); assert(!button().disabled);
});

function CatalogReader() {
	const { catalog } = useModelCatalog();
	return <span data-testid="cli-catalog-models">{catalog?.models.map((m) => `${m.provider}:${m.id}`).join(",") ?? "loading"}</span>;
}
test("persisted toggle updates invalidate shared model availability in both directions", async () => {
	fixture(async () => Response.json(status("not-found")), false);
	await mount(<CatalogReader />);
	const models = () => document.querySelector('[data-testid="cli-catalog-models"]')?.textContent;
	assert.equal(models(), "");
	await act(async () => toggle().click()); assert.equal(models(), "claude-code:sonnet");
	await act(async () => toggle().click()); assert.equal(models(), "");
});
