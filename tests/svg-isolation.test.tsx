import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { VisualOutputCard, svgNaturalWidth } from "../components/artifacts/visual-card.tsx";
import { MermaidOverlay } from "../components/session-overlay.tsx";

const hostile = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><script>fetch('/api/acp/codex')</script><foreignObject><img xmlns="http://www.w3.org/1999/xhtml" src="x" onerror="fetch('/api/acp/codex')" /></foreignObject><a href="javascript:alert(1)"><text>Test</text></a><image href="https://unrelated.invalid/pixel" /></svg>`;

for (const mode of ["card", "fullscreen"] as const) {
	it(`${mode}: generated SVG stays in an inert image document`, () => {
		const html = renderToStaticMarkup(mode === "card" ? <VisualOutputCard output={{ svg: hostile }} /> : <MermaidOverlay svg={hostile} onClose={() => {}} />);
		const { document } = parseHTML(html);
		const holder = document.querySelector(mode === "card" ? '[data-testid="visual-svg"]' : '[data-lh-overlay-chart]')!;
		const image = holder.querySelector("img")!;
		assert.ok(image);
		assert.equal(holder.querySelector("script, foreignObject, svg, a, [onerror]"), null, "active markup never enters the app document");
		const src = image.getAttribute("src")!;
		assert.ok(src.startsWith("data:image/svg+xml;charset=utf-8,"));
		assert.equal(decodeURIComponent(src.slice(src.indexOf(",") + 1)), hostile);
	});
}
it("ordinary vector figures preserve natural sizing", () => {
	const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><circle cx="80" cy="80" r="40" /></svg>';
	assert.equal(svgNaturalWidth(svg), 320);
	const { document } = parseHTML(renderToStaticMarkup(<VisualOutputCard output={{ svg }} />));
	assert.equal(document.querySelector('[data-testid="visual-svg"] img')?.getAttribute("width"), "320");
});
