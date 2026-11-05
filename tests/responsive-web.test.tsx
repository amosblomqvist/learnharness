/**
 * LAN web access, S6 — responsive rules apply ONLY outside the Electron
 * window. Pins: the first-paint `lh-electron` class (server-detected), the
 * web-only Tailwind variants, the browser drawer, the phone Settings tab
 * strip, and the touch reveal of hover-only controls.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveSidebar, SidebarFrame } from "../components/sidebar.tsx";
import { SettingsDialogBody, SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import { CopyCorner } from "../components/md-blocks.tsx";

// app/layout.tsx imports next/font, next/headers and CSS, which only the
// Next bundler understands. Stub them so the real layout runs under tsx.
const STUBS: Record<string, string> = {
	"next/font/google": "const f = () => ({ variable: 'font-var' }); export const JetBrains_Mono = f; export const Source_Sans_3 = f;",
	"next/headers": "export async function headers() { return new Headers({ 'user-agent': globalThis.__ua ?? '' }); }",
};
registerHooks({
	resolve(specifier, context, nextResolve) {
		const body = STUBS[specifier] ?? (specifier.endsWith(".css") ? "export {};" : null);
		if (body === null) return nextResolve(specifier, context);
		return { url: `data:text/javascript,${encodeURIComponent(body)}#${specifier}`, shortCircuit: true };
	},
});

async function htmlClass(ua: string): Promise<string> {
	(globalThis as Record<string, unknown>).__ua = ua;
	const { default: RootLayout } = await import("../app/layout.tsx");
	const el = (await RootLayout({ children: null })) as React.ReactElement<{ className: string }>;
	return el.props.className;
}

describe("first paint: the lh-electron class", () => {
	it("is on <html> for the Electron user agent, in the server render", async () => {
		const cls = await htmlClass("Mozilla/5.0 (X11; Linux x86_64) Chrome/130 Electron/33.0.0 Safari/537.36");
		assert.ok(cls.split(" ").includes("lh-electron"));
		assert.ok(cls.split(" ").includes("dark"), "existing classes survive");
	});

	it("is absent for an ordinary browser", async () => {
		const cls = await htmlClass("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1");
		assert.ok(!cls.includes("lh-electron"));
	});
});

describe("web-only variants", () => {
	const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
	it("web-phone and web-touch are keyed on html:not(.lh-electron)", () => {
		const phone = css.match(/@custom-variant web-phone[\s\S]*?\n\}/)?.[0] ?? "";
		const touch = css.match(/@custom-variant web-touch[\s\S]*?\n\}/)?.[0] ?? "";
		assert.ok(phone.includes("html:not(.lh-electron)") && phone.includes("48rem"), phone);
		assert.ok(touch.includes("html:not(.lh-electron)") && touch.includes("hover: none"), touch);
	});
});

describe("browser sidebar drawer", () => {
	it("pushes (never an overlay) in Electron at any width", () => {
		assert.deepEqual(resolveSidebar({ electron: true, narrow: true, pref: true, drawer: true }), { open: false, overlay: false });
		assert.deepEqual(resolveSidebar({ electron: true, narrow: false, pref: true, drawer: false }), { open: true, overlay: false });
	});
	it("pushes in a wide browser", () => {
		assert.deepEqual(resolveSidebar({ electron: false, narrow: false, pref: true, drawer: false }), { open: true, overlay: false });
		assert.deepEqual(resolveSidebar({ electron: false, narrow: false, pref: false, drawer: true }), { open: false, overlay: false });
	});
	it("is an overlay below the threshold, open only by the drawer flag", () => {
		assert.deepEqual(resolveSidebar({ electron: false, narrow: true, pref: true, drawer: false }), { open: false, overlay: true });
		assert.deepEqual(resolveSidebar({ electron: false, narrow: true, pref: false, drawer: true }), { open: true, overlay: true });
	});

	it("overlay frame: fixed drawer plus a backdrop that closes it", () => {
		let closed = 0;
		const html = renderToStaticMarkup(
			<SidebarFrame open overlay onClose={() => closed++}>x</SidebarFrame>,
		);
		assert.ok(html.includes('data-testid="sidebar-backdrop"'));
		assert.match(html, /<aside[^>]*class="[^"]*fixed[^"]*z-40/);
		assert.ok(!html.includes("-translate-x-full"));
		const closedHtml = renderToStaticMarkup(<SidebarFrame open={false} overlay onClose={() => {}}>x</SidebarFrame>);
		assert.ok(!closedHtml.includes("sidebar-backdrop"), "no backdrop while closed");
		assert.ok(closedHtml.includes("-translate-x-full"));
		assert.equal(closed, 0);
	});

	it("push frame is the unchanged inline sidebar", () => {
		const html = renderToStaticMarkup(<SidebarFrame open overlay={false} onClose={() => {}}>x</SidebarFrame>);
		assert.ok(html.includes("w-72") && html.includes("sidebar-motion"));
		assert.ok(!html.includes("fixed") && !html.includes("backdrop"));
	});
});

describe("Settings on phones", () => {
	const html = renderToStaticMarkup(
		<SettingsDialogProvider>
			<SettingsDialogBody onClose={() => {}} />
		</SettingsDialogProvider>,
	);
	it("the tab strip and full-screen rules use only web-phone variants", () => {
		const nav = html.match(/<nav[^>]*data-testid="settings-nav"[^>]*>/)?.[0] ?? "";
		assert.ok(nav.includes("w-44"), "desktop classes untouched");
		assert.ok(nav.includes("web-phone:flex-row") && nav.includes("web-phone:overflow-x-auto"), nav);
		const dialog = html.match(/<div[^>]*data-testid="settings-dialog"[^>]*>/)?.[0] ?? "";
		assert.ok(dialog.includes("w-[920px]") && dialog.includes("web-phone:w-screen") && dialog.includes("web-phone:h-dvh"), dialog);
		// every responsive-looking utility in the dialog chrome is web-gated
		for (const m of dialog.matchAll(/(?:^|[\s"])((?:sm|md|lg|max-md|max-sm):[^\s"]+)/g)) assert.fail(`ungated ${m[1]}`);
	});
});

describe("hover-only reveals", () => {
	it("copy buttons are always visible under the web-touch variant", () => {
		const html = renderToStaticMarkup(<CopyCorner getText={() => "x"} label="Copy" />);
		assert.ok(html.includes("group-hover/md:opacity-100"), "desktop hover reveal kept");
		assert.ok(html.includes("web-touch:opacity-100"));
	});
});
