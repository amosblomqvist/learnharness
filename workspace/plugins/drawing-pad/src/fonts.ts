import { abortable } from "./abort.ts";

function unescapeCss(value: string): string {
  return value.replace(/\\([\da-f]{1,6})(?:\r\n|[ \t\n\r\f])?|\\([\s\S])/gi, (_match, hex: string | undefined, character: string | undefined) => {
    if (!hex) return character === "\n" || character === "\r" || character === "\f" ? "" : character!;
    const code = Number.parseInt(hex, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\ufffd" : String.fromCodePoint(code);
  });
}
/** CSS family lists may contain quoted commas and escaped quotes/commas. */
export function fontFamilies(value: string): string[] {
  const parts: string[] = []; let start = 0, quote = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === "\\") { index++; continue; }
    if (quote) { if (character === quote) quote = ""; }
    else if (character === '"' || character === "'") quote = character;
    else if (character === ",") { parts.push(value.slice(start, index)); start = index + 1; }
  }
  parts.push(value.slice(start));
  return parts.map(part => {
    const trimmed = part.trim(), quoted = trimmed.startsWith('"') || trimmed.startsWith("'");
    return unescapeCss(quoted ? trimmed.slice(1, -1) : trimmed.replace(/\s+/g, " ")).toLowerCase();
  }).filter(Boolean);
}
export interface CssUrl { start: number; end: number; url: string }
/** Read URL tokens, not lookalikes inside strings such as local("url(name)"). */
export function cssUrls(value: string): CssUrl[] {
  const urls: CssUrl[] = [];
  const stringEnd = (start: number) => {
    const quote = value[start]!; let index = start + 1;
    while (index < value.length) { if (value[index] === "\\") index += 2; else if (value[index++] === quote) break; }
    return index;
  };
  for (let index = 0; index < value.length;) {
    const character = value[index]!;
    if (character === '"' || character === "'") { index = stringEnd(index); continue; }
    if (value.slice(index, index + 4).toLowerCase() !== "url(" || (index > 0 && /[\w-]/.test(value[index - 1]!))) { index++; continue; }
    const start = index; index += 4;
    while (/\s/.test(value[index] ?? "") && index < value.length) index++;
    let raw: string;
    if (value[index] === '"' || value[index] === "'") {
      const end = stringEnd(index); raw = value.slice(index + 1, end - 1); index = end;
    } else {
      const contentStart = index;
      while (index < value.length && value[index] !== ")") { if (value[index] === "\\") index++; index++; }
      raw = value.slice(contentStart, index).trim();
    }
    while (/\s/.test(value[index] ?? "") && index < value.length) index++;
    if (value[index] !== ")") continue;
    index++; urls.push({ start, end: index, url: unescapeCss(raw) });
  }
  return urls;
}
function readDataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { reader.abort(); cleanup(); reject(signal.reason); };
    reader.onload = () => { cleanup(); if (typeof reader.result === "string") resolve(reader.result); else reject(new Error("Could not encode a reference font.")); };
    reader.onerror = () => { cleanup(); reject(reader.error ?? new Error("Could not read a reference font.")); };
    signal.addEventListener("abort", abort, { once: true }); reader.readAsDataURL(blob);
  });
}
/** Build detached font CSS from browser-parsed, already-loaded stylesheets.
 * Never fetch/parse an imported stylesheet or insert rules into the live page.
 * CSSImportRule.styleSheet has the browser-resolved URL for relative font assets. */
export async function referenceFontCSS(root: HTMLElement, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const document = root.ownerDocument, window = document.defaultView!;
  await abortable(document.fonts.ready, signal);
  const used = new Set<string>();
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const family of fontFamilies(window.getComputedStyle(element).fontFamily)) used.add(family);
    for (const pseudo of ["::before", "::after"]) {
      const style = window.getComputedStyle(element, pseudo);
      if (style.content && style.content !== "none" && style.content !== "normal") for (const family of fontFamilies(style.fontFamily)) used.add(family);
    }
  }
  const faces: { css: string; source: string; base: string }[] = [], seen = new Set<CSSStyleSheet>();
  const visitRules = (rules: CSSRuleList, base: string) => {
    for (const rule of rules) {
      if (rule.type === CSSRule.IMPORT_RULE) {
        const imported = (rule as CSSImportRule).styleSheet;
        if (imported) visitSheet(imported);
      } else if (rule.type === CSSRule.FONT_FACE_RULE) {
        const style = (rule as CSSFontFaceRule).style;
        if (fontFamilies(style.fontFamily).some(family => used.has(family))) faces.push({ css: style.cssText, source: style.getPropertyValue("src"), base });
      } else if ("cssRules" in rule) {
        if (rule.type === CSSRule.MEDIA_RULE && !window.matchMedia((rule as CSSMediaRule).conditionText).matches) continue;
        if (rule.type === CSSRule.SUPPORTS_RULE && !window.CSS.supports((rule as CSSSupportsRule).conditionText)) continue;
        visitRules((rule as CSSGroupingRule).cssRules, base);
      }
    }
  };
  const visitSheet = (sheet: CSSStyleSheet) => {
    if (seen.has(sheet) || sheet.disabled || (sheet.media.mediaText && !window.matchMedia(sheet.media.mediaText).matches)) return;
    seen.add(sheet);
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; }
    catch { throw new Error(`Could not inspect the font stylesheet ${sheet.href ?? "(inline)"}.`); }
    visitRules(rules, sheet.href ?? document.baseURI);
  };
  for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) visitSheet(sheet);
  const resources = new Map<string, Promise<string>>();
  const resource = (url: string): Promise<string> => {
    let pending = resources.get(url);
    if (!pending) {
      pending = (async () => {
        const response = await fetch(url, { signal });
        if (!response.ok || response.headers.get("content-type")?.toLowerCase().includes("text/html")) throw new Error(`Could not load a reference font (${response.status}).`);
        const blob = await response.blob();
        if (!blob.size) throw new Error("A reference font was empty.");
        return readDataUrl(blob, signal);
      })();
      resources.set(url, pending);
    }
    return pending;
  };
  const result = await Promise.all(faces.map(async face => {
    let source = "", offset = 0;
    for (const token of cssUrls(face.source)) {
      source += face.source.slice(offset, token.start);
      source += token.url.startsWith("data:") ? face.source.slice(token.start, token.end) : `url("${await resource(new URL(token.url, face.base).href)}")`;
      offset = token.end;
    }
    source += face.source.slice(offset);
    const detached = new window.CSSStyleSheet();
    detached.insertRule(`@font-face { ${face.css} }`);
    const rule = detached.cssRules[0] as CSSFontFaceRule;
    rule.style.setProperty("src", source);
    return rule.cssText;
  }));
  signal.throwIfAborted();
  return result.join("\n");
}
