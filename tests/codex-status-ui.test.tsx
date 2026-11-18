import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { CodexInstallationStatus } from "../components/settings/codex-status.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { KeysSection } from "../components/settings/keys-section.tsx";
import { externalCliStatusLabel } from "../components/settings/external-cli-status.tsx";
import { ConnectionRow } from "../components/settings/connection-controls.tsx";
import { useModelCatalog } from "../components/model-catalog.ts";
import type { ExternalCliStatus } from "../src/core/contracts/external-cli.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
const status = (state: ExternalCliStatus["state"], version: string | null = null): ExternalCliStatus => ({ state, version, minimumVersion: "0.165.0" });
const button = () => document.querySelector<HTMLButtonElement>('[data-testid="codex-check-again"]')!;
const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]')!;
const label = () => document.querySelector('[role="status"]')?.textContent;
function fixture(probe: (init?: RequestInit) => Promise<Response>, enabled = true, failSave = false) {
	const calls: string[] = [];
	let on = enabled;
	globalThis.fetch = (async (url, init) => {
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url === "/api/settings") return Response.json({ settings: { version: 1, codex: { enabled: on } } });
		if (url === "/api/settings/codex") {
			assert.equal(init?.method, "PUT"); assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
			if (failSave) return new Response(null, { status: 500 });
			on = JSON.parse(String(init.body)).enabled;
			return Response.json({ settings: { version: 1, codex: { enabled: on } } });
		}
		if (url === "/api/models") return Response.json({ models: on ? [{ provider: "codex", id: "sonnet" }] : [] });
		assert.equal(url, "/api/codex");
		assert.equal(init?.cache, "no-store");
		assert.equal(new Headers(init?.headers).get("x-learnharness-external-cli"), "1");
		return probe(init);
	}) as typeof fetch;
	return calls;
}
async function mount(extra?: React.ReactNode) {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<><CodexInstallationStatus />{extra}</>));
}
afterEach(async () => {
	await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined;
	globalThis.fetch = originalFetch;
});

test("External CLI group contains Claude Code followed by Codex", async () => {
	globalThis.fetch = (async (url) => url === "/api/settings"
		? Response.json({ settings: { version: 1 } })
		: Response.json({ providers: [], keys: [] })) as typeof fetch;
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<InteractionLayersProvider><KeysSection /></InteractionLayersProvider>));
	const group = document.querySelector('[data-testid="group-external-cli"]')!;
	const rows = [...group.querySelectorAll('[data-testid$="-installation"]')];
	assert.deepEqual(rows.map((row) => row.getAttribute("data-testid")), ["claude-code-installation", "codex-installation", "gemini-cli-installation"]);
});

test("initial render is collapsed and off, with no setup prose or version probe action", () => {
	const html = renderToStaticMarkup(<CodexInstallationStatus />);
	assert.match(html, /Codex/); assert.match(html, /aria-checked="false"/);
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
	assert(calls.indexOf("PUT /api/settings/codex") < calls.indexOf("GET /api/codex"));
	assert.notEqual(toggle().parentElement, button().parentElement);
	assert.equal(document.querySelector('[role="status"]')?.parentElement, button().parentElement);
	assert.match(document.body.textContent ?? "", /no background process required/);
	assert.match(document.body.textContent ?? "", /not authentication, model access, or quota/);
	assert.match(document.body.textContent ?? "", /Codex controls billing/);
	assert.match(document.body.textContent ?? "", /Verify AI claims independently—they may be inaccurate, incomplete, misleading, or outdated\./);
	assert(document.querySelector("strong")?.textContent?.includes("Install and sign in"));
	assert.equal(document.querySelector("a")?.getAttribute("href"), "https://developers.openai.com/codex/cli");
	assert.equal(document.querySelector("code")?.textContent, "~/.codex/AGENTS.md");
	await act(async () => toggle().click());
	assert.equal(toggle().getAttribute("aria-checked"), "false"); assert(!button()); assert.equal(label(), undefined);
	assert.equal(calls.filter((call) => call === "GET /api/codex").length, 1);
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
	[status("meets-minimum", "0.166.0"), "Version 0.166.0 · meets minimum"],
	[status("update-required", "0.164.0"), "Version 0.164.0 · update required"],
	[status("version-unchecked"), "Version could not be checked"],
] as const) test(`installation display: ${text}`, () => assert.equal(externalCliStatusLabel(value), text));

test("enabled mount checks once; outlined Check again refreshes without probing authentication", async () => {
	let probes = 0;
	const calls = fixture(async () => Response.json(++probes === 1 ? status("not-found") : status("meets-minimum", "0.166.0")));
	await mount(); assert.equal(label(), "Not found");
	await act(async () => button().click()); assert.equal(label(), "Version 0.166.0 · meets minimum");
	assert.equal(calls.filter((call) => call === "GET /api/codex").length, 2);
});

test("failed opt-in save stays collapsed/off and never probes", async () => {
	const calls = fixture(async () => assert.fail("must not probe"), false, true);
	await mount(); await act(async () => toggle().click());
	assert.equal(toggle().getAttribute("aria-checked"), "false"); assert(!button());
	assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /Could not save/);
	assert(!calls.includes("GET /api/codex"));
});

test("slow checks disable recheck; switching off aborts pending version work without starting another probe", async () => {
	let signal: AbortSignal | null | undefined;
	let resolve!: (response: Response) => void;
	fixture((init) => { signal = init?.signal; return new Promise<Response>((done) => { resolve = done; }); });
	await mount(); assert.equal(label(), "Checking…"); assert(button().disabled); assert(!toggle().disabled);
	await act(async () => toggle().click()); assert(signal?.aborted); assert(!button());
	await act(async () => resolve(Response.json(status("meets-minimum", "0.166.0")))); assert.equal(label(), undefined);
});

for (const failure of ["network", "http", "payload"] as const) test(`${failure} failure never retains a stale meets-minimum status`, async () => {
	let calls = 0;
	fixture(async () => {
		if (++calls === 1) return Response.json(status("meets-minimum", "0.166.0"));
		if (failure === "network") throw new Error("offline");
		return failure === "http" ? new Response(null, { status: 503 }) : Response.json({ state: "authenticated" });
	});
	await mount(); assert.equal(label(), "Version 0.166.0 · meets minimum");
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
	await act(async () => toggle().click()); assert.equal(models(), "codex:sonnet");
	await act(async () => toggle().click()); assert.equal(models(), "");
});
