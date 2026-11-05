/**
 * The zero-keys wave's pure seams (owner-locked over Platform's 66dbea9
 * key-presence gate, 2026-09-25): the provider-key truth (hasProviderKey
 * — tool keys don't count, they unlock no models), the pill's SSR shape,
 * and the SetupDialog's self-contained first-key screen (the dialog STAYS
 * MOUNTED after a save; these pins hold the screen's structure).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hasProviderKey, strongKeyless, ZeroKeysPill } from "../components/setup-cta.tsx";
import type { ModelCatalogResponse } from "../src/core/index.ts";
import { SetupKeysBody } from "../components/setup-dialog.tsx";
import { DICTATION_KEYLESS, DEEPGRAM_KEY_ID } from "../components/dictation.tsx";
import type { AuthKeyStatus } from "../src/core/auth-keys.ts";
import type { ProviderKeyInfo } from "../components/settings/keys-section.tsx";

const status = (id: string, present: boolean, source: AuthKeyStatus["source"] = present ? "file" : "none"): AuthKeyStatus => ({
	id,
	info: null,
	present,
	masked: present ? "…ab12 (64 chars)" : null,
	source,
	shadowedByEnv: false,
});

const PROVIDERS: ProviderKeyInfo[] = [
	{ id: "openrouter", envVar: "OPENROUTER_API_KEY", label: "OpenRouter" },
	{ id: "anthropic", envVar: "ANTHROPIC_API_KEY", label: "Anthropic" },
];

describe("hasProviderKey — the zero-keys pill's truth", () => {
	it("a present provider key (env or file) is a key", () => {
		assert.equal(hasProviderKey([status("OPENROUTER_API_KEY", true, "env")], PROVIDERS), true);
		assert.equal(hasProviderKey([status("ANTHROPIC_API_KEY", true, "file")], PROVIDERS), true);
	});

	it("a TOOL key alone does not count — Deepgram unlocks no models", () => {
		// Deepgram is not in the providers roster: it must never suppress the pill.
		assert.equal(hasProviderKey([status("DEEPGRAM_API_KEY", true)], PROVIDERS), false);
	});

	it("absent provider keys = zero keys (the pill shows)", () => {
		assert.equal(hasProviderKey([status("OPENROUTER_API_KEY", false)], PROVIDERS), false);
		assert.equal(hasProviderKey([], PROVIDERS), false);
	});
});

describe("ZeroKeysPill — the composer-hoisted notice", () => {
	it("the pill takes the CTA's chrome with its own testid and copy", () => {
		const html = renderToStaticMarkup(createElement(ZeroKeysPill, { onOpen: () => {} }));
		assert.ok(html.includes('data-testid="setup-cta-keys"'));
		assert.match(html, />Add a provider key<\/button>/);
		assert.doesNotMatch(html, /chats start|—/);
		// the models CTA's testid must not appear on the keys pill
		assert.ok(!html.includes('data-testid="setup-cta"'));
	});
});

describe("SetupKeysBody — stage 1's self-contained first-key screen", () => {
	const base = {
		value: "",
		saving: false,
		error: null,
		menuOpen: false,
		onToggleMenu: () => {},
		onPick: () => {},
		onValue: () => {},
		onSave: () => {},
		menuAnchor: { current: null },
	};

	it("before a pick: the provider trigger, no key input yet", () => {
		const html = renderToStaticMarkup(
			createElement(SetupKeysBody, { ...base, providers: PROVIDERS, provider: null }),
		);
		assert.ok(html.indexOf('data-testid="setup-key-provider"') < html.indexOf('data-testid="chatgpt-login"'), "API keys remain primary, ChatGPT is secondary");
		assert.doesNotMatch(html, /chatgpt-privacy-notice|OpenAI privacy|Manage usage/);
		assert.ok(html.includes("Choose your AI provider and paste its API key. You’ll pick your models next."));
		assert.doesNotMatch(html, /First, add|keys unlock|—/);
		assert.ok(html.includes('data-testid="setup-key-provider"'));
		assert.ok(html.includes("Pick a provider…"));
		assert.ok(!html.includes('data-testid="setup-key-input"'), "no paste field before a provider is picked");
	});

	it("after a pick: the paste input + Save join", () => {
		const html = renderToStaticMarkup(
			createElement(SetupKeysBody, { ...base, providers: PROVIDERS, provider: PROVIDERS[0]! }),
		);
		assert.ok(html.includes('data-testid="setup-key-input"'));
		assert.ok(html.includes('data-testid="setup-key-save"'));
		assert.ok(html.includes("Save key"));
		assert.ok(html.includes("OpenRouter"), "the chosen provider's label rides the trigger");
	});

	it("a shape-gate 400 keeps its line inline — no Settings round-trip chrome", () => {
		const html = renderToStaticMarkup(
			createElement(SetupKeysBody, {
				...base,
				providers: PROVIDERS,
				provider: PROVIDERS[0]!!,
				error: "Expected 20+ characters",
			}),
		);
		assert.ok(html.includes('data-testid="setup-key-error"'));
		assert.ok(html.includes("Expected 20+ characters"));
		// the old "Open Keys settings" round-trip died with the self-contained screen
		assert.ok(!html.includes("setup-open-keys"));
	});
});

describe("the dictation keyless seam (owner dictation trio)", () => {
	it("the client-authored short line — not the route's dev-speak", () => {
		assert.equal(DICTATION_KEYLESS, "Dictation needs a Deepgram key");
	});

	it("the Deepgram row id matches the keys store (KeysSection openRow)", () => {
		assert.equal(DEEPGRAM_KEY_ID, "DEEPGRAM_API_KEY");
	});
});
/** A minimal catalog double — only the two halves the strong-keyless guard
 *  reads: the strong pin and the present-key providers list. */
const catalog = (strongProvider: string | null, ...keyedProviders: string[]): ModelCatalogResponse => ({
	models: [],
	defaults: null,
	rolePins: {
		researcher: null,
		demoBuilder: null,
		visualMaker: null,
		extractor: null,
		auditor: null,
	},
	slots: {
		strong: strongProvider
			? { model: { provider: strongProvider, id: `${strongProvider}/model` }, thinkingLevel: "low" }
			: null,
		cheap: null,
		vision: null,
	},
	providers: keyedProviders.map((id) => ({ id, envVar: `${id.toUpperCase()}_API_KEY`, keyPresent: true })),
});

describe("strongKeyless — the pre-send guard's truth (owner interlude, no-orphan-chats)", () => {
	it("strong pinned to a provider whose key is gone: the guard FIRES", () => {
		// keys exist generally (anthropic), but the strong slot pins openrouter
		assert.equal(strongKeyless(catalog("openrouter", "anthropic")), true);
		// no keys at all with a strong pin: also keyless (guard case 1 fires too)
		assert.equal(strongKeyless(catalog("openrouter")), true);
	});

	it("strong provider's key present: the guard does NOT fire — the normal send path stays open", () => {
		assert.equal(strongKeyless(catalog("openrouter", "openrouter", "anthropic")), false);
		// belt check: a provider row never counts when keyPresent is false
		const lying = catalog("openrouter", "openrouter", "anthropic");
		lying.providers[0]!.keyPresent = false;
		assert.equal(strongKeyless(lying), true);
	});

	it("no strong pin (the models guard owns that case) or catalog not loaded: false — the server gate remains the belt", () => {
		assert.equal(strongKeyless(catalog(null, "openrouter")), false);
		assert.equal(strongKeyless(undefined), false);
	});
});
