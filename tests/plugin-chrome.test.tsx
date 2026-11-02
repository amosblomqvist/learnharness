import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderWithInteractionLayers as renderToStaticMarkup } from "./interaction-layer-render.tsx";
import { placedPluginActions, pluginActionDisabled, fitPluginTopBarActions, PluginSidebarActions, PluginGraphActions, PluginTopBarActions } from "../components/plugin-chrome.tsx";
import { TopBar } from "../components/top-bar.tsx";
import type { FrontendPlugin } from "../components/plugin-manager.ts";
import type { PluginActionContext, PluginFrontendContext } from "../src/core/plugins.ts";
import { mountPluginChrome, pluginInfo } from "./helpers/plugin-chrome.tsx";

const sidebar = { placement: "sidebar", surface: "sidebar" } as const;
const session = { placement: "top-bar", surface: "session", sessionId: "session-1", kind: "teaching" } as const;
function plugin(id = "fixture"): FrontendPlugin {
	return { info: pluginInfo(id), phase: "active", views: [{ id: "overview", name: "Overview", mount() {} }],
		actions: [{ id: "run", name: "Run", run() {} }], placements: [], actionBusy: [], busy: false };
}

describe("explicit plugin chrome", () => {
	it("registration/view alone adds no chrome; placement order is stable and dangling actions render nothing", () => {
		const first = plugin(), second = plugin("second");
		assert.deepEqual(placedPluginActions([first], sidebar), []);
		first.placements = [{ id: "missing", actionId: "absent", location: "sidebar" }, { id: "b", actionId: "run", location: "sidebar" }, { id: "a", actionId: "run", location: "sidebar" }];
		second.placements = [{ id: "last", actionId: "run", location: "sidebar" }];
		assert.deepEqual(placedPluginActions([first, second], sidebar).map(item => item.key), ["fixture/b", "fixture/a", "second/last"]);
		second.info.enabled = false;
		assert.equal(placedPluginActions([second], sidebar).length, 0);
		first.phase = "error";
		assert.equal(placedPluginActions([first], sidebar).length, 0);
	});

	it("top-bar sessions/views opt in independently and views cannot target another plugin", () => {
		const p = plugin();
		p.placements = [{ id: "unspecified", actionId: "run", location: "top-bar" }];
		assert.equal(placedPluginActions([p], session).length, 0);
		p.placements.push({ id: "teaching", actionId: "run", location: "top-bar", sessions: ["teaching"] }, { id: "own", actionId: "run", location: "top-bar", views: ["overview"] });
		assert.deepEqual(placedPluginActions([p], session).map(item => item.key), ["fixture/teaching"]);
		assert.equal(placedPluginActions([p], { ...session, kind: "practice" }).length, 0);
		const own = { placement: "top-bar", surface: "plugin-view", pluginId: "fixture", viewId: "overview" } as const;
		assert.deepEqual(placedPluginActions([p], own).map(item => item.key), ["fixture/own"]);
		assert.equal(placedPluginActions([p], { ...own, pluginId: "other" }).length, 0);
		p.actionBusy = ["run"];
		assert.equal(placedPluginActions([p], own)[0]?.busy, true);
	});

	it("disabled callbacks get the exact context, booleans work, broken predicates fail closed", () => {
		const p = plugin().actions[0]!;
		assert.equal(pluginActionDisabled(p, sidebar), false);
		assert.equal(pluginActionDisabled({ ...p, disabled: true }, sidebar), true);
		assert.equal(pluginActionDisabled({ ...p, disabled: context => context === sidebar }, sidebar), true);
		assert.equal(pluginActionDisabled({ ...p, disabled() { throw Error("broken"); } }, sidebar), true);
	});

	it("whole buttons adapt to actual width and reserve overflow; no count threshold", () => {
		assert.equal(fitPluginTopBarActions([80, 80, 80], 248), 3);
		assert.equal(fitPluginTopBarActions([80, 80, 80], 247), 2);
		assert.equal(fitPluginTopBarActions([80, 80], 119), 0);
		assert.equal(fitPluginTopBarActions([80, 80], 120), 1);
		assert.equal(fitPluginTopBarActions([500], 0), 0);
		assert.equal(fitPluginTopBarActions([], 0), 0);
	});

	it("missing-provider shells stay safe and core doors remain first", () => {
		const html = renderToStaticMarkup(<PluginSidebarActions><button>Teaching</button><button>Practice</button></PluginSidebarActions>);
		assert.ok(html.includes("grid-cols-1"));
		assert.ok(html.indexOf("Teaching") < html.indexOf("Practice"));
		assert.equal(renderToStaticMarkup(<PluginGraphActions />), "");
		assert.equal(renderToStaticMarkup(<PluginTopBarActions context={session} />), "");
	});

	it("real provider renders only placements, counts core doors, shares busy state and overflows adaptively", async () => {
		let context!: PluginFrontendContext, release!: () => void;
		const runs: PluginActionContext[] = [];
		const f = await mountPluginChrome({ activate(ctx) {
			context = ctx;
			ctx.registerView({ id: "unplaced-view", name: "No automatic view link", mount() {} });
			ctx.registerAction({ id: "run", name: "Fixture action", icon: '<svg viewBox="0 0 24 24"><path data-fixture-svg="true" d="M0 0h24v24H0z" /></svg>', run(value) { runs.push(value); return new Promise<void>(resolve => { release = resolve; }); } });
			ctx.registerAction({ id: "unplaced", name: "Invisible action", run() {} });
			for (let i = 0; i < 3; i++) ctx.placeAction({ id: `sidebar-${i}`, actionId: "run", location: "sidebar" });
			ctx.placeAction({ id: "graph", actionId: "run", location: "graph" });
			ctx.placeAction({ id: "top", actionId: "run", location: "top-bar", sessions: ["teaching"] });
		} }, <><PluginSidebarActions><button>Teaching</button><button>Practice</button></PluginSidebarActions><PluginGraphActions /><TopBar><h1 data-plugin-chrome-title>Session</h1><div className="min-w-4 flex-1" aria-hidden="true" /><PluginTopBarActions context={session} /></TopBar></>);
		try {
			const grid = () => f.document.querySelector('[data-testid="sidebar-actions"]')!;
			assert.ok(grid().className.includes("grid-cols-1"), "five total actions is one column");
			assert.equal(f.document.body.textContent?.includes("Invisible action"), false);
			assert.equal(f.document.body.textContent?.includes("No automatic view link"), false);
			await act(async () => { context.placeAction({ id: "sidebar-four", actionId: "run", location: "sidebar" }); });
			assert.ok(grid().className.includes("grid-cols-2"), "six total actions is two columns");
			assert.deepEqual([...grid().querySelectorAll("button")].slice(0, 2).map(button => button.textContent), ["Teaching", "Practice"]);
			await act(async () => { for (let i = 4; i < 10; i++) context.placeAction({ id: `sidebar-${i}`, actionId: "run", location: "sidebar" }); });
			assert.equal(grid().querySelectorAll("button").length, 12);
			assert.ok(grid().className.includes("max-h-[10.25rem]") && grid().className.includes("overflow-y-auto"));
			const rail = f.document.querySelector('[data-testid="plugin-graph-actions"]')!;
			assert.ok(rail.className.includes("top-11") && rail.className.includes("p-2") && rail.className.includes("bottom-0"), "closed sidebar reserves floating toggle and native lights row; inner padding keeps buttons at 8px edges");
			assert.ok(rail.classList.contains("pointer-events-none"), "transparent rail and gaps pass pointer/wheel input through to the canvas");
			assert.ok(rail.classList.contains("overflow-y-auto"), "bounded rail remains a scroll ancestor for wheel input over buttons");
			const graphButton = rail.querySelector<HTMLButtonElement>("button")!;
			assert.ok(graphButton.classList.contains("pointer-events-auto"), "buttons opt back into hit testing and wheel events bubble to the rail");
			assert.ok(graphButton.className.includes("size-9") && graphButton.className.includes("bg-card/85"));
			assert.equal(graphButton.getAttribute("title"), "Fixture action");
			assert.ok(graphButton.querySelector("[data-fixture-svg]"));
			await f.click(graphButton);
			assert.deepEqual(runs, [{ placement: "graph", surface: "graph" }]);
			assert.equal(graphButton.disabled, true);
			assert.equal(grid().querySelectorAll("button[disabled]").length, 10, "same action busy across every placement");
			await f.click(graphButton); assert.equal(runs.length, 1);
			await act(async () => { release(); });
			assert.equal(graphButton.disabled, false);
			await f.resize(280);
			const trigger = f.document.querySelector<HTMLButtonElement>('[aria-label="More plugin actions"]');
			assert.ok(trigger, "overflow trigger survives when the title consumes the available width");
			await f.click(trigger);
			assert.ok(f.document.querySelector('[data-testid="plugin-top-bar-menu"] [role="menu"][aria-label="More plugin actions"]'));
			assert.equal(f.document.querySelector('[data-testid="plugin-top-bar-menu"] [data-plugin-action="fixture/top"]')?.getAttribute("role"), "menuitem");
			await f.click(f.document.querySelector<HTMLButtonElement>('[data-testid="plugin-top-bar-menu"] button')!);
			assert.deepEqual(runs[1], session);
			assert.equal(f.document.querySelector('[data-testid="plugin-top-bar-menu"]'), null);
			await act(async () => { release(); });
			await f.resize(900);
			assert.equal(f.document.querySelector('[aria-label="More plugin actions"]'), null, "wide header restores inline action");
		} finally { await f.close(); }
	});
});
