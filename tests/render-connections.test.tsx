import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	ConnectionsSection,
	CustomProviderEditor,
	buildCustomRequest,
	draftFromStatus,
	emptyCustomDraft,
	namespaceCustomId,
} from "../components/settings/connections-section.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { ChatGPTConnection, ChatGPTUIProvider } from "../components/settings/chatgpt-connection.tsx";
import { NativeSubscriptionUIProvider, SubscriptionConnections } from "../components/settings/subscription-connections.tsx";
import { CLAUDE_POLICY_NOTICE, LegacySubscriptionConnection, LegacySubscriptionsUIProvider } from "../components/settings/legacy-subscription-connections.tsx";
import { SetupKeysBody } from "../components/setup-dialog.tsx";
import { hasAvailableProvider, hasProviderKey } from "../components/setup-cta.tsx";

const noop = () => {};

function validDraft() {
	const d = emptyCustomDraft();
	d.id = "local";
	d.name = "Local";
	d.baseUrl = "http://localhost:1234/v1";
	d.keyless = true;
	d.models = [{ ...d.models[0]!, id: "m1", contextWindow: "8000", maxTokens: "1000" }];
	return d;
}

describe("connections pure helpers", () => {
	it("namespaces ids", () => {
		assert.equal(namespaceCustomId("My Proxy"), "custom-my-proxy");
		assert.equal(namespaceCustomId("custom-x"), "custom-x");
		assert.equal(namespaceCustomId("  "), "");
	});
	it("builds a keyless request without apiKey", () => {
		const r = buildCustomRequest(validDraft(), false);
		assert.ok(r.ok);
		if (r.ok) {
			assert.equal(r.body.provider.id, "custom-local");
			assert.equal(r.body.apiKey, undefined);
			assert.equal(r.body.provider.models[0]!.cost, undefined);
		}
	});
	it("requires a key unless keyless or stored", () => {
		const d = validDraft();
		d.keyless = false;
		assert.equal(buildCustomRequest(d, false).ok, false);
		assert.equal(buildCustomRequest(d, true).ok, true);
		d.apiKey = " k ";
		const r = buildCustomRequest(d, false);
		assert.ok(r.ok && r.body.apiKey === "k");
	});
	it("validates models and costs", () => {
		const d = validDraft();
		d.models[0]!.contextWindow = "abc";
		assert.equal(buildCustomRequest(d, false).ok, false);
		const e = validDraft();
		e.models[0]!.costInput = "-1";
		assert.equal(buildCustomRequest(e, false).ok, false);
		const f = validDraft();
		f.models.push({ ...f.models[0]! });
		assert.equal(buildCustomRequest(f, false).ok, false);
		const g = validDraft();
		g.baseUrl = "ftp://x";
		assert.equal(buildCustomRequest(g, false).ok, false);
	});
	it("round-trips a status into a draft", () => {
		const d = draftFromStatus({
			id: "custom-a",
			name: "A",
			baseUrl: "https://a/v1",
			api: "anthropic-messages",
			keyless: false,
			keyPresent: true,
			models: [
				{ id: "m", name: "M", contextWindow: 10, maxTokens: 5, input: ["text", "image"], reasoning: true, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
			],
		});
		assert.equal(d.apiKey, "");
		assert.equal(d.models[0]!.image, true);
		const r = buildCustomRequest(d, true);
		assert.ok(r.ok && r.body.provider.models[0]!.cost?.output === 2);
	});
	it("availability helper; hasProviderKey unchanged", () => {
		assert.equal(hasAvailableProvider([{ keyPresent: false }, { keyPresent: true }]), true);
		assert.equal(hasAvailableProvider([]), false);
		assert.equal(hasProviderKey([], undefined), false);
	});
});

describe("connections SSR", () => {
	it("section is custom providers only, no subscription login flow", () => {
		const html = renderToStaticMarkup(<ConnectionsSection />);
		assert.ok(html.includes('data-testid="connections-section"'));
		assert.ok(html.includes('data-testid="connections-custom"'));
		assert.ok(html.includes('data-testid="custom-add"'));
		assert.ok(!html.includes("connections-subscriptions"));
		assert.ok(!/codex|subscription|login|Sign-in|Connect</i.test(html.replace(/Add custom provider/g, "")));
	});
	it("settings nav has Connections", () => {
		const html = renderToStaticMarkup(<SettingsDialogBody onClose={noop} initialSection="connections" />);
		assert.ok(html.includes('data-testid="settings-nav-connections"'));
	});
	it("editor: password key, keyless toggle, model rows", () => {
		const html = renderToStaticMarkup(<CustomProviderEditor initial={emptyCustomDraft()} keyStored={false} onSaved={noop} onCancel={noop} />);
		assert.ok(html.includes('type="password"'));
		assert.ok(html.includes('data-testid="custom-keyless"'));
		assert.ok(html.includes('data-testid="custom-model-0"'));
		assert.ok(html.includes("anthropic-messages"));
	});
	it("Providers subscriptions group shows native ChatGPT/Claude/Grok buttons", () => {
		// KeysSection renders a loading state under SSR, so mount the exact
		// components its Subscriptions group uses.
		const html = renderToStaticMarkup(
			<ChatGPTUIProvider>
				<NativeSubscriptionUIProvider><SubscriptionConnections /></NativeSubscriptionUIProvider>
				<LegacySubscriptionsUIProvider><LegacySubscriptionConnection /></LegacySubscriptionsUIProvider>
			</ChatGPTUIProvider>,
		);
		for (const k of ["chatgpt-connection", "github-copilot-connection", "xai-connection", "native-claude-connection"]) assert.ok(html.includes(`data-testid="${k}"`), k);
		assert.ok(html.includes("Connect") && html.includes("Continue with Claude"));
		assert.ok(CLAUDE_POLICY_NOTICE.includes("Anthropic does not permit third-party Claude.ai login"));
	});
	it("setup first-key screen links to Connections and shows native buttons", () => {
		const html = renderToStaticMarkup(
			<ChatGPTUIProvider><NativeSubscriptionUIProvider><LegacySubscriptionsUIProvider><SetupKeysBody
				providers={[]}
				provider={null}
				value=""
				saving={false}
				error={null}
				menuOpen={false}
				onToggleMenu={noop}
				onPick={noop}
				onValue={noop}
				onSave={noop}
				menuAnchor={{ current: null }}
				onOpenConnections={noop}
			/></LegacySubscriptionsUIProvider></NativeSubscriptionUIProvider></ChatGPTUIProvider>,
		);
		assert.ok(html.includes('data-testid="setup-open-connections"'));
		for (const k of ["chatgpt-connection", "github-copilot-connection", "xai-connection", "native-claude-connection"]) assert.ok(html.includes(`data-testid="${k}"`), k);
		assert.ok(html.includes("Connect") && html.includes("Continue with Claude"));
	});
});
