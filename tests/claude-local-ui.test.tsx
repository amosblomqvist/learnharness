/** Local Claude route (2026-10-27): the Providers card — every probe state
 *  renders its own line and the approved copy; no sign-in control exists;
 *  helper-tier pickers never list the provider; a preference flip probes
 *  only when the opt-in or path changed (linkedom DOM, fetch mocked). */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ClaudeLocalConnection, ClaudeLocalDialogBody, CLAUDE_LOCAL_DISCLOSURE, claudeLocalStateLine, claudeLocalUsageLine, emptyClaudeLocalStatus } from "../components/settings/claude-local-connection.tsx";
import { ModelMenuList } from "../components/settings/model-menu.tsx";
import { toModelDto } from "../src/server/model-catalog.ts";
import { piModels } from "../src/agent/models.ts";
import type { ClaudeLocalStatus } from "../src/core/contracts/claude-local.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; globalThis.fetch = originalFetch; });

const base = emptyClaudeLocalStatus();
const ready: ClaudeLocalStatus = { ...base, enabled: true, state: "ready", binary: { path: "/opt/homebrew/bin/claude", version: "2.1.311", source: "path" }, account: { subscriptionType: "max", apiProvider: "firstParty" }, models: 4, probedAt: "2026-10-27T00:00:00Z", revision: 3 };

test("the state line and usage line read honestly for every probe outcome", () => {
	assert.equal(claudeLocalStateLine(base), "Not in use.");
	assert.equal(claudeLocalStateLine(ready), "Claude Code 2.1.311 found, signed in with a Claude plan (max). 4 models available.");
	assert.equal(claudeLocalStateLine({ ...ready, state: "not-found", binary: null }), "Claude Code not found.");
	assert.equal(claudeLocalStateLine({ ...ready, state: "unsupported-version", binary: { ...ready.binary!, version: "2.1.100" } }), "Claude Code 2.1.100 is older than the required 2.1.248.");
	assert.equal(claudeLocalStateLine({ ...ready, state: "not-signed-in" }), "Claude Code 2.1.311 found, not signed in.");
	assert.match(claudeLocalStateLine({ ...ready, state: "api-key" }), /signed in with an API key or Console account; this route only runs on a Claude plan login/);
	assert.match(claudeLocalStateLine({ ...ready, state: "third-party" }), /cloud provider/);
	assert.equal(claudeLocalStateLine({ ...ready, state: "unavailable" }), "Claude Code 2.1.311 could not be started.");
	assert.equal(claudeLocalUsageLine(ready), null);
	assert.match(claudeLocalUsageLine({ ...ready, usage: { status: "allowed", utilization: 0.42, rateLimitType: "five_hour", isUsingOverage: true, observedAt: 1 } }) ?? "", /42% of the five hour window used; .*the last turn drew on extra usage, not your plan\./);
});

test("the dialog carries the approved disclosure, the three preferences, the path field, Re-check — and no sign-in, token or email", () => {
	const html = renderToStaticMarkup(<ClaudeLocalDialogBody status={ready} busy={false} error={null} web={false} onChange={() => {}} onProbe={() => {}} />);
	const disclosure = CLAUDE_LOCAL_DISCLOSURE.replace(/'/g, "&#x27;"); // as React escapes it
	assert(html.includes(disclosure));
	assert(html.includes("Claude (via your Claude Code install)"));
	for (const testid of ["toggle-use-my-local-claude-code", "toggle-allow-background-use", "claude-local-prompt-mode", "claude-local-binary-path", "claude-local-state", "claude-local-path"]) assert(html.includes(`data-testid="${testid}"`), testid);
	assert(html.includes(">Re-check</button>")); assert(html.includes("/opt/homebrew/bin/claude"));
	// The approved disclosure quotes the terms ("sign in to your own unmodified
	// Claude Code"); everything else must carry no sign-in or credential wording.
	assert(!/Sign in|Log in|Connect<|token|@/i.test(html.replace(disclosure, "").replace(/Claude Code/g, "")), "no sign-in affordance, no credential wording");
	const web = renderToStaticMarkup(<ClaudeLocalDialogBody status={ready} busy={false} error={null} web onChange={() => {}} onProbe={() => {}} />);
	assert(web.includes("Everyone using this server shares its Claude Code login"));
	const failed = renderToStaticMarkup(<ClaudeLocalDialogBody status={{ ...ready, state: "api-key", error: "Claude Code is signed in to a Claude API (Console) account; this route only runs on a Claude plan login." }} busy={false} error={null} web={false} onChange={() => {}} onProbe={() => {}} />);
	assert(failed.includes('data-testid="claude-local-error"')); assert(failed.includes("Console"));
});

test("the row: Set up… while off, Manage… plus the state while on; an error shows under the row", () => {
	assert(renderToStaticMarkup(<ClaudeLocalConnection initialStatus={base} />).includes(">Set up…</button>"));
	const on = renderToStaticMarkup(<ClaudeLocalConnection initialStatus={ready} />);
	assert(on.includes(">Manage…</button>")); assert(on.includes('data-testid="claude-local-row-state"')); assert(on.includes(">ready<"));
	const broken = renderToStaticMarkup(<ClaudeLocalConnection initialStatus={{ ...ready, state: "not-found", binary: null, error: "Claude Code was not found." }} />);
	assert(broken.includes("not found")); assert(broken.includes('role="alert"'));
});

test("the model menu shows the Local Claude label instead of a price", () => {
	const native = piModels().getModel("anthropic", "claude-opus-5-5")!;
	const html = renderToStaticMarkup(<ModelMenuList models={[toModelDto({ ...native, provider: "claude-local" })]} effectiveId={undefined} onPick={() => {}} />);
	assert(html.includes("Local Claude (subscription)")); assert(html.includes(">Local Claude</span>")); assert(!html.includes("USD per 1M")); assert(!html.includes("$"));
});

/** Mounts the card over a mocked fetch that records every request, opens the
 *  dialog, clicks one toggle, and returns the requests that click made. */
async function flip(toggleTestid: string, initial: ClaudeLocalStatus) {
	const requests: string[] = [];
	globalThis.fetch = async (url, init) => {
		const method = init?.method ?? "GET";
		requests.push(`${method} ${String(url)}${method === "POST" ? ` ${String(init?.body)}` : ""}`);
		return method === "PUT" ? Response.json({ ok: true }) : Response.json(initial);
	};
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<ClaudeLocalConnection initialStatus={initial} />));
	const manage = [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent === (initial.enabled ? "Manage…" : "Set up…"));
	assert(manage); await act(async () => manage.click());
	requests.length = 0;
	const toggle = document.querySelector<HTMLElement>(`[data-testid="${toggleTestid}"]`);
	assert(toggle, toggleTestid); await act(async () => toggle.click());
	return requests;
}

test("flipping background use saves and re-reads status with a GET — no forced probe", async () => {
	assert.deepEqual(await flip("toggle-allow-background-use", ready), ["PUT /api/settings/claudeLocal", "GET /api/claude-local"]);
});

test("flipping the opt-in saves and then forces a probe", async () => {
	assert.deepEqual(await flip("toggle-use-my-local-claude-code", ready), ["PUT /api/settings/claudeLocal", 'POST /api/claude-local {"op":"probe"}']);
});

test("review P2: a toggle while the saved override is not found keeps the path (no write clears a path the user did not edit)", async () => {
	const saved = "/Volumes/External/claude/claude";
	const missing: ClaudeLocalStatus = { ...ready, state: "not-found", binary: null, binaryPath: saved, error: `No Claude Code executable at ${saved}.` };
	const puts: unknown[] = [];
	globalThis.fetch = async (_url, init) => {
		if (init?.method === "PUT") { puts.push(JSON.parse(String(init.body))); return Response.json({ ok: true }); }
		return Response.json(missing);
	};
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<ClaudeLocalConnection initialStatus={missing} />));
	const manage = [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent === "Manage…");
	assert(manage); await act(async () => manage.click());
	assert.equal(document.querySelector<HTMLInputElement>('[data-testid="claude-local-binary-path"]')?.value, saved, "the field shows the saved override");
	await act(async () => document.querySelector<HTMLElement>('[data-testid="toggle-allow-background-use"]')!.click());
	assert.deepEqual(puts, [{ enabled: true, allowBackgroundUse: false, systemPromptMode: "custom", binaryPath: saved }]);
});
