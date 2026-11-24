import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { LabsSection } from "../components/settings/labs-section.tsx";

it("enables the optional Labs feature and opens Google sign-in without exposing tokens", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = { React, window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	const fetchBefore = globalThis.fetch;
	const popup = { opener: null, location: { href: "about:blank" }, close() {} };
	Object.assign(globalThis, globals);
	Object.defineProperty(dom.window, "open", { configurable: true, value: () => popup });
	let enabled = false;
	const commands: string[] = [];
	globalThis.fetch = async (_input, init) => {
		if (init?.method === "POST") {
			const command = JSON.parse(String(init.body)) as { op: string; enabled?: boolean };
			commands.push(command.op);
			assert.equal((init.headers as Record<string, string>)["x-learnharness-cloud"], "1");
			if (command.op === "enable") enabled = command.enabled!;
			if (command.op === "signIn") return Response.json({ redirect: "https://accounts.google.com/o/oauth2/v2/auth?state=public" });
		}
		return Response.json({ enabled, configured: true, user: null, profile: "local", syncing: false, deferred: 0, pendingSignIn: false, error: null, lastSynced: null });
	};
	const root = createRoot(dom.document.getElementById("root")!);
	try {
		await act(async () => root.render(<LabsSection />));
		const toggle = dom.document.querySelector<HTMLButtonElement>('[role="switch"]')!;
		assert.equal(toggle.getAttribute("aria-checked"), "false");
		assert(!dom.document.body.textContent!.includes("Sign in with Google"));
		await act(async () => toggle.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		assert.equal(toggle.getAttribute("aria-checked"), "true");
		const signIn = [...dom.document.querySelectorAll("button")].find(button => button.textContent === "Sign in with Google")!;
		await act(async () => signIn.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		assert.equal(new URL(popup.location.href).hostname, "accounts.google.com");
		assert.deepEqual(commands, ["enable", "signIn"]);
		assert(dom.document.body.textContent!.includes("most recently updated"));
	} finally {
		await act(async () => root.unmount()); globalThis.fetch = fetchBefore;
		for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});
