import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { InteractionLayersProvider, useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";
import { ClaudeCodeInstallationStatus, claudeCodeStatusLabel } from "../components/settings/claude-code-status.tsx";
import {
	claudeProfileCustomCandidate,
	claudeProfileHint,
	claudeProfileMenuEntries,
	claudeProfileTriggerLabel,
} from "../components/settings/claude-profile-menu.tsx";
import { ConnectionRow } from "../components/settings/connection-controls.tsx";
import { useModelCatalog } from "../components/model-catalog.ts";
import type { ClaudeCodeProfilesResponse, ClaudeCodeStatus } from "../src/core/contracts/claude-code.ts";

const dom = parseHTML("<html><body></body></html>");
let activeElement: Element = dom.document.body;
Object.defineProperty(dom.document, "activeElement", { get: () => activeElement, configurable: true });
Object.assign(dom.document, { oninput: null });
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 900 });
dom.window.HTMLElement.prototype.focus = function () { activeElement = this; };
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
	top: 200, bottom: 230, left: 400, right: 500, width: 100, height: 30, x: 400, y: 200, toJSON() {},
});
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent,
	Event: dom.window.Event,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	IS_REACT_ACT_ENVIRONMENT: true,
});
// Import react-dom/client after document.oninput is defined so React uses native
// input events instead of its legacy polyfill in linkedom.
const { createRoot } = await import("react-dom/client");
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
let interactionController: InteractionLayersController | undefined;
let lastPutBodies: Array<Record<string, unknown>> = [];
function CaptureLayers({ children }: { children: React.ReactNode }) {
	interactionController = useInteractionLayers();
	return <>{children}</>;
}
const status = (state: ClaudeCodeStatus["state"], version: string | null = null): ClaudeCodeStatus => ({ state, version, minimumVersion: "2.1.259" });
const button = () => document.querySelector<HTMLButtonElement>('[data-testid="claude-code-check-again"]')!;
const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]')!;
const label = () => document.querySelector('[role="status"]')?.textContent;
const profileTrigger = () => document.querySelector<HTMLButtonElement>('[data-testid="claude-code-profile-trigger"]')!;
const profileMenu = () => document.querySelector<HTMLElement>('[data-testid="claude-code-profile-menu"]');
const profileSearch = () => document.querySelector<HTMLInputElement>('[data-testid="claude-profile-search"]');

function makeProfilesResponse(
	configuredDir: string | null = null,
	inheritedEnvDir: string | null = null,
	extraProfiles: ClaudeCodeProfilesResponse["profiles"] = [],
): ClaudeCodeProfilesResponse {
	const profiles: ClaudeCodeProfilesResponse["profiles"] = [
		{
			path: "/mock/home/.claude",
			displayPath: "~/.claude",
			label: "Default (.claude)",
			source: "default",
			exists: true,
			hasSettings: true,
			hasCredentials: true,
		},
		...extraProfiles,
	];
	if (configuredDir && !profiles.some((p) => p.path === configuredDir || p.displayPath === configuredDir)) {
		profiles.push({
			path: configuredDir.startsWith("~/") ? `/mock/home/${configuredDir.slice(2)}` : configuredDir,
			displayPath: configuredDir,
			label: configuredDir.split("/").filter(Boolean).pop() ?? configuredDir,
			source: "configured",
			exists: true,
			hasSettings: false,
			hasCredentials: false,
		});
	}
	return {
		profiles,
		configuredDir: configuredDir?.startsWith("~/") ? `/mock/home/${configuredDir.slice(2)}` : configuredDir,
		inheritedEnvDir,
		effectiveDir: (configuredDir?.startsWith("~/") ? `/mock/home/${configuredDir.slice(2)}` : configuredDir) ?? inheritedEnvDir,
		defaultDir: "/mock/home/.claude",
	};
}

const sampleDiscovered: ClaudeCodeProfilesResponse["profiles"] = [
	{
		path: "/mock/home/.claude-second",
		displayPath: "~/.claude-second",
		label: ".claude-second",
		source: "discovered",
		exists: true,
		hasSettings: true,
		hasCredentials: true,
	},
	{
		path: "/mock/home/.claude-work",
		displayPath: "~/.claude-work",
		label: ".claude-work",
		source: "discovered",
		exists: true,
		hasSettings: false,
		hasCredentials: true,
	},
];

function fixture(
	probe: (init?: RequestInit) => Promise<Response>,
	enabled = true,
	failSave: boolean | string = false,
	opts: {
		initialConfigDir?: string;
		inheritedEnvDir?: string | null;
		extraProfiles?: ClaudeCodeProfilesResponse["profiles"];
	} = {},
) {
	const calls: string[] = [];
	lastPutBodies = [];
	let on = enabled;
	let configDir: string | undefined = opts.initialConfigDir;
	globalThis.fetch = (async (url, init) => {
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url === "/api/settings") {
			return Response.json({
				settings: { version: 1, claudeCode: configDir ? { enabled: on, configDir } : { enabled: on } },
			});
		}
		if (url === "/api/settings/claudeCode") {
			assert.equal(init?.method, "PUT"); assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
			if (failSave) {
				return typeof failSave === "string"
					? Response.json({ error: failSave }, { status: 400 })
					: new Response(null, { status: 500 });
			}
			const body = JSON.parse(String(init.body)) as { enabled?: boolean; configDir?: string | null };
			lastPutBodies.push(body);
			on = body.enabled === true;
			configDir = typeof body.configDir === "string" && body.configDir.trim() ? body.configDir.trim() : undefined;
			return Response.json({
				settings: { version: 1, claudeCode: configDir ? { enabled: on, configDir } : { enabled: on } },
			});
		}
		if (url === "/api/claude-code/profiles") {
			assert.equal(init?.cache, "no-store");
			assert.equal(new Headers(init?.headers).get("x-learnharness-claude-code"), "1");
			return Response.json(makeProfilesResponse(configDir ?? null, opts.inheritedEnvDir ?? null, opts.extraProfiles ?? []));
		}
		if (url === "/api/models") return Response.json({ models: on ? [{ provider: "claude-code", id: "sonnet" }] : [] });
		assert.equal(url, "/api/claude-code");
		assert.equal(init?.cache, "no-store");
		assert.equal(new Headers(init?.headers).get("x-learnharness-claude-code"), "1");
		return probe(init);
	}) as typeof fetch;
	return calls;
}

async function mount(extra?: React.ReactNode, withLayers = false) {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	const tree = <><ClaudeCodeInstallationStatus />{extra}</>;
	await act(async () => root!.render(
		withLayers
			? <InteractionLayersProvider><CaptureLayers>{tree}</CaptureLayers></InteractionLayersProvider>
			: tree,
	));
}

function setInputValue(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

function dispatchKey(target: EventTarget, key: string) {
	const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key });
	interactionController?.captureKeyDown(event as unknown as KeyboardEvent);
	target.dispatchEvent(event);
}

afterEach(async () => {
	await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined;
	interactionController = undefined;
	activeElement = dom.document.body;
	globalThis.fetch = originalFetch;
});

test("initial render is collapsed and off, with no setup prose or version probe action", () => {
	const html = renderToStaticMarkup(<ClaudeCodeInstallationStatus />);
	assert.match(html, /Claude Code/); assert.match(html, /aria-checked="false"/);
	assert.equal((html.match(/<button/g) ?? []).length, 1);
	assert(!html.includes("Check again")); assert(!html.includes("Authenticate")); assert(!html.includes("Setup ↗"));
	assert(!html.includes("claude-code-profile-trigger"));
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

// --- Searchable Claude Code Profile Selector (pure + interactive UI tests) ---

test("profile menu pure helpers: default deduplication, fuzzy search, inherited env, custom path, and missing-dir hint", () => {
	const data = makeProfilesResponse(null, null, sampleDiscovered);
	const all = claudeProfileMenuEntries("", data);
	assert.equal(all.length, 3);
	assert.equal(all[0]?.kind, "default");
	assert.deepEqual(
		all.slice(1).map((e) => (e.kind === "profile" ? e.profile.label : "")),
		[".claude-second", ".claude-work"],
	);

	const filtered = claudeProfileMenuEntries("second", data);
	assert.equal(filtered.length, 1);
	assert.equal(filtered[0]?.kind, "profile");
	assert.equal(filtered[0]?.profile.label, ".claude-second");

	// Custom path action appears for valid paths not already listed, never for relative/invalid strings
	assert.equal(claudeProfileCustomCandidate("relative/dir", data), null);
	assert.equal(claudeProfileCustomCandidate("~/.claude-second", data), null);
	assert.equal(claudeProfileCustomCandidate("~/custom-claude", data), "~/custom-claude");
	const withCustom = claudeProfileMenuEntries("/opt/claude-lab", data);
	assert.equal(withCustom.length, 1);
	assert.deepEqual(withCustom[0], { kind: "custom", value: "/opt/claude-lab" });

	// When inherited CLAUDE_CONFIG_DIR is set, Default (inherited) appears AND explicit ~/.claude stays selectable
	const inheritedData = makeProfilesResponse(null, "/mock/home/.claude-second", sampleDiscovered);
	const inheritedEntries = claudeProfileMenuEntries("", inheritedData);
	assert.equal(inheritedEntries[0]?.kind, "default");
	assert.equal(inheritedEntries[0]?.inherited, true);
	assert(inheritedEntries.some((e) => e.kind === "profile" && e.profile.source === "default"));
	assert.equal(claudeProfileTriggerLabel(undefined, inheritedData), "Default (inherited)");
	assert.match(claudeProfileHint(undefined, inheritedData).text, /Inherited CLAUDE_CONFIG_DIR: ~\/\.claude-second/);

	// Missing configured directory displays warning hint
	const missingData: ClaudeCodeProfilesResponse = {
		profiles: [
			{
				path: "/mock/home/.claude-gone",
				displayPath: "~/.claude-gone",
				label: ".claude-gone",
				source: "configured",
				exists: false,
				hasSettings: false,
				hasCredentials: false,
			},
		],
		configuredDir: "/mock/home/.claude-gone",
		inheritedEnvDir: null,
		effectiveDir: "/mock/home/.claude-gone",
		defaultDir: "/mock/home/.claude",
	};
	const hint = claudeProfileHint("/mock/home/.claude-gone", missingData);
	assert.equal(hint.warning, true);
	assert.match(hint.text, /directory not found/);
});

test("searchable profile selector filters discovered profiles, persists selection, resets to default, and preserves configDir across toggle", async () => {
	fixture(
		async () => Response.json(status("meets-minimum", "2.1.329")),
		true,
		false,
		{ extraProfiles: sampleDiscovered },
	);
	await mount(undefined, true);

	assert.equal(profileTrigger().textContent?.replace("▾", "").trim(), "Default (.claude)");
	assert(!profileMenu());

	// Open menu and verify discovered profiles render
	await act(async () => profileTrigger().click());
	assert(profileMenu());
	assert(document.querySelector('[data-testid="claude-profile-option-default"]'));
	assert(document.querySelector('[data-testid="claude-profile-option-_claude-second"]'));
	assert(document.querySelector('[data-testid="claude-profile-option-_claude-work"]'));

	// Filter via search input
	await act(async () => setInputValue(profileSearch()!, "second"));
	assert(!document.querySelector('[data-testid="claude-profile-option-default"]'));
	assert(document.querySelector('[data-testid="claude-profile-option-_claude-second"]'));
	assert(!document.querySelector('[data-testid="claude-profile-option-_claude-work"]'));

	// Select filtered profile
	await act(async () => {
		document.querySelector<HTMLButtonElement>('[data-testid="claude-profile-option-_claude-second"]')!.click();
	});
	assert(!profileMenu());
	assert.deepEqual(lastPutBodies.at(-1), { enabled: true, configDir: "/mock/home/.claude-second" });
	assert.equal(profileTrigger().textContent?.replace("▾", "").trim(), ".claude-second");

	// Toggling Claude Code off and back on preserves configDir (replace-whole PUT contract)
	await act(async () => toggle().click());
	assert.deepEqual(lastPutBodies.at(-1), { enabled: false, configDir: "/mock/home/.claude-second" });
	await act(async () => toggle().click());
	assert.deepEqual(lastPutBodies.at(-1), { enabled: true, configDir: "/mock/home/.claude-second" });
	assert.equal(profileTrigger().textContent?.replace("▾", "").trim(), ".claude-second");

	// Reset back to Default
	await act(async () => profileTrigger().click());
	await act(async () => {
		document.querySelector<HTMLButtonElement>('[data-testid="claude-profile-option-default"]')!.click();
	});
	assert.deepEqual(lastPutBodies.at(-1), { enabled: true, configDir: null });
	assert.equal(profileTrigger().textContent?.replace("▾", "").trim(), "Default (.claude)");
});

test("searchable profile selector supports custom CLAUDE_CONFIG_DIR entry and rejects invalid search text cleanly", async () => {
	fixture(
		async () => Response.json(status("meets-minimum", "2.1.329")),
		true,
		false,
		{ extraProfiles: sampleDiscovered },
	);
	await mount(undefined, true);
	await act(async () => profileTrigger().click());

	// Invalid relative query shows guidance and offers no custom option
	await act(async () => setInputValue(profileSearch()!, "not-a-valid-path"));
	assert(!document.querySelector('[data-testid="claude-profile-option-custom"]'));
	assert.match(document.querySelector('[data-testid="claude-profile-empty"]')?.textContent ?? "", /absolute path or ~\//);

	// Valid custom path offers custom option and commits on click
	await act(async () => setInputValue(profileSearch()!, "~/custom-claude"));
	const customBtn = document.querySelector<HTMLButtonElement>('[data-testid="claude-profile-option-custom"]');
	assert(customBtn);
	assert.match(customBtn.textContent ?? "", /Use “~\/custom-claude”/);
	await act(async () => customBtn.click());
	assert(!profileMenu());
	assert.deepEqual(lastPutBodies.at(-1), { enabled: true, configDir: "~/custom-claude" });
	assert.equal(profileTrigger().textContent?.replace("▾", "").trim(), "custom-claude");
});

test("Escape closes profile menu; server 400 error surfaces alert and preserves previous selection", async () => {
	fixture(
		async () => Response.json(status("meets-minimum", "2.1.329")),
		true,
		"configDir must be an absolute path on the server filesystem (or start with ~/)",
		{ initialConfigDir: "/mock/home/.claude-second", extraProfiles: sampleDiscovered },
	);
	await mount(undefined, true);
	assert.equal(profileTrigger().textContent?.replace("▾", "").trim(), ".claude-second");

	// Open and press Escape -> closes menu and restores focus to trigger
	await act(async () => profileTrigger().click());
	assert(profileMenu());
	await act(async () => dispatchKey(profileSearch() ?? document, "Escape"));
	assert(!profileMenu());
	assert.equal(document.activeElement, profileTrigger());

	// Open and try saving -> server 400 surfaces message and keeps previous selection
	await act(async () => profileTrigger().click());
	await act(async () => setInputValue(profileSearch()!, "~/bad-on-server"));
	await act(async () => {
		document.querySelector<HTMLButtonElement>('[data-testid="claude-profile-option-custom"]')!.click();
	});
	assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /absolute path on the server filesystem/);
	assert.equal(profileTrigger().textContent?.replace("▾", "").trim(), ".claude-second");
});
