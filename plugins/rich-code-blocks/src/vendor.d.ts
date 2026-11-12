// Narrow boundaries for pinned vendor packages: smiles-drawer's published SVG
// declarations reference an unimported Vertex type; TikZ's default declarations
// describe its Node entry rather than the browser Worker entry used by this build.
declare module "rich-code-blocks-smiles" {
  const SmilesDrawer: {
    parse(source: string, success: (tree: unknown) => void, failure: (error: Error) => void): void;
    SvgDrawer: new (options: { scale: number }) => {
      opts: { fontSizeLarge: number; fontSizeSmall: number; fontFamily: string };
      draw(tree: unknown, target: null, theme: "light"): SVGSVGElement;
    };
  };
  export default SmilesDrawer;
}
declare module "isomorphic-tikzjax" {
  export class BrowserResourceLoader {
    constructor(baseUrl: string);
  }
  export function tex(source: string, options: { showConsole: boolean }, loader: BrowserResourceLoader): Promise<Uint8Array>;
  export function dvi2svg(dvi: Uint8Array, options: { disableSanitize: boolean; embedFontCss: boolean }): Promise<string>;
}

declare module "abcjs/src/api/abc_tunebook_svg.js" {
  const renderAbc: typeof import("abcjs").renderAbc;
  export default renderAbc;
}
