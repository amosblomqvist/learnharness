import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { KeysSection } from "../components/settings/keys-section.tsx";
import { onSettingsSaved } from "../components/settings-signal.ts";
import { BEDROCK_PROVIDER } from "../src/core/bedrock.ts";

it("a failed credential deletion stays visible, shows its error, and can be retried", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.assign(globalThis, {
		window: dom.window, document: dom.document, Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	const originalFetch = globalThis.fetch;
	let fail = true, present = true, reads = 0, signals = 0;
	const error = "Unable to delete key. Check your credential file and permissions, then retry.";
	globalThis.fetch = async (url, options) => {
		if (options?.method === "DELETE") {
			assert.equal(url, `/api/keys/${BEDROCK_PROVIDER.envVar}`);
			if (fail) return Response.json({ error }, { status: 500 });
			present = false;
			return Response.json({});
		}
		if (url === "/api/keys") {
			reads++;
			return Response.json({
				providers: [BEDROCK_PROVIDER],
				keys: present ? [{ id: BEDROCK_PROVIDER.envVar, info: null, present: true, source: "file", masked: "…test (20 chars)", shadowedByEnv: false }] : [],
			});
		}
		return Response.json({ settings: null });
	};
	const stop = onSettingsSaved((section) => { if (section === "keys") signals++; });
	const root = createRoot(document.getElementById("root")!);
	const button = () => document.querySelector<HTMLButtonElement>('[data-testid="key-aws_bearer_token_bedrock-delete"]');
	try {
		await act(async () => root.render(<KeysSection initialRow={BEDROCK_PROVIDER.envVar} />));
		const before = reads;
		assert.ok(button());
		await act(async () => button()!.click());
		assert.equal(document.querySelector('[data-testid="key-aws_bearer_token_bedrock-error"]')?.textContent, error);
		assert.equal(reads, before, "failure must not reload an unreadable store as an empty key list");
		assert.equal(signals, 0, "failure must not announce a successful mutation");
		assert.equal(button()!.disabled, false, "retry is available");
		fail = false;
		await act(async () => button()!.click());
		assert.equal(signals, 1);
		assert.equal(button(), null);
	} finally {
		await act(async () => root.unmount());
		stop();
		globalThis.fetch = originalFetch;
	}
});
