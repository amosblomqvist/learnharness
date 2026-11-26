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
	findActiveClaudeProfile,
	formatClaudeProfileAccountMeta,
	formatClaudeSubscriptionPlan,
	normalizeNonEmptyMeta,
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
const profileSummary = () => document.querySelector<HTMLElement>('[data-testid="claude-code-profile-summary"]');

function makeProfilesResponse(
	configuredDir: string | null = null,
	inheritedEnvDir: string | null = null,
	extraProfiles: ClaudeCodeProfilesResponse["profiles"] = [],
	defaultMeta: Pick<ClaudeCodeProfilesResponse["profiles"][number], "email" | "subscriptionPlan"> = {},
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
			...defaultMeta,
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
		defaultMeta?: Pick<ClaudeCodeProfilesResponse["profiles"][number], "email" | "subscriptionPlan">;
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
			return Response.json(
				makeProfilesResponse(
					configDir ?? null,
					opts.inheritedEnvDir ?? null,
					opts.extraProfiles ?? [],
					opts.defaultMeta ?? {},
				),
			);
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

test("profile account metadata helpers format partial/missing fields cleanly and locate active profile", () => {
	assert.equal(normalizeNonEmptyMeta("  alice@example.com\n"), "alice@example.com");
	assert.equal(normalizeNonEmptyMeta("   "), undefined);
	assert.equal(normalizeNonEmptyMeta(null), undefined);
	assert.equal(normalizeNonEmptyMeta(undefined), undefined);

	assert.equal(formatClaudeSubscriptionPlan("pro"), "Pro");
	assert.equal(formatClaudeSubscriptionPlan("Max (20x)"), "Max (20x)");
	assert.equal(formatClaudeSubscriptionPlan("stripe_subscription"), "Subscription");
	assert.equal(formatClaudeSubscriptionPlan("Constructor"), "Constructor");
	assert.equal(formatClaudeSubscriptionPlan("__proto__"), "__proto__");
	assert.equal(formatClaudeSubscriptionPlan("  "), undefined);

	assert.equal(
		formatClaudeProfileAccountMeta({ email: "alice@example.com", subscriptionPlan: "Max (20x)" }),
		"alice@example.com · Max (20x)",
	);
	assert.equal(
		formatClaudeProfileAccountMeta({ email: "a@b.com", subscriptionPlan: "Constructor" }),
		"a@b.com · Constructor",
	);
	assert.equal(formatClaudeProfileAccountMeta({ email: "alice@example.com" }), "alice@example.com");
	assert.equal(formatClaudeProfileAccountMeta({ subscriptionPlan: "pro" }), "Pro");
	assert.equal(formatClaudeProfileAccountMeta({ email: " ", subscriptionPlan: null }), null);
	assert.equal(formatClaudeProfileAccountMeta(undefined), null);

	const profilesWithMeta: ClaudeCodeProfilesResponse["profiles"] = [
		{
			path: "/mock/home/.claude-work",
			displayPath: "~/.claude-work",
			label: ".claude-work",
			source: "discovered",
			exists: true,
			hasSettings: true,
			hasCredentials: true,
			email: "work@example.com",
			subscriptionPlan: "Team",
		},
		{
			path: "/mock/home/.claude-personal",
			displayPath: "~/.claude-personal",
			label: ".claude-personal",
			source: "discovered",
			exists: true,
			hasSettings: true,
			hasCredentials: false,
			email: "personal@example.com",
		},
	];
	const data = makeProfilesResponse(null, null, profilesWithMeta, {
		email: "default@example.com",
		subscriptionPlan: "Pro",
	});
	assert.equal(findActiveClaudeProfile(undefined, data)?.email, "default@example.com");
	assert.equal(findActiveClaudeProfile("/mock/home/.claude-work", data)?.subscriptionPlan, "Team");

	const inheritedData = makeProfilesResponse(null, "/mock/home/.claude-work", profilesWithMeta, {
		email: "default@example.com",
		subscriptionPlan: "Pro",
	});
	assert.equal(findActiveClaudeProfile(undefined, inheritedData)?.email, "work@example.com");

	const entries = claudeProfileMenuEntries("", data);
	assert.equal(entries[0]?.kind, "default");
	assert.equal(entries[0]?.email, "default@example.com");
	assert.equal(entries[0]?.subscriptionPlan, "Pro");

	assert.equal(claudeProfileMenuEntries("work@example.com", data).length, 1);
	assert.equal(claudeProfileMenuEntries("Team", data).length, 1);
	const defaultPlanSearch = claudeProfileMenuEntries("Pro", data);
	assert.equal(defaultPlanSearch.length, 1);
	assert.equal(defaultPlanSearch[0]?.kind, "default");
});

test("profile dropdown and selected summary render email and plan, omit missing fields, and never expose secrets", async () => {
	const profilesWithMeta: ClaudeCodeProfilesResponse["profiles"] = [
		{
			path: "/mock/home/.claude-email-only",
			displayPath: "~/.claude-email-only",
			label: ".claude-email-only",
			source: "discovered",
			exists: true,
			hasSettings: true,
			hasCredentials: false,
			email: "only-email@example.com",
		},
		{
			path: "/mock/home/.claude-plan-only",
			displayPath: "~/.claude-plan-only",
			label: ".claude-plan-only",
			source: "discovered",
			exists: true,
			hasSettings: true,
			hasCredentials: true,
			subscriptionPlan: "Max (20x)",
		},
		{
			path: "/mock/home/.claude-no-meta",
			displayPath: "~/.claude-no-meta",
			label: ".claude-no-meta",
			source: "discovered",
			exists: true,
			hasSettings: false,
			hasCredentials: false,
		},
	];

	fixture(
		async () => Response.json(status("meets-minimum", "2.1.329")),
		true,
		false,
		{
			extraProfiles: profilesWithMeta,
			defaultMeta: { email: "default@example.com", subscriptionPlan: "Pro" },
		},
	);
	await mount(undefined, true);

	// Selected default profile shows summary without changing trigger text
	assert.equal(profileTrigger().textContent?.replace("▾", "").trim(), "Default (.claude)");
	assert.equal(profileSummary()?.textContent, "default@example.com · Pro");

	// Open dropdown and inspect each item's metadata rendering
	await act(async () => profileTrigger().click());
	const defaultMetaEl = document.querySelector('[data-testid="claude-profile-option-default"] [data-testid="claude-profile-account-meta"]');
	const emailOnlyMetaEl = document.querySelector('[data-testid="claude-profile-option-_claude-email-only"] [data-testid="claude-profile-account-meta"]');
	const planOnlyMetaEl = document.querySelector('[data-testid="claude-profile-option-_claude-plan-only"] [data-testid="claude-profile-account-meta"]');
	const noMetaEl = document.querySelector('[data-testid="claude-profile-option-_claude-no-meta"] [data-testid="claude-profile-account-meta"]');

	assert.equal(defaultMetaEl?.textContent, "default@example.com · Pro");
	assert.equal(emailOnlyMetaEl?.textContent, "only-email@example.com");
	assert.equal(planOnlyMetaEl?.textContent, "Max (20x)");
	assert.equal(noMetaEl, null);

	const bodyText = document.body.textContent ?? "";
	assert.equal(bodyText.includes("undefined"), false);
	assert.equal(bodyText.includes("null"), false);

	// Select email-only profile -> summary shows email without dangling separator
	await act(async () => {
		document.querySelector<HTMLButtonElement>('[data-testid="claude-profile-option-_claude-email-only"]')!.click();
	});
	assert.equal(profileTrigger().textContent?.replace("▾", "").trim(), ".claude-email-only");
	assert.equal(profileSummary()?.textContent, "only-email@example.com");

	// Select no-meta profile -> summary element is completely omitted
	await act(async () => profileTrigger().click());
	await act(async () => {
		document.querySelector<HTMLButtonElement>('[data-testid="claude-profile-option-_claude-no-meta"]')!.click();
	});
	assert.equal(profileTrigger().textContent?.replace("▾", "").trim(), ".claude-no-meta");
	assert.equal(profileSummary(), null);
});

test("profile UI ignores unexpected secret fields if present in API response", async () => {
	globalThis.fetch = (async (url) => {
		if (url === "/api/settings") {
			return Response.json({ settings: { version: 1, claudeCode: { enabled: true } } });
		}
		if (url === "/api/claude-code") {
			return Response.json(status("meets-minimum", "2.1.329"));
		}
		if (url === "/api/claude-code/profiles") {
			return Response.json({
				profiles: [
					{
						path: "/mock/home/.claude",
						displayPath: "~/.claude",
						label: "Default (.claude)",
						source: "default",
						exists: true,
						hasSettings: true,
						hasCredentials: true,
						email: "safe@example.com",
						subscriptionPlan: "Pro",
						accessToken: "UI_SECRET_ACCESS_TOKEN",
						refreshToken: "UI_SECRET_REFRESH_TOKEN",
						apiKey: "UI_SECRET_API_KEY",
						primaryApiKey: "UI_SECRET_PRIMARY_KEY",
						token: "UI_SECRET_TOKEN",
					},
				],
				configuredDir: null,
				inheritedEnvDir: null,
				effectiveDir: null,
				defaultDir: "/mock/home/.claude",
			});
		}
		return Response.json({ models: [] });
	}) as typeof fetch;

	await mount(undefined, true);
	assert.equal(profileSummary()?.textContent, "safe@example.com · Pro");
	await act(async () => profileTrigger().click());

	const html = document.body.innerHTML;
	const text = document.body.textContent ?? "";
	for (const secret of [
		"UI_SECRET_ACCESS_TOKEN",
		"UI_SECRET_REFRESH_TOKEN",
		"UI_SECRET_API_KEY",
		"UI_SECRET_PRIMARY_KEY",
		"UI_SECRET_TOKEN",
	]) {
		assert.equal(html.includes(secret), false, `DOM HTML must not contain ${secret}`);
		assert.equal(text.includes(secret), false, `DOM text must not contain ${secret}`);
	}
});

test("findActiveClaudeProfile ignores stale data.configuredDir and expands ~ via data.defaultDir", () => {
	const data: ClaudeCodeProfilesResponse = {
		profiles: [
			{
				path: "/mock/home/.claude",
				displayPath: "~/.claude",
				label: "Default (.claude)",
				source: "default",
				exists: true,
				hasSettings: true,
				hasCredentials: true,
			},
			{
				path: "/mock/home/.claude-work",
				displayPath: "~/.claude-work",
				label: ".claude-work",
				source: "configured",
				exists: true,
				hasSettings: true,
				hasCredentials: true,
				email: "alice@work.com",
				subscriptionPlan: "Pro",
			},
			{
				path: "/mock/home/.claude-second",
				displayPath: "~/.claude-second",
				label: ".claude-second",
				source: "discovered",
				exists: true,
				hasSettings: true,
				hasCredentials: true,
				email: "bob@second.com",
				subscriptionPlan: "Max (20x)",
			},
		],
		configuredDir: "/mock/home/.claude-work",
		inheritedEnvDir: null,
		effectiveDir: "/mock/home/.claude-work",
		defaultDir: "/mock/home/.claude",
	};

	const second = findActiveClaudeProfile("/mock/home/.claude-second", data);
	assert.equal(second?.path, "/mock/home/.claude-second");
	assert.equal(second?.email, "bob@second.com");
	assert.equal(second?.subscriptionPlan, "Max (20x)");

	assert.equal(findActiveClaudeProfile("~/brand-new", data), undefined);
	assert.equal(claudeProfileTriggerLabel("~/brand-new", data), "brand-new");
	assert.equal(findActiveClaudeProfile("~/.claude-second", data)?.path, "/mock/home/.claude-second");

	// Deterministic ~ expansion against data.defaultDir even when displayPath is absolute
	const dataWithoutTildeDisplay: ClaudeCodeProfilesResponse = {
		...data,
		profiles: data.profiles.map((profile) => ({ ...profile, displayPath: profile.path })),
	};
	assert.equal(
		findActiveClaudeProfile("~/.claude-second", dataWithoutTildeDisplay)?.path,
		"/mock/home/.claude-second",
	);
});

for (const mode of ["http-500", "pending"] as const) {
	test(`switching profiles while /api/claude-code/profiles is ${mode} immediately updates trigger, summary, and checkmark`, async () => {
		let configDir = "/mock/home/.claude-work";
		let profileFetchCount = 0;
		const staleProfilesPayload: ClaudeCodeProfilesResponse = {
			profiles: [
				{
					path: "/mock/home/.claude",
					displayPath: "~/.claude",
					label: "Default (.claude)",
					source: "default",
					exists: true,
					hasSettings: true,
					hasCredentials: true,
				},
				{
					path: "/mock/home/.claude-work",
					displayPath: "~/.claude-work",
					label: ".claude-work",
					source: "configured",
					exists: true,
					hasSettings: true,
					hasCredentials: true,
					email: "alice@work.com",
					subscriptionPlan: "Pro",
				},
				{
					path: "/mock/home/.claude-second",
					displayPath: "~/.claude-second",
					label: ".claude-second",
					source: "discovered",
					exists: true,
					hasSettings: true,
					hasCredentials: true,
					email: "bob@second.com",
					subscriptionPlan: "Max (20x)",
				},
			],
			configuredDir: "/mock/home/.claude-work",
			inheritedEnvDir: null,
			effectiveDir: "/mock/home/.claude-work",
			defaultDir: "/mock/home/.claude",
		};

		globalThis.fetch = (async (url, init) => {
			if (url === "/api/settings") {
				return Response.json({ settings: { version: 1, claudeCode: { enabled: true, configDir } } });
			}
			if (url === "/api/settings/claudeCode") {
				const body = JSON.parse(String(init?.body)) as { configDir?: string | null };
				if (typeof body.configDir === "string") configDir = body.configDir;
				return Response.json({ settings: { version: 1, claudeCode: { enabled: true, configDir } } });
			}
			if (url === "/api/claude-code/profiles") {
				profileFetchCount += 1;
				if (profileFetchCount === 1) {
					return Response.json(staleProfilesPayload);
				}
				if (mode === "http-500") {
					return new Response(null, { status: 500 });
				}
				return new Promise<Response>(() => {});
			}
			if (url === "/api/models") return Response.json({ models: [{ provider: "claude-code", id: "sonnet" }] });
			return Response.json(status("meets-minimum", "2.1.329"));
		}) as typeof fetch;

		await mount(undefined, true);
		assert.equal(profileTrigger().textContent?.replace("▾", "").trim(), ".claude-work");
		assert.equal(profileSummary()?.textContent, "alice@work.com · Pro");

		// Open menu and switch to .claude-second; refresh fails (500) or stays pending
		await act(async () => profileTrigger().click());
		await act(async () => {
			document.querySelector<HTMLButtonElement>('[data-testid="claude-profile-option-_claude-second"]')!.click();
		});

		assert.equal(profileTrigger().textContent?.replace("▾", "").trim(), ".claude-second");
		assert.equal(profileSummary()?.textContent, "bob@second.com · Max (20x)");

		// Re-open menu while profilesData still has stale configuredDir: checkmark must be on .claude-second
		await act(async () => profileTrigger().click());
		const secondOption = document.querySelector('[data-testid="claude-profile-option-_claude-second"]');
		const workOption = document.querySelector('[data-testid="claude-profile-option-_claude-work"]');
		assert(secondOption?.textContent?.includes("✓"));
		assert(!workOption?.textContent?.includes("✓"));
	});
}
