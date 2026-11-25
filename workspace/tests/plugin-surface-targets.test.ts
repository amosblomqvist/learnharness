import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { createInteractionLayers } from "../components/interaction-layers.tsx";
import type { PluginSurfaceProps, PluginSurfaceTarget, PluginUi, PluginWidgetHandle, PluginWidgetOptions } from "../src/core/plugin-ui.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type LegacySurfaceParameterInference = Assert<Equal<Parameters<PluginUi["openSurface"]>, [target: PluginSurfaceTarget, props: PluginSurfaceProps, options: PluginWidgetOptions]>>;
export type TargetlessSurfaceSignature = Assert<PluginUi["openSurface"] extends (props: PluginSurfaceProps, options: PluginWidgetOptions) => PluginWidgetHandle<PluginSurfaceProps> ? true : false>;
import { findCurrentSurfaceBoundary, findSurfaceBoundary, registerSurfaceBoundary, requireSurfaceBoundary } from "../components/plugin-surface-targets.ts";

const region = '<div data-session-surface-region=""><div data-session-surface-mounts=""></div></div>';
function page(html = region) {
	const { document } = parseHTML(`<!doctype html><html><body><main data-page="">${html}</main></body></html>`);
	return { document, body: document.querySelector<HTMLElement>("[data-page]")! };
}

it("current page pointers are document-local and explicit targets retain their exact boundary", () => {
	const a = page(), b = page();
	const aliveA = new AbortController(), aliveB = new AbortController();
	try {
		const first = registerSurfaceBoundary(a.body, aliveA.signal, createInteractionLayers());
		const second = registerSurfaceBoundary(b.body, aliveB.signal, createInteractionLayers());
		assert.equal(findCurrentSurfaceBoundary(a.document), first); assert.equal(findCurrentSurfaceBoundary(b.document), second);
		assert.equal(requireSurfaceBoundary(first.target), first); assert.equal(requireSurfaceBoundary(second.target), second);
		aliveA.abort();
		assert.equal(findCurrentSurfaceBoundary(a.document), undefined); assert.equal(findSurfaceBoundary(first.target), undefined);
		assert.equal(findCurrentSurfaceBoundary(b.document), second);
	} finally { aliveA.abort(); aliveB.abort(); }
});

it("retiring an old page cannot clear a newer pointer, and losing the current page never falls back to retained older pages", () => {
	const f = page();
	const other = f.document.createElement("main"); other.innerHTML = region; f.document.body.append(other);
	const oldLife = new AbortController(), newLife = new AbortController(), retainedLife = new AbortController(), currentLife = new AbortController();
	try {
		const old = registerSurfaceBoundary(f.body, oldLife.signal, createInteractionLayers());
		const current = registerSurfaceBoundary(other, newLife.signal, createInteractionLayers());
		oldLife.abort(); assert.equal(findCurrentSurfaceBoundary(f.document), current);
		assert.equal(findSurfaceBoundary(old.target), undefined);
		newLife.abort(); assert.equal(findCurrentSurfaceBoundary(f.document), undefined);
		const retained = registerSurfaceBoundary(f.body, retainedLife.signal, createInteractionLayers());
		registerSurfaceBoundary(other, currentLife.signal, createInteractionLayers());
		currentLife.abort();
		assert.equal(findCurrentSurfaceBoundary(f.document), undefined, "no automatic remap to an older still-connected page");
		assert.equal(requireSurfaceBoundary(retained.target), retained, "an explicit token still names only its own live instance");
		const aborted = new AbortController(); aborted.abort();
		const dead = registerSurfaceBoundary(other, aborted.signal, createInteractionLayers());
		assert.equal(findCurrentSurfaceBoundary(f.document), undefined); assert.equal(findSurfaceBoundary(dead.target), undefined);
	} finally { oldLife.abort(); newLife.abort(); retainedLife.abort(); currentLife.abort(); }
});

it("registration eagerly binds only its already-connected direct region with a direct HTMLElement mount slot", () => {
	const valid = page(); const life = new AbortController();
	try {
		const boundary = registerSurfaceBoundary(valid.body, life.signal, createInteractionLayers());
		assert.equal(boundary.stack, valid.body.firstElementChild);
		assert.equal(requireSurfaceBoundary(boundary.target), boundary);
	} finally { life.abort(); }
	for (const html of [
		`<div>${region}</div>`,
		'<div data-session-surface-region=""></div>',
		'<div data-session-surface-region=""><div><div data-session-surface-mounts=""></div></div></div>',
		'<svg data-session-surface-region=""><g data-session-surface-mounts=""></g></svg>',
	]) {
		const f = page(html); const signal = new AbortController();
		try {
			const other = f.document.createElement("main"); other.innerHTML = region; f.document.body.append(other);
			const boundary = registerSurfaceBoundary(f.body, signal.signal, createInteractionLayers());
			assert.equal(boundary.stack, null, `must not capture a nested, malformed, SVG or unrelated page region: ${html}`);
			assert.throws(() => requireSurfaceBoundary(boundary.target), /Surface target is no longer active/);
		} finally { signal.abort(); }
	}
});

it("disconnected page bodies cannot expose a current target or eagerly capture a detached region", () => {
	const f = page(); f.body.remove(); const life = new AbortController();
	try {
		const boundary = registerSurfaceBoundary(f.body, life.signal, createInteractionLayers());
		assert.equal(boundary.stack, null); assert.equal(findCurrentSurfaceBoundary(f.document), undefined);
		assert.equal(findSurfaceBoundary(boundary.target), undefined);
		assert.throws(() => requireSurfaceBoundary(boundary.target), /Surface target is no longer active/);
	} finally { life.abort(); }
});
