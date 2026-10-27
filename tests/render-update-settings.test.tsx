/** Update UI with a fake preload bridge: no Electron, network or updates. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { UpdateSettings, updateStatusText, MANUAL_UPDATE_HINT, AUTO_UPDATE_HINT, type UpdateState } from "../components/settings/update-settings.tsx";
import UpdateBanner from "../components/update-banner.tsx";
import { SettingsDialogBody, SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import nextConfig from "../next.config.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });
const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];
const state = (over: Partial<UpdateState> = {}): UpdateState => ({ status: "idle", version: null, revision: 0, ...over });
const props = { autoUpdate: true, onAutoUpdateChange: () => {}, version: "0.3.7", homepage: "https://github.com/amosblomqvist/learnharness" };
const q = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function bridge(initial = state(), snapshot = Promise.resolve(initial)) {
	const listeners = new Set<(value: UpdateState) => void>();
	const calls = { check: 0, install: 0, get: 0 };
	let onOpen: ((section: string) => void) | null = null;
	let checkFailure: Error | null = null;
	window.lh = {
		expandWindow() {},
		getUpdateState: () => { calls.get++; return snapshot; },
		onUpdateStatus: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
		checkForUpdates: async () => { calls.check++; if (checkFailure) throw checkFailure; },
		installUpdate: () => { calls.install++; },
		onOpenSettings: cb => { onOpen = cb; return () => { onOpen = null; }; },
	};
	return {
		calls, listeners,
		failCheck: () => { checkFailure = new Error("sensitive raw diagnostics"); },
		push: async (value: UpdateState) => { await act(async () => { for (const listener of listeners) listener(value); }); },
		open: async () => { await act(async () => onOpen?.("general")); },
	};
}

async function mount(element: React.ReactElement) {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host); roots.push({ root, host });
	await act(async () => { root.render(element); });
	return host;
}

async function click(element: HTMLElement | null) {
	assert.ok(element, "missing click target");
	await act(async () => { element.click(); });
}

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => { root.unmount(); }); host.remove();
	}
	delete window.lh;
	globalThis.fetch = originalFetch;
});

describe("version and contextual copy", () => {
	it("build metadata comes from package.json and exposes only public version/homepage values", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		assert.deepEqual(nextConfig.env, { LH_VERSION: pkg.version, LH_HOMEPAGE: pkg.homepage });
	});

	it("never claims live/latest information and keeps updater errors generic", () => {
		assert.equal(updateStatusText(null), null);
		assert.equal(updateStatusText(state()), null);
		assert.equal(updateStatusText(state({ status: "disabled" })), null);
		assert.equal(updateStatusText(state({ status: "checking" })), "Checking for updates…");
		assert.equal(updateStatusText(state({ status: "downloading", version: "0.3.8" })), "Downloading version 0.3.8…");
		assert.equal(updateStatusText(state({ status: "up-to-date" })), "No newer version was found at the last check.");
		assert.equal(updateStatusText(state({ status: "downloaded", version: "0.3.8" })), "Version 0.3.8 is ready. It will install when you quit the app.");
		assert.equal(updateStatusText(state({ status: "error" })), "Couldn’t check for updates. Try again later.");
		assert.equal(updateStatusText(state({ status: "downloading" })), "Downloading an update…");
		assert.equal(updateStatusText(state({ status: "downloaded" })), "An update is ready. It will install when you quit the app.");
	});
});

describe("General update rows", () => {
	it("browser/SSR shows version and installed-version release notes, without inactive controls or claims", () => {
		const html = renderToStaticMarkup(<UpdateSettings {...props} />);
		assert.ok(html.includes("Version 0.3.7"));
		assert.ok(html.includes(`${props.homepage}/releases/tag/v0.3.7`));
		assert.ok(!html.includes("update-check")); assert.ok(!html.includes("row-auto-update"));
		assert.ok(!html.includes(MANUAL_UPDATE_HINT)); assert.ok(!html.includes("update-status"));
	});

	it("unpackaged/unavailable updater shows the version-only surface", async () => {
		const b = bridge(state({ status: "disabled" })); const host = await mount(<UpdateSettings {...props} />);
		assert.ok(q(host, "row-version")); assert.equal(q(host, "update-check"), null);
		assert.equal(q(host, "row-auto-update"), null); assert.equal(b.calls.check, 0);
	});

	it("idle shows two rows and clear consequences; opening Settings never checks", async () => {
		const b = bridge(); const seen: boolean[] = [];
		const host = await mount(<UpdateSettings {...props} onAutoUpdateChange={value => seen.push(value)} />);
		assert.deepEqual([...host.children].map(el => el.getAttribute("data-testid")), ["row-version", "row-auto-update"]);
		assert.ok(q(host, "row-version")!.contains(q(host, "update-check")));
		assert.ok(host.textContent!.includes(MANUAL_UPDATE_HINT)); assert.ok(host.textContent!.includes(AUTO_UPDATE_HINT));
		assert.equal(q(host, "update-status"), null); assert.equal(b.calls.check, 0);
		await click(q(host, "toggle-auto-update")); assert.deepEqual(seen, [false]);
		await click(q(host, "update-check")); assert.equal(b.calls.check, 1);
	});

	it("manual check remains available while automatic checks are OFF", async () => {
		const b = bridge(); const host = await mount(<UpdateSettings {...props} autoUpdate={false} />);
		assert.equal(q(host, "toggle-auto-update")!.getAttribute("aria-checked"), "false");
		await click(q(host, "update-check")); assert.equal(b.calls.check, 1);
	});

	it("checking/downloading shows context and disables only the UI button; ready offers Restart", async () => {
		const b = bridge(); const host = await mount(<UpdateSettings {...props} />);
		await b.push(state({ status: "checking", revision: 1 }));
		assert.equal((q(host, "update-check") as HTMLButtonElement).disabled, true);
		assert.equal(q(host, "update-check")!.getAttribute("aria-busy"), "true");
		assert.equal(q(host, "update-status")!.textContent, "Checking for updates…");
		await b.push(state({ status: "downloading", version: "0.3.8", revision: 2 }));
		assert.equal(q(host, "update-status")!.textContent, "Downloading version 0.3.8…");
		assert.equal((q(host, "update-check") as HTMLButtonElement).disabled, true);
		await b.push(state({ status: "downloaded", version: "0.3.8", revision: 3 }));
		assert.equal(q(host, "update-check"), null); assert.ok(q(host, "update-status")!.textContent!.includes("quit the app"));
		await click(q(host, "update-restart")); assert.equal(b.calls.install, 1);
	});

	it("up-to-date and failure statuses allow another manual check", async () => {
		const b = bridge(); const host = await mount(<UpdateSettings {...props} />);
		await b.push(state({ status: "up-to-date", revision: 1 }));
		assert.equal(q(host, "update-status")!.textContent, "No newer version was found at the last check.");
		await b.push(state({ status: "error", revision: 2 }));
		assert.equal((q(host, "update-check") as HTMLButtonElement).disabled, false);
		assert.equal(q(host, "update-status")!.textContent, "Couldn’t check for updates. Try again later.");
		await click(q(host, "update-check")); assert.equal(b.calls.check, 1);
	});

	it("bridge command rejection is handled without exposing raw diagnostics", async () => {
		const b = bridge(); b.failCheck(); const host = await mount(<UpdateSettings {...props} />);
		await click(q(host, "update-check"));
		assert.equal(q(host, "update-status")!.textContent, "Couldn’t check for updates. Try again later.");
		assert.ok(!host.textContent!.includes("sensitive"));
	});

	it("late Settings and banner subscribers recover the staged update without an event", async () => {
		const b = bridge(state({ status: "downloaded", version: "0.3.8", revision: 5 }));
		const host = await mount(<><UpdateSettings {...props} /><UpdateBanner /></>);
		assert.ok(q(host, "update-restart")); assert.ok(q(host, "update-banner"));
		assert.ok(q(host, "update-banner")!.textContent!.includes("0.3.8"));
		await click(q(host, "update-banner")!.querySelector("button")); assert.equal(b.calls.install, 1);
		assert.equal(b.calls.check, 0);
	});

	it("a delayed older snapshot cannot overwrite a newer push in Settings or the banner", async () => {
		const snapshot = deferred<UpdateState>(); const b = bridge(state(), snapshot.promise);
		const host = await mount(<><UpdateSettings {...props} /><UpdateBanner /></>);
		await b.push(state({ status: "downloaded", version: "0.3.8", revision: 4 }));
		await act(async () => { snapshot.resolve(state({ status: "checking", revision: 3 })); });
		assert.ok(q(host, "update-restart")); assert.ok(q(host, "update-banner"));
	});

	it("snapshot rejection cannot erase an already received event and late callbacks are unsubscribed", async () => {
		const snapshot = deferred<UpdateState>(); const b = bridge(state(), snapshot.promise);
		const host = await mount(<UpdateSettings {...props} />);
		await b.push(state({ status: "downloaded", version: "0.3.8", revision: 1 }));
		await act(async () => { snapshot.reject(new Error("IPC disconnected")); });
		assert.ok(q(host, "update-restart"));
		const { root } = roots.pop()!; await act(async () => { root.unmount(); }); host.remove();
		assert.equal(b.listeners.size, 0);
	});

	it("snapshot rejection without an event is handled with a generic message", async () => {
		const snapshot = deferred<UpdateState>(); bridge(state(), snapshot.promise);
		const host = await mount(<UpdateSettings {...props} />);
		await act(async () => { snapshot.reject(new Error("sensitive error")); });
		assert.equal(q(host, "update-status")!.textContent, "Couldn’t check for updates. Try again later.");
		assert.ok(!host.textContent!.includes("sensitive"));
	});
});

describe("Settings integration", () => {
	it("the toggle sends the complete General section and follows stored server truth", async () => {
		bridge();
		// A synthetic future sibling exercises the caller's section-preserving
		// contract without introducing a new product setting or changing its API.
		const record = { version: 1, general: { autoUpdate: true, futureSibling: "keep" } };
		const puts: unknown[] = [];
		globalThis.fetch = async (input, init) => {
			assert.equal(String(input), init?.method === "PUT" ? "/api/settings/general" : "/api/settings");
			if (init?.method === "PUT") {
				const body = JSON.parse(String(init.body)); puts.push(body);
				return Response.json({ settings: { ...record, general: body } });
			}
			return Response.json({ settings: record });
		};
		const host = await mount(<SettingsDialogBody initialSection="general" onClose={() => {}} />);
		await click(q(host, "toggle-auto-update"));
		assert.deepEqual(puts, [{ autoUpdate: false, futureSibling: "keep" }]);
		assert.equal(q(host, "toggle-auto-update")!.getAttribute("aria-checked"), "false");
	});

	it("the shell's navigation request opens General, but opening alone never checks", async () => {
		const b = bridge();
		globalThis.fetch = async () => Response.json({ settings: { version: 1 } });
		const host = await mount(<SettingsDialogProvider><span>app</span></SettingsDialogProvider>);
		assert.equal(q(document, "settings-dialog"), null);
		await b.open();
		assert.equal(q(document, "settings-nav-general")!.getAttribute("aria-current"), "true");
		assert.ok(q(document, "row-version")); assert.equal(b.calls.check, 0);
		assert.ok(host.textContent!.includes("app"));
	});
});
