import type { InkColor, Language } from "./contract.ts";

// Distinct variables retain the original paint when a definition is used by a
// mask, while ordinary visible ink follows the user's single color choice.
const NEUTRALS = [
  { color: "rgb(0, 0, 0)", original: "#000000", variable: "--rich-code-blocks-black" },
  { color: "rgb(34, 34, 34)", original: "#222222", variable: "--rich-code-blocks-carbon" },
  { color: "rgb(102, 102, 102)", original: "#666666", variable: "--rich-code-blocks-hydrogen" },
] as const;

export function setInkColor(root: HTMLElement, inkColor: InkColor): void {
  const value = inkColor === "white" ? "#ffffff" : "#000000";
  for (const neutral of NEUTRALS) root.style.setProperty(neutral.variable, value);
  root.dataset.inkColor = inkColor;
}

/** Theme only a freshly sanitized tree. No model-authored CSS is admitted.
 * Colored paint, white fills, opacity and structural masking remain intact.
 * TikZ gradients/patterns are intentional artwork, not ordinary neutral ink;
 * SMILES gradients instead carry the bond/atom palette and must follow its ink.
 */
export function prepareInk(svg: SVGSVGElement, language: Language): void {
  const elements = [svg, ...svg.querySelectorAll<SVGElement>("*")];
  const protectedElements = new Set<Element>();
  function inherited(element: Element, name: string, fallback: string): string {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const value = node.getAttribute(name);
      if (!value || ["inherit", "unset"].includes(value.toLowerCase())) continue;
      if (value.toLowerCase() === "currentcolor") {
        if (name === "color") continue;
        return inherited(element, "color", "#000000");
      }
      return value.toLowerCase() === "initial" ? fallback : value;
    }
    return fallback;
  }
  // Capture all original inherited paints BEFORE modifying any ancestor. Mask
  // luminance must not change when visible black ink becomes white. Freezing
  // paint-server inheritance also preserves authored gradients and patterns.
  const protectedRoots = elements.filter(element => element.localName === "mask" ||
    (language !== "smiles" && ["linearGradient", "radialGradient", "pattern"].includes(element.localName)))
    .map(element => ({ element, color: inherited(element, "color", "#000000"), fill: inherited(element, "fill", "#000000"), stroke: inherited(element, "stroke", "none") }));
  for (const { element, color, fill, stroke } of protectedRoots) {
    protectedElements.add(element);
    for (const child of element.querySelectorAll("*")) protectedElements.add(child);
    element.setAttribute("color", color);
    // currentColor needs the frozen original color, not the transcript ink.
    if (!element.hasAttribute("fill")) element.setAttribute("fill", fill);
    if (!element.hasAttribute("stroke")) element.setAttribute("stroke", stroke);
    for (const neutral of NEUTRALS) element.style.setProperty(neutral.variable, neutral.original);
  }
  const parser = document.createElement("span").style;
  const palette = language === "smiles" ? NEUTRALS : NEUTRALS.slice(0, 1);
  for (const element of elements) {
    if (protectedElements.has(element)) continue;
    for (const attribute of ["fill", "stroke", "color", "stop-color"]) {
      const paint = element.getAttribute(attribute);
      if (!paint) continue;
      parser.color = ""; parser.color = paint;
      const canonical = parser.color === "black" ? "rgb(0, 0, 0)" : parser.color;
      const neutral = palette.find(entry => entry.color === canonical);
      if (neutral) element.setAttribute(attribute, `var(${neutral.variable})`);
    }
  }
  // SVG's implicit fill is black, regardless of inherited CSS color.
  if (!svg.hasAttribute("fill")) svg.setAttribute("fill", "var(--rich-code-blocks-black)");
}
