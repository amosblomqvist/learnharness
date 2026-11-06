import type { PluginCodeBlockProps } from "learnharness-plugin-api";
import { CACHE_BYTES, CACHE_ENTRIES, LABELS, checkSource, checkSvgSize, type Language } from "./contract.ts";
import { sanitizeSvg } from "./svg.ts";
import { TexRunner } from "./tex-runner.ts";

export class RenderCache {
  private entries = new Map<string, { svg: string; bytes: number }>();
  private bytes = 0;
  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.svg;
  }
  set(key: string, svg: string): void {
    const bytes = new TextEncoder().encode(key + svg).byteLength;
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    if (bytes > CACHE_BYTES) return;
    this.entries.set(key, { svg, bytes }); this.bytes += bytes;
    while (this.entries.size > CACHE_ENTRIES || this.bytes > CACHE_BYTES) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest);
    }
  }
  clear(): void { this.entries.clear(); this.bytes = 0; }
}

async function smiles(source: string, signal: AbortSignal): Promise<string> {
  const { default: SmilesDrawer } = await import("rich-code-blocks-smiles");
  signal.throwIfAborted();
  // One molecule, not a reaction, disconnected fragment list, or multiline prose.
  const molecule = source.trim();
  if (/[\s.>]/.test(molecule)) throw new Error("Use one SMILES molecule per block, without prose or reaction notation.");
  return new Promise((resolve, reject) => SmilesDrawer.parse(molecule, tree => {
    try {
      const drawer = new SmilesDrawer.SvgDrawer({ scale: 1 });
      const svg = drawer.draw(tree, null, "light");
      // Replace the library's .element/.sub stylesheet with static attributes;
      // generated CSS rules never enter the page or leak into the host.
      const options = drawer.opts as { fontSizeLarge: number; fontSizeSmall: number; fontFamily: string };
      for (const node of svg.querySelectorAll(".element, .sub")) {
        node.setAttribute("font-size", `${node.classList.contains("sub") ? options.fontSizeSmall : options.fontSizeLarge}pt`);
        node.setAttribute("font-family", options.fontFamily);
      }
      resolve(new XMLSerializer().serializeToString(svg));
    } catch (error) { reject(error); }
  }, reject));
}

async function abc(source: string, signal: AbortSignal): Promise<string> {
  // Import only the visual rendering entry, not synth/MIDI/editor APIs. The build
  // omits its unused viewport resize listeners (documented in THIRD-PARTY.md).
  const { default: renderAbc } = await import("abcjs/src/api/abc_tunebook_svg.js");
  signal.throwIfAborted();
  for (const header of ["X", "M", "L", "K"]) if (!new RegExp(`^${header}:[\\t ]*\\S`, "m").test(source)) {
    throw new Error("ABC requires X:, M:, L: and K: headers.");
  }
  if ((source.match(/^X:/gm) ?? []).length !== 1) throw new Error("Use one ABC tune per block.");
  const target = document.createElement("div");
  const tunes = renderAbc(target, source, { staffwidth: 700, add_classes: false, selectTypes: false, dragging: false });
  const svg = target.querySelector("svg");
  if (tunes.length !== 1 || !svg || !svg.querySelector("path")) throw new Error("ABC did not produce a score.");
  return new XMLSerializer().serializeToString(svg);
}

export class RenderService {
  private readonly cache = new RenderCache();
  private tex?: TexRunner;
  private disposed = false;
  private readonly lifetimes = new Set<() => void>();

  stopTex(): void { this.tex?.dispose(); this.tex = undefined; }
  clearCache(): void { this.cache.clear(); }

  async mount(container: HTMLElement, block: PluginCodeBlockProps): Promise<() => void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const root = document.createElement("div");
    root.className = "rich-code-blocks";
    const raw = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = block.source; raw.append(code); root.append(raw);
    const dispose = () => {
      controller.abort(); this.lifetimes.delete(dispose);
      block.signal.removeEventListener("abort", abort); root.remove();
    };
    if (this.disposed || block.signal.aborted) { dispose(); return dispose; }
    this.lifetimes.add(dispose);
    block.signal.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener("abort", () => root.remove(), { once: true });
    container.append(root);
    if (block.incomplete) return dispose;
    try {
      const language = block.language as Language;
      checkSource(language, block.source);
      const key = language + "\0" + block.source;
      let output = this.cache.get(key);
      if (!output) {
        if (language === "smiles") output = await smiles(block.source, controller.signal);
        else if (language === "abc") output = await abc(block.source, controller.signal);
        else if (language === "tikz") {
          this.tex ??= new TexRunner(new URL("./assets/tex-worker.js", import.meta.url), new URL("./assets/tex/", import.meta.url));
          output = await this.tex.render(block.source, controller.signal);
        } else throw new Error("Unsupported code-block language.");
      }
      if (this.disposed || controller.signal.aborted) { dispose(); return dispose; }
      checkSvgSize(output);
      const label = language === "smiles" ? LABELS.chemicalStructures : language === "abc" ? LABELS.musicalNotation : LABELS.technicalDiagrams;
      const safe = sanitizeSvg(output, label);
      this.cache.set(key, output);
      root.classList.add("rich-code-blocks--rendered");
      root.replaceChildren(safe);
      return dispose;
    } catch (error) {
      const wasAborted = controller.signal.aborted;
      dispose();
      if (wasAborted || this.disposed) return dispose;
      throw error; // The public host renderer boundary supplies error + readable raw source.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const dispose of this.lifetimes) dispose();
    this.lifetimes.clear(); this.stopTex(); this.cache.clear();
  }
}
