/**
 * Settings → General update rows (owner 2026-10-25): the version row with
 * one button on the right (Check for updates ↔ spinner ↔ Restart) and the
 * Automatic updates toggle below it. Without an updater (browser / dev):
 * the version row alone. SSR pins the no-bridge markup; the bridge flows
 * mount with linkedom, as in render-update-banner.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as ReactDOMClient from "react-dom/client";
import { flushSync } from "react-dom";
import { parseHTML } from "linkedom";
import { UpdateSettings, updateStatusText, type UpdateState } from "../components/settings/update-settings.tsx";

const dom = parseHTML("<html><body></body></html>");
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.document;

const state = (over: Partial<UpdateState>): UpdateState => ({ status: "idle", version: null, error: null, manual: false, ...over });
const props = { autoUpdate: true, onAutoUpdateChange: () => {}, version: "0.3.7", homepage: "https://github.com/amosblomqvist/learnharness" };

function bridge(initial: UpdateState) {
	const calls = { check: 0, install: 0 };
	let push: ((s: UpdateState) => void) | null = null;
	(window as { lh?: unknown }).lh = {
		getUpdateState: async () => initial,
		onUpdateStatus: (cb: (s: UpdateState) => void) => { push = cb; return () => {}; },
		checkForUpdates: async () => { calls.check += 1; return initial; },
		installUpdate: () => { calls.install += 1; },
	};
	return { calls, push: (s: UpdateState) => flushSync(() => push?.(s)) };
}

async function mount(el: React.ReactElement) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = ReactDOMClient.createRoot(host);
	flushSync(() => root.render(el));
	await new Promise((r) => setTimeout(r, 0)); // getUpdateState resolves
	flushSync(() => {});
	return { host, done: () => { root.unmount(); host.remove(); } };
}

const q = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

describe("updateStatusText", () => {
	it("is quiet unless there is something to say", () => {
		for (const status of ["idle", "checking", "downloading", "disabled"] as const)
			assert.equal(updateStatusText(state({ status })), null, status);
		assert.equal(updateStatusText(null), null);
	});
	it("says ready, up to date, and the raw error", () => {
		assert.equal(updateStatusText(state({ status: "downloaded", version: "0.3.8" })), "A new version (0.3.8) is ready to be installed.");
		assert.equal(updateStatusText(state({ status: "up-to-date" })), "You're up to date.");
		assert.equal(updateStatusText(state({ status: "error", error: "net::ERR_PROXY" })), "Couldn't check for updates: net::ERR_PROXY");
	});
});

describe("UpdateSettings", () => {
	afterEach(() => { delete (window as { lh?: unknown }).lh; });

	it("no bridge: version + release notes only — no button, no toggle", () => {
		const html = renderToStaticMarkup(<UpdateSettings {...props} />);
		assert.ok(html.includes("Version 0.3.7"));
		assert.ok(html.includes("https://github.com/amosblomqvist/learnharness/releases/tag/v0.3.7"));
		assert.ok(!html.includes("update-check"));
		assert.ok(!html.includes("row-auto-update"));
	});

	it("disabled shell (dev): same as no bridge", async () => {
		bridge(state({ status: "disabled" }));
		const { host, done } = await mount(<UpdateSettings {...props} />);
		assert.ok(q(host, "row-version"));
		assert.equal(q(host, "update-check"), null);
		assert.equal(q(host, "row-auto-update"), null);
		done();
	});

	it("idle: Check for updates on the version row, toggle in the row below, click checks", async () => {
		const b = bridge(state({}));
		const { host, done } = await mount(<UpdateSettings {...props} />);
		const rows = [...host.children].map((el) => el.getAttribute("data-testid"));
		assert.deepEqual(rows, ["row-version", "row-auto-update"], "version first, toggle below");
		const check = q(host, "update-check") as HTMLButtonElement;
		assert.ok(q(host, "row-version")!.contains(check), "the button sits on the version row");
		assert.equal(check.disabled, false);
		check.click();
		assert.equal(b.calls.check, 1);
		done();
	});

	it("checking / downloading: the button spins and locks", async () => {
		const b = bridge(state({}));
		const { host, done } = await mount(<UpdateSettings {...props} />);
		for (const status of ["checking", "downloading"] as const) {
			b.push(state({ status, version: status === "downloading" ? "0.3.8" : null }));
			const check = q(host, "update-check") as HTMLButtonElement;
			assert.equal(check.disabled, true, status);
			assert.equal(check.getAttribute("aria-busy"), "true", status);
			assert.equal(q(host, "update-status"), null, `${status} adds no status line`);
		}
		done();
	});

	it("downloaded: Restart replaces the check button and installs", async () => {
		const b = bridge(state({}));
		const { host, done } = await mount(<UpdateSettings {...props} />);
		b.push(state({ status: "downloaded", version: "0.3.8" }));
		assert.equal(q(host, "update-check"), null);
		assert.ok(q(host, "update-status")!.textContent!.includes("0.3.8"));
		q(host, "update-restart")!.click();
		assert.equal(b.calls.install, 1);
		done();
	});

	it("error: the raw message shows and Check stays available", async () => {
		const b = bridge(state({}));
		const { host, done } = await mount(<UpdateSettings {...props} />);
		b.push(state({ status: "error", error: "does not have a valid semver version" }));
		assert.ok(q(host, "update-status")!.textContent!.includes("does not have a valid semver version"));
		assert.equal((q(host, "update-check") as HTMLButtonElement).disabled, false);
		done();
	});

	it("reads the state on mount — a staged update shows without a push", async () => {
		bridge(state({ status: "downloaded", version: "0.3.8" }));
		const { host, done } = await mount(<UpdateSettings {...props} />);
		assert.ok(q(host, "update-restart"));
		done();
	});

	it("the toggle writes through", async () => {
		bridge(state({}));
		const seen: boolean[] = [];
		const { host, done } = await mount(<UpdateSettings {...props} autoUpdate={true} onAutoUpdateChange={(on) => seen.push(on)} />);
		q(host, "toggle-auto-update")!.click();
		assert.deepEqual(seen, [false]);
		done();
	});
});
