import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { createPluginWindowOwner, PluginsProvider } from "../components/plugins.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { CommunityPluginBrowser } from "../components/settings/community-plugin-browser.tsx";
import { communityMarkdown } from "../components/settings/community-readme.ts";
import { HostMarkdown } from "../components/host-markdown.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import type { CommunityDetail, CommunityOffer, PluginInfo } from "../src/core/index.ts";
import type { CommunityRelease } from "../src/core/community-catalog.ts";
import { installModalDom } from "./modal-dom.ts";

const release = (version: string, publishedAt: string, featured = false): CommunityRelease =>
	({ version, apiVersion: 1, minAppVersion: "0.7.0", publishedAt, tag: `v${version}`, asset: "a.zip", sha256: version[0]!.repeat(64), ...(featured ? { featured: true as const } : {}) });
function offer(id: string, downloads: number, listedAt: string, offered: CommunityRelease | null, releases = offered ? [offered] : [], action: CommunityOffer["action"] = offered ? "Install" : null): CommunityOffer {
	return { listing: { id, name: id[0]!.toUpperCase() + id.slice(1), author: `${id} author`, description: `${id} description`, repository: `example/${id}`, downloads, listedAt, releases }, release: offered, action };
}
const reviewed = release("1.0.0", "2026-11-02T00:00:00Z", true), unreviewed = release("2.0.0", "2026-11-12T00:00:00Z");
const OFFERS = [
	offer("alpha", 10, "2026-11-01T00:00:00Z", release("1.0.0", "2026-11-01T00:00:00Z", true)),
	offer("bravo", 1250, "2026-11-10T00:00:00Z", unreviewed, [reviewed, unreviewed]),
	offer("charlie", 99, "2026-11-30T00:00:00Z", null),
	offer("delta", 10, "2026-11-20T00:00:00Z", release("3.0.0", "2026-11-20T00:00:00Z"), undefined, null),
];
const BRAVO: CommunityDetail = { schemaVersion: 1, id: "bravo", readme: { tag: "v2.0.0", markdown: "# Bravo\n\n![Screenshot](docs/shot.png)\n\nRead [the guide](docs/guide.md)." }, releases: [{ version: "2.0.0", notes: "Faster cards." }, { version: "1.0.0", notes: "" }] };

it("README images become links and relative paths point at the repository at the listed tag", () => {
	const markdown = communityMarkdown("[![CI](https://x.test/badge.svg)](https://x.test/ci)\n\n![Shot](./docs/a.png)\n\n<img src=\"docs/h.png\" alt=\"Hero\">\n\n[Guide](docs/g.md) [Top](#top)", "example/p", "v1.0.0");
	assert.equal(markdown, "[CI](<https://x.test/ci>)\n\n[Shot](<https://github.com/example/p/blob/v1.0.0/docs/a.png>)\n\n<a href=\"https://github.com/example/p/blob/v1.0.0/docs/h.png\">Hero</a>\n\n[Guide](<https://github.com/example/p/blob/v1.0.0/docs/g.md>) [Top](<https://github.com/example/p/tree/v1.0.0#top>)");
	const html = renderToStaticMarkup(<HostMarkdown text={markdown} />);
	assert.doesNotMatch(html, /<img/, "nothing in a README loads on open");
	assert.match(html, /href="https:\/\/github.com\/example\/p\/blob\/v1.0.0\/docs\/a.png"/);
	assert.match(html, /href="https:\/\/github.com\/example\/p\/blob\/v1.0.0\/docs\/h.png"/);
});

it("Browse opens on Featured, switches views, hides listings with no release, and opens a detail page with README and changelog", async () => {
	const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	const keys = ["window", "self", "document", "HTMLElement", "Element", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
	const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	let offers = OFFERS;
	let detailResponse = () => Response.json({ detail: BRAVO });
	const requests: string[] = [];
	Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
		fetch: async (url: string) => {
			requests.push(url);
			if (url === "/api/plugin-catalog") return Response.json({ offers });
			if (url === "/api/plugin-catalog/bravo") return detailResponse();
			throw new Error(`Unexpected request ${url}`);
		}, IS_REACT_ACT_ENVIRONMENT: true });
	const restoreModalDom = installModalDom(dom);
	Object.defineProperty(dom.window, "getSelection", { configurable: true, value: () => ({ anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0 }) });
	const installed: PluginInfo = { id: "delta", origin: "community", enabled: false, status: "disabled", revision: "one", manifest: { apiVersion: 1, id: "delta", name: "Delta", version: "3.0.0", minAppVersion: "0.7.0", main: "main.js" } };
	window.__lhPluginWindow = createPluginWindowOwner({
		fetch: async () => Response.json({ plugins: [installed], directory: "/fixtures/plugins", communityEnabled: true, conflicts: [] }),
		importModule: async () => ({ activate() {} }), pathname: () => "/", navigate() {},
	});
	const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
	const connect = () => ({ close() {}, onOpen() {}, onEvent() {} });
	const installs: string[] = [];
	let closed = 0;
	const root = createRoot(document.querySelector("#root")!);
	const mount = async () => {
		await act(async () => { root.render(<InteractionLayersProvider><AppRouterContext.Provider value={router}><ServerEventsProvider connect={connect}><PluginsProvider>
			<CommunityPluginBrowser onClose={() => closed++} onInstall={entry => installs.push(entry.listing.id)} />
		</PluginsProvider></ServerEventsProvider></AppRouterContext.Provider></InteractionLayersProvider>); });
		await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
	};
	const $ = (selector: string) => document.querySelector(selector);
	const cards = () => [...document.querySelectorAll("[data-plugin]")].map(card => card.getAttribute("data-plugin"));
	const view = (label: string) => [...document.querySelectorAll('[role="radio"]')].find(button => button.textContent === label) as HTMLElement;
	const button = (label: string) => [...document.querySelectorAll("button")].find(element => element.textContent === label) as HTMLElement;
	const click = async (element: Element | null) => {
		assert.ok(element);
		await act(async () => { element.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
	};
	const key = async (target: Element, name: string) => {
		const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key: name });
		await act(async () => { target.dispatchEvent(event); });
	};
	try {
		await mount();
		assert.equal(view("Featured").getAttribute("aria-checked"), "true", "opens on Featured when something is featured");
		assert.deepEqual(cards(), ["alpha"]);
		assert.match($('[data-plugin="alpha"]')!.textContent!, /Featured/);
		assert.equal($('[data-plugin="alpha"] [title]')?.getAttribute("title"), "Reviewed by LearnHarness maintainers (v1.0.0).");
		assert.match($('[data-testid="community-plugin-browser"]')!.textContent!, /1 listing is hidden because it has no compatible release/);

		await key(view("Featured"), "ArrowRight");
		assert.equal(view("Most downloaded").getAttribute("aria-checked"), "true");
		assert.equal(document.activeElement, view("Most downloaded"), "arrow keys move focus with the selection");
		assert.deepEqual(cards(), ["bravo", "alpha", "delta"]);
		assert.doesNotMatch($('[data-plugin="bravo"]')!.textContent!, /Featured/, "a newer unreviewed release drops the mark");
		assert.match($('[data-plugin="bravo"]')!.textContent!, /1,250 downloads/);
		assert.match($('[data-plugin="delta"]')!.textContent!, /Installed/);
		assert.equal($('[data-plugin="delta"] [aria-label^="Install"]'), null);
		await click(view("Newest"));
		assert.deepEqual(cards(), ["delta", "bravo", "alpha"]);
		const search = $('input[type="search"]') as HTMLInputElement;
		await act(async () => {
			search.focus();
			Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "BRAVO");
			// React was loaded before this DOM existed, so it uses its value-polling fallback.
			search.dispatchEvent(new dom.window.Event("keyup", { bubbles: true }));
		});
		assert.deepEqual(cards(), ["bravo"], "search filters within the view");
		assert.equal($('[aria-label="Install Alpha"]'), null, "filtered-out cards are gone");
		await click($('[aria-label="Install Bravo"]'));
		assert.deepEqual(installs, ["bravo"]);

		await click($('[data-plugin="bravo"] h3 button'));
		const page = $('[data-testid="community-plugin-detail"]')!;
		assert.ok(page, "the card opens a detail page in place of Browse");
		assert.equal($('[data-testid="community-plugin-browser"]'), null);
		assert.equal(document.activeElement?.textContent, "Bravo", "focus lands on the plugin name");
		assert.match(page.textContent!, /1,250 downloads · v2\.0\.0 · Released/);
		assert.match(page.textContent!, /v1\.0\.0 was reviewed by LearnHarness maintainers\. v2\.0\.0 has not been reviewed\./);
		assert.ok([...page.querySelectorAll("a")].some(link => link.textContent === "Listing problem"));
		assert.equal(page.querySelector("img"), null);
		assert.ok([...page.querySelectorAll("a")].some(link => link.textContent === "Screenshot" && link.getAttribute("href") === "https://github.com/example/bravo/blob/v2.0.0/docs/shot.png"));
		assert.ok([...page.querySelectorAll("a")].some(link => link.textContent === "the guide" && link.getAttribute("href") === "https://github.com/example/bravo/blob/v2.0.0/docs/guide.md"));
		const tab = (label: string) => [...page.querySelectorAll('[role="tab"]')].find(element => element.textContent === label)!;
		assert.equal(tab("README").getAttribute("aria-selected"), "true");
		await key(tab("README"), "ArrowRight");
		assert.equal(tab("Changelog").getAttribute("aria-selected"), "true");
		const changelog = $('[role="tabpanel"]')!.textContent!;
		assert.ok(changelog.indexOf("v2.0.0") < changelog.indexOf("v1.0.0"), "newest release first");
		assert.match(changelog, /Faster cards\./);
		assert.match(changelog, /No release notes\./);
		assert.match(changelog, /v1\.0\.0.*Featured/, "the reviewed release keeps its mark in the changelog");
		await click($('[aria-label="Install Bravo"]'));
		assert.deepEqual(installs, ["bravo", "bravo"]);

		await click(button("Browse"));
		assert.ok($('[data-testid="community-plugin-browser"]'));
		assert.equal(document.activeElement, $('[data-plugin="bravo"] h3 button'), "Back returns to the card it came from");
		assert.equal(view("Newest").getAttribute("aria-checked"), "true", "the view and search survive a detail visit");
		assert.equal(search.isConnected ? search.value : ($('input[type="search"]') as HTMLInputElement).value, "BRAVO");

		detailResponse = () => Response.json({ error: "Plugin details are unavailable. Try again later." }, { status: 503 });
		await click($('[data-plugin="bravo"] h3 button'));
		assert.match($('[role="alert"]')!.textContent!, /Plugin details are unavailable/);
		assert.ok($('[aria-label="Install Bravo"]'), "Install still works without details");
		detailResponse = () => Response.json({ detail: BRAVO });
		await click(button("Try again"));
		assert.equal($('[role="alert"]'), null);
		assert.match($('[role="tabpanel"]')!.textContent!, /Bravo/);
		await click(button("Browse"));
		await click(button("Community plugins"));
		assert.equal(closed, 1);

		offers = OFFERS.map(entry => ({ ...entry, release: entry.release && { ...entry.release, featured: undefined }, listing: { ...entry.listing, releases: entry.listing.releases.map(({ featured: _, ...rest }) => rest) } }));
		await act(async () => { root.render(<p />); });
		await mount();
		assert.equal(view("Most downloaded").getAttribute("aria-checked"), "true", "opens on Most downloaded when nothing is featured");
		await click(view("Featured"));
		assert.match($('[data-testid="community-plugin-browser"]')!.textContent!, /No featured plugins yet\. Featured plugins are reviewed by LearnHarness maintainers\./);
		await click(button("Show most downloaded"));
		assert.deepEqual(cards(), ["bravo", "alpha", "delta"]);
	} finally {
		await act(async () => { root.unmount(); });
		await new Promise(resolve => setTimeout(resolve, 5));
		restoreModalDom();
		Reflect.deleteProperty(window, "__lhPluginWindow");
		for (const key of keys) {
			const descriptor = saved.get(key);
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
});
