import { tex, dvi2svg, BrowserResourceLoader } from "isomorphic-tikzjax";
import { checkSource, checkSvgSize } from "./contract.ts";

const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; source: string; resourcesUrl: string }>) => void) | null;
  postMessage(value: unknown): void;
};
let loader: BrowserResourceLoader | undefined;
let resourceUrl: string | undefined;
worker.onmessage = async ({ data }) => {
  try {
    checkSource("tikz", data.source);
    // Always use the plugin's explicit local resource root, never the package CDN default.
    const url = new URL(data.resourcesUrl);
    if (url.origin !== new URL(import.meta.url).origin) throw new Error("TeX resources must be local plugin assets.");
    if (!loader || resourceUrl !== url.href) { resourceUrl = url.href; loader = new BrowserResourceLoader(url.href); }
    const dvi = await tex(data.source, { showConsole: false }, loader);
    // The library's DOM parse is NOT a sanitizer. Our main-thread static SVG
    // rebuilder is the only admission path to the page. No DOM/SVGO runs here.
    const raw = await dvi2svg(dvi, { disableSanitize: true, embedFontCss: false });
    // This pinned DVI writer omits the single outer closing SVG tag (its usual
    // HTML parser repairs it). Close only that known fragment shape, then use
    // strict inert XML parsing in our sanitizer; never parse generated HTML.
    const svg = /^<svg\b/.test(raw) && (raw.match(/<svg\b/g) ?? []).length === 1 && !/<\/svg\s*>/.test(raw) ? raw + "</svg>" : raw;
    checkSvgSize(svg);
    worker.postMessage({ id: data.id, svg });
  } catch (error) {
    worker.postMessage({ id: data.id, error: error instanceof Error ? error.message : "TeX rendering failed." });
  }
};
