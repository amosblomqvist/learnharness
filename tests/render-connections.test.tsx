import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	ConnectionsSection,
	LoginAttemptPanel,
	LoginPromptForm,
	cancelPendingLogins,
	safeExternalUrl,
	subscriptionLine,
} from "../components/settings/connections-section.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { SetupKeysBody } from "../components/setup-dialog.tsx";
import { hasAvailableProvider, hasProviderKey } from "../components/setup-cta.tsx";
import type { LoginAttemptView } from "../src/core/index.ts";

const noop = () => {};

describe("connections pure helpers", () => {

	it("only http(s) links", () => {
		assert.equal(safeExternalUrl("javascript:alert(1)"), null);
		assert.equal(safeExternalUrl("nope"), null);
		assert.ok(safeExternalUrl("https://example.com/a"));
	});
	it("pending status is not disconnected", () => {
		assert.equal(subscriptionLine(undefined), "checking");
		assert.equal(subscriptionLine({ id: "subscription-openai-codex", name: "x", connected: false }), "not connected");
	});




	it("availability helper; hasProviderKey unchanged", () => {
		assert.equal(hasAvailableProvider([{ keyPresent: false }, { keyPresent: true }]), true);
		assert.equal(hasAvailableProvider([]), false);
		assert.equal(hasProviderKey([], undefined), false);
	});
});

describe("unmount cancel", () => {
	it("cancels only pending attempts with keepalive DELETE", () => {
		const calls: [string, RequestInit][] = [];
		const base = { providerId: "subscription-openai-codex" as const, events: [] as LoginAttemptView["events"] };
		const ids = cancelPendingLogins(
			{
				a: { ...base, id: "p1", state: "pending" },
				b: { ...base, id: "f1", state: "failed" },
			},
			async (u, i) => void calls.push([u, i]),
		);
		assert.deepEqual(ids, ["p1"]);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]![0], "/api/connections/login/p1");
		assert.equal(calls[0]![1].method, "DELETE");
		assert.equal(calls[0]![1].keepalive, true);
		assert.equal((calls[0]![1].headers as Record<string, string>)["X-LearnHarness-Connections"], "1");
	});
});

describe("connections SSR", () => {
	it("section lists only Codex in a checking state", () => {
		const html = renderToStaticMarkup(<ConnectionsSection />);
		for (const p of ["openai-codex"]) assert.ok(html.includes(`subscription-${p}-status`));
		assert.ok(html.includes("checking"));
		assert.ok(!html.includes("not connected"));
		assert.ok(!html.includes("custom-add") && !html.includes("subscription-anthropic") && !html.includes("subscription-xai"));
	});
	it("settings nav has Connections", () => {
		const html = renderToStaticMarkup(<SettingsDialogBody onClose={noop} initialSection="connections" />);
		assert.ok(html.includes('data-testid="settings-nav-connections"'));
	});

	it("attempt panel: external links, device code, error", () => {
		const attempt: LoginAttemptView = {
			id: "a",
			providerId: "subscription-openai-codex",
			state: "pending",
			events: [
				{ type: "auth_url", url: "https://auth.example/x" },
				{ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.com/device" },
			],
		};
		const html = renderToStaticMarkup(<LoginAttemptPanel attempt={attempt} busy={false} onAnswer={noop} onCancel={noop} />);
		assert.ok(html.includes('target="_blank"') && html.includes('rel="noopener noreferrer"'));
		assert.ok(html.includes("ABCD-1234"));
		assert.ok(html.includes('data-testid="login-cancel"'));
		const bad = renderToStaticMarkup(
			<LoginAttemptPanel attempt={{ ...attempt, events: [{ type: "auth_url", url: "javascript:alert(1)" }] }} busy={false} onAnswer={noop} onCancel={noop} />,
		);
		assert.ok(!bad.includes("javascript:"));
		const failed = renderToStaticMarkup(
			<LoginAttemptPanel attempt={{ ...attempt, state: "failed", events: [], error: "Sign-in failed." }} busy={false} onAnswer={noop} onCancel={noop} />,
		);
		assert.ok(failed.includes('data-testid="login-error"'));
	});
	it("prompt types", () => {
		const secret = renderToStaticMarkup(<LoginPromptForm prompt={{ id: "p", type: "secret", message: "Token" }} busy={false} onSubmit={noop} />);
		assert.ok(secret.includes('type="password"'));
		const sel = renderToStaticMarkup(
			<LoginPromptForm prompt={{ id: "p", type: "select", message: "Pick", options: [{ id: "o", label: "Opt" }] }} busy={false} onSubmit={noop} />,
		);
		assert.ok(sel.includes("<select") && sel.includes("Opt"));
		const manual = renderToStaticMarkup(<LoginPromptForm prompt={{ id: "p", type: "manual_code", message: "Code" }} busy={false} onSubmit={noop} />);
		assert.ok(manual.includes("Paste the code"));
	});
	it("setup first-key screen links to Connections", () => {
		const html = renderToStaticMarkup(
			<SetupKeysBody
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
			/>,
		);
		assert.ok(html.includes('data-testid="setup-open-connections"'));
	});
});
