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
import {
	conversationModelProvider,
	hasProviderKey,
	modelAccessBlock,
	providerKeyless,
	strongKeyless,
	subscriptionCtaLabel,
	ZeroKeysPill,
} from "../components/setup-cta.tsx";
import { SUBSCRIPTION_PROVIDER, type ModelCatalogResponse } from "../src/core/index.ts";
import { SetupKeysBody, setupStage } from "../components/setup-dialog.tsx";
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
		assert.match(html, /Add a provider key\./);
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

describe("modelAccessBlock — independent authorization sources, no fallback", () => {
	const base = {
		subscriptionSelected: true,
		subscriptionState: "connected" as const,
		subscriptionFailed: false,
		zeroKeys: true,
		selectedKeyless: true,
	};

	it("a connected subscription with zero API keys is not blocked", () => {
		assert.equal(modelAccessBlock(base), null);
	});

	it("a selected subscription that is not connected guides to Subscription, not Keys", () => {
		for (const state of ["disconnected", "reconnect_required", "error", "authorizing"] as const) {
			assert.equal(
				modelAccessBlock({ ...base, subscriptionState: state }),
				"subscription",
				state,
			);
		}
	});

	it("pending first read blocks creation with its own state, never a zero-key claim", () => {
		assert.equal(
			modelAccessBlock({ ...base, subscriptionState: null, subscriptionFailed: false }),
			"subscription_pending",
		);
		// A failed read is also not "zero keys"; it is Subscription guidance.
		assert.equal(
			modelAccessBlock({ ...base, subscriptionState: null, subscriptionFailed: true }),
			"subscription",
		);
	});

	it("an ordinary API pin keeps the existing zero-keys / selected-keyless guard", () => {
		assert.equal(
			modelAccessBlock({ ...base, subscriptionSelected: false, subscriptionState: null }),
			"keys",
		);
		assert.equal(
			modelAccessBlock({
				...base,
				subscriptionSelected: false,
				subscriptionState: null,
				zeroKeys: false,
				selectedKeyless: false,
			}),
			null,
		);
	});
});

describe("conversationModelProvider — the turn's actual provider source", () => {
	it("a per-chat override wins over the strong pin and carries its own authorization", () => {
		const c = catalog("openrouter", "openrouter");
		const provider = conversationModelProvider(
			{ model: { provider: SUBSCRIPTION_PROVIDER, id: "gpt-5-codex" } },
			c,
		);
		assert.equal(provider, SUBSCRIPTION_PROVIDER);
		assert.equal(providerKeyless(c, provider), true);
		assert.equal(
			modelAccessBlock({
				subscriptionSelected: provider === SUBSCRIPTION_PROVIDER,
				subscriptionState: "disconnected",
				subscriptionFailed: false,
				zeroKeys: false,
				selectedKeyless: true,
			}),
			"subscription",
		);
	});

	it("no override rides the strong slot (server resolveConversationSpec parity)", () => {
		const c = catalog("openrouter", "openrouter");
		assert.equal(conversationModelProvider(undefined, c), "openrouter");
		assert.equal(conversationModelProvider({}, c), "openrouter");
		assert.equal(conversationModelProvider(undefined, undefined), null);
	});
});

describe("subscriptionCtaLabel — the guidance copy", () => {
	it("names the subscription action, never a provider key", () => {
		assert.equal(subscriptionCtaLabel("connected"), "Subscription connected");
		assert.equal(subscriptionCtaLabel("authorizing"), "Finish subscription sign-in");
		assert.equal(subscriptionCtaLabel("disconnected"), "Connect subscription");
		assert.equal(subscriptionCtaLabel("reconnect_required"), "Reconnect subscription");
		assert.equal(subscriptionCtaLabel("error"), "Check subscription");
		assert.equal(subscriptionCtaLabel(null, true), "Check subscription");
		assert.equal(subscriptionCtaLabel(null, false, true), "Checking subscription…");
		for (const label of [
			subscriptionCtaLabel("disconnected"),
			subscriptionCtaLabel("reconnect_required"),
			subscriptionCtaLabel("error"),
		]) {
			assert.doesNotMatch(label, /provider key/i);
		}
	});
});

describe("setupStage — subscription authorization opens the pickers", () => {
	it("a connected subscription replaces the first-key prerequisite", () => {
		assert.equal(setupStage([{ id: "openai-codex", keyPresent: false }], true), "pickers");
		assert.equal(setupStage(null, true), "pickers", "a connected subscription must not wait on the keys read");
	});

	it("fresh zero-key / no-subscription keeps the first-key screen", () => {
		assert.equal(setupStage([{ id: "openai-codex", keyPresent: false }], false), "keys");
		assert.equal(setupStage([], false), "keys");
	});

	it("an unconnected pending catalog read still falls back to the honest key screen", () => {
		assert.equal(setupStage(null, false), "keys");
	});
});
