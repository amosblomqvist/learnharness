export const FAMILIES = ["chemicalStructures", "musicalNotation", "technicalDiagrams"] as const;
export type Family = typeof FAMILIES[number];
export type Language = "smiles" | "abc" | "tikz";
export interface Settings {
  version: 1;
  revision: number;
  chemicalStructures: boolean;
  musicalNotation: boolean;
  technicalDiagrams: boolean;
}
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  version: 1, revision: 0, chemicalStructures: false, musicalNotation: false, technicalDiagrams: false,
});
export const LANGUAGES: Record<Family, Language> = {
  chemicalStructures: "smiles", musicalNotation: "abc", technicalDiagrams: "tikz",
};
export const LABELS: Record<Family, string> = {
  chemicalStructures: "Chemical structures", musicalNotation: "Musical notation", technicalDiagrams: "Technical diagrams",
};
export const INSTRUCTIONS: Record<Family, string> = {
  chemicalStructures: "For chemical structures, use a smiles fenced code block containing one SMILES molecule. Write explanations outside the block; do not author raw SVG.",
  musicalNotation: "For musical notation, use an abc fenced code block containing one complete ABC tune with X:, M:, L: and K: headers. It renders a static score, not audio; do not author raw SVG.",
  technicalDiagrams: "For static technical diagrams, use a tikz fenced code block containing self-contained TeX with \\begin{document} and \\end{document}. The engine already supplies the standalone document class: never include \\documentclass or \\documentstyle. Before \\begin{document}, explicitly load all packages needed by that block: \\usepackage{tikz} for physics/free-body diagrams and geometry, \\usepackage{circuitikz} for circuit schematics (not simulation), \\usepackage{tikz-cd} for commutative diagrams, and \\usepackage{pgfplots} for analytic function plots. For math labels using \\text{...} or aligned equations, also load \\usepackage{amsmath}. Load needed TikZ libraries with \\usetikzlibrary in that same preamble. Bundled packages are available, not automatically loaded; do not rely on declarations from another block. Author notation, not raw SVG, JavaScript or external resources.",
};
export const SOURCE_LIMITS: Record<Language, number> = { smiles: 2 * 1024, abc: 16 * 1024, tikz: 32 * 1024 };
export const SVG_LIMIT = 2 * 1024 * 1024;
export const TEX_TIMEOUT_MS = 10_000;
export const TEX_QUEUE_LIMIT = 16;
export const CACHE_ENTRIES = 32;
export const CACHE_BYTES = 8 * 1024 * 1024;

export function parseSettings(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Rich code blocks settings.");
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("Unsupported Rich code blocks settings version; the saved file has not been changed.");
  if (Object.keys(record).some(key => !["version", "revision", "inkColor", ...FAMILIES].includes(key))) throw new Error("Unknown Rich code blocks settings fields.");
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0 || FAMILIES.some(key => typeof record[key] !== "boolean")) {
    throw new Error("Invalid Rich code blocks settings.");
  }
  // Legacy v1 inkColor is accepted above but deliberately omitted: theme Text
  // now owns neutral ink. Reads never rewrite disk; normal saves drop the key.
  return { version: 1, revision: record.revision as number, chemicalStructures: record.chemicalStructures as boolean,
    musicalNotation: record.musicalNotation as boolean, technicalDiagrams: record.technicalDiagrams as boolean };
}

export function parseChange(value: unknown): { family: Family; enabled: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A family and boolean enabled value are required.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !FAMILIES.includes(record.family as Family) || typeof record.enabled !== "boolean") {
    throw new Error("A known family and boolean enabled value are required.");
  }
  return { family: record.family as Family, enabled: record.enabled };
}

export function checkSource(language: Language, source: string): void {
  if (new TextEncoder().encode(source).byteLength > SOURCE_LIMITS[language]) throw new Error(`${language} source exceeds the ${SOURCE_LIMITS[language] / 1024} KiB limit.`);
  if (!source.trim()) throw new Error(`Empty ${language} source.`);
}

export function checkSvgSize(svg: string): void {
  if (new TextEncoder().encode(svg).byteLength > SVG_LIMIT) throw new Error("Rendered SVG exceeds the 2 MiB limit.");
}
