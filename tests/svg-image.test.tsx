import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { VisualOutputCard } from "../components/artifacts/visual-card.tsx";
import { svgImageSource } from "../components/artifacts/svg-image.tsx";
import { MermaidOverlay, SessionMermaidContext } from "../components/session-overlay.tsx";

// Structure-only checks: linkedom does not load images or implement CSS cascade.
// No fixture script, link, or external reference is executed by these tests.
const FIGURE = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><style>text{font-family:Arial,Helvetica,sans-serif;fill:#202830}</style><defs><marker id="arrow"><path d="M0 0L5 5"/></marker></defs><path marker-end="url(#arrow)" d="M0 0L20 20"/><text>θ &amp; φ: 50% #1</text></svg>`;
const ACTIVE_MARKUP = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="example()"><script>example()</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml" onclick="example()">Example</div></foreignObject><a href="javascript:example()"><text>Link</text></a><image href="https://example.invalid/image.png"/></svg>`;
const PREFIX = "data:image/svg+xml;charset=utf-8,";

function assertImageBoundary(holder: Element, source: string) {
	const image = holder.querySelector("img");
	assert.ok(image, "figure is an image");
	assert.equal(holder.children.length, 1, "no figure markup alongside the image");
	assert.equal(holder.querySelector("svg, style, script, foreignObject, a, [onload], [onclick]"), null,
		"generated elements and CSS never enter the app document");
	assert.equal(image.getAttribute("alt"), "Figure");
	assert.equal(image.getAttribute("draggable"), "false", "native image dragging must not interfere with panning");
	const src = image.getAttribute("src")!;
	assert.ok(src.startsWith(PREFIX));
	assert.equal(decodeURIComponent(src.slice(PREFIX.length)), source, "image URL contains the expected SVG display source, not a raster");
	return image;
}

describe("SVG display compatibility", () => {
	it("leaves standalone SVG unchanged, including comments and CDATA", () => {
		const source = FIGURE.replace("</svg>", '<!-- &nbsp; <svg> --><![CDATA[&nbsp; <svg>]]></svg>');
		assert.equal(svgImageSource(source), source);
	});

	it("adds only a missing root namespace, ignoring comments and attribute values", () => {
		const source = '<?xml version="1.0"?><!-- <svg xmlns="wrong"> --><svg data-note=\' xmlns="not-a-declaration" >\' xmlns:xlink="http://www.w3.org/1999/xlink"><svg/></svg>';
		const expected = source.replace('<svg data-note=', '<svg xmlns="http://www.w3.org/2000/svg" data-note=');
		assert.equal(svgImageSource(source), expected);
		assert.equal(svgImageSource(expected), expected, "normalization is idempotent");
	});

	it("does not replace an explicit namespace declaration", () => {
		for (const declaration of ['xmlns="http://www.w3.org/2000/svg"', "xmlns = 'other'", 'xmlns=""']) {
			const source = `<svg ${declaration}><text>Example</text></svg>`;
			assert.equal(svgImageSource(source), source);
		}
	});

	it("converts nbsp references in text and attributes, but not comments, CDATA or processing instructions", () => {
		const source = '<?example &nbsp;?><svg xmlns="http://www.w3.org/2000/svg" aria-label="A&nbsp;B"><text>A&nbsp;B &amp;nbsp; &#160;</text><!-- &nbsp; --><![CDATA[&nbsp;]]></svg>';
		const expected = source.replace('aria-label="A&nbsp;B"', 'aria-label="A&#160;B"').replace('<text>A&nbsp;B', '<text>A&#160;B');
		assert.equal(svgImageSource(source), expected);
		assert.equal(svgImageSource(expected), expected);
	});
});

describe("generated SVG image boundary", () => {
	for (const mode of ["inline", "fullscreen"] as const) {
		for (const [name, source] of [["reported style rule and fragment IDs", FIGURE], ["active markup", ACTIVE_MARKUP]] as const) {
			it(`${mode}: isolates ${name} inside the image URL`, () => {
				const html = renderToStaticMarkup(mode === "inline"
					? <VisualOutputCard output={{ svg: source }} />
					: <MermaidOverlay svg={source} onClose={() => {}} />);
				const { document } = parseHTML(html);
				const holder = document.querySelector(mode === "inline" ? '[data-testid="visual-svg"]' : "[data-lh-overlay-chart]")!;
				assertImageBoundary(holder, source);
				assert.ok(holder.classList.contains("bg-white"), "white backing retained");
			});
		}

		for (const [name, original, display] of [
			["missing namespace", '<svg width="320" height="160"><text>Example</text></svg>', '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><text>Example</text></svg>'],
			["HTML entity", '<svg xmlns="http://www.w3.org/2000/svg"><text>A&nbsp;B</text></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><text>A&#160;B</text></svg>'],
		] as const) {
			it(`${mode}: repairs ${name} only in the image source`, () => {
				const output = { svg: original };
				const html = renderToStaticMarkup(mode === "inline"
					? <VisualOutputCard output={output} />
					: <MermaidOverlay svg={output.svg} onClose={() => {}} />);
				const { document } = parseHTML(html);
				const holder = document.querySelector(mode === "inline" ? '[data-testid="visual-svg"]' : "[data-lh-overlay-chart]")!;
				assertImageBoundary(holder, display);
				assert.equal(output.svg, original, "artifact source was not mutated");
			});
		}

		it(`${mode}: retains inversion on the white backing`, () => {
			const html = renderToStaticMarkup(mode === "inline"
				? <VisualOutputCard output={{ svg: FIGURE }} initialInverted />
				: <MermaidOverlay svg={FIGURE} inverted onClose={() => {}} />);
			const { document } = parseHTML(html);
			const holder = document.querySelector(mode === "inline" ? '[data-testid="visual-svg"]' : "[data-lh-overlay-chart]")!;
			assert.match(holder.getAttribute("style")!, /invert\(1\) hue-rotate\(180deg\)/);
			assert.ok(holder.classList.contains("bg-white"));
			assertImageBoundary(holder, FIGURE);
		});
	}

	it("inline: retains natural width and only shrinks oversized figures", () => {
		const { document } = parseHTML(renderToStaticMarkup(<VisualOutputCard output={{ svg: FIGURE }} />));
		const image = assertImageBoundary(document.querySelector('[data-testid="visual-svg"]')!, FIGURE);
		assert.equal(image.getAttribute("width"), "320");
		assert.equal(image.className, "block h-auto max-w-full");
		assert.ok(document.querySelector('[data-testid="visual-card"]')!.classList.contains("w-fit"));
	});

	for (const width of ["", ' width="100%"']) {
		it(`inline: keeps the full-width fallback for ${width || "viewBox-only"} SVG`, () => {
			const source = `<svg xmlns="http://www.w3.org/2000/svg"${width} viewBox="0 0 320 160"><text>Example</text></svg>`;
			const { document } = parseHTML(renderToStaticMarkup(<VisualOutputCard output={{ svg: source }} />));
			const image = assertImageBoundary(document.querySelector('[data-testid="visual-svg"]')!, source);
			assert.equal(image.getAttribute("width"), null);
			assert.equal(image.className, "block h-auto w-full");
			assert.ok(document.querySelector('[data-testid="visual-card"]')!.classList.contains("w-full"));
		});
	}

	it("fullscreen: keeps the natural-size box and zoom controls", () => {
		const { document } = parseHTML(renderToStaticMarkup(<MermaidOverlay svg={FIGURE} onClose={() => {}} />));
		const holder = document.querySelector("[data-lh-overlay-chart]")!;
		assert.equal(assertImageBoundary(holder, FIGURE).className, "block h-auto w-full");
		assert.match(holder.parentElement!.getAttribute("style")!, /width:320px/);
		for (const label of ["Zoom in", "Zoom out", "Fit diagram to view", "Close"]) {
			assert.ok(document.querySelector(`button[aria-label="${label}"]`));
		}
	});
});

it("the fullscreen button opens the same SVG image and inversion; download keeps original bytes", async () => {
	const originalSvg = FIGURE.replace(' xmlns="http://www.w3.org/2000/svg"', '').replace("θ &amp; φ", "θ&nbsp;&amp; φ");
	const displaySvg = FIGURE.replace("θ &amp; φ", "θ&#160;&amp; φ");
	const dom = parseHTML("<html><body></body></html>");
	const names = ["window", "document", "Element", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
	const originals = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
	Object.assign(globalThis, {
		window: dom.window,
		document: dom.document,
		Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	const host = dom.document.createElement("div");
	dom.document.body.append(host);
	const root = createRoot(host);
	const originalCreateUrl = URL.createObjectURL;
	const originalRevokeUrl = URL.revokeObjectURL;
	const originalCreateElement = dom.document.createElement;
	let downloaded: Blob | undefined;
	let revoked: string | undefined;
	let clicked: { name: string; href: string } | undefined;
	URL.createObjectURL = (blob) => {
		assert.ok(blob instanceof Blob);
		downloaded = blob;
		return "blob:figure-test";
	};
	URL.revokeObjectURL = (url) => { revoked = url; };
	function Harness() {
		const [focus, setFocus] = useState<{ svg: string; inverted: boolean } | null>(null);
		return (
			<SessionMermaidContext.Provider value={{ openMermaid: () => {}, openFigure: (svg, inverted) => setFocus({ svg, inverted }) }}>
				<VisualOutputCard output={{ svg: originalSvg }} initialInverted />
				{focus && <MermaidOverlay svg={focus.svg} inverted={focus.inverted} onClose={() => setFocus(null)} />}
			</SessionMermaidContext.Provider>
		);
	}
	try {
		await act(async () => root.render(<Harness />));
		await act(async () => { host.querySelector('[data-testid="visual-open"]')!.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		const inline = assertImageBoundary(host.querySelector('[data-testid="visual-svg"]')!, displaySvg);
		const overlayHolder = host.querySelector("[data-lh-overlay-chart]")!;
		const fullscreen = assertImageBoundary(overlayHolder, displaySvg);
		assert.equal(fullscreen.getAttribute("src"), inline.getAttribute("src"));
		assert.match(overlayHolder.getAttribute("style")!, /invert\(1\) hue-rotate\(180deg\)/);

		// Intercept only the download anchor; never navigate or write a real file.
		dom.document.createElement = ((...args: Parameters<typeof originalCreateElement>) => {
			const element = originalCreateElement.apply(dom.document, args);
			if (args[0] === "a") {
				element.click = () => { clicked = { name: element.getAttribute("download")!, href: element.getAttribute("href")! }; };
			}
			return element;
		}) as typeof originalCreateElement;
		await act(async () => { host.querySelector('[data-testid="visual-download"]')!.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		assert.ok(downloaded);
		assert.equal(await downloaded.text(), originalSvg);
		assert.equal(downloaded.type, "image/svg+xml");
		assert.deepEqual(clicked, { name: "figure.svg", href: "blob:figure-test" });
		assert.equal(revoked, "blob:figure-test");
	} finally {
		try {
			await act(async () => root.unmount());
		} finally {
			URL.createObjectURL = originalCreateUrl;
			URL.revokeObjectURL = originalRevokeUrl;
			dom.document.createElement = originalCreateElement;
			host.remove();
			for (const [i, name] of names.entries()) {
				if (originals[i]) Object.defineProperty(globalThis, name, originals[i]!);
				else Reflect.deleteProperty(globalThis, name);
			}
		}
	}
});
