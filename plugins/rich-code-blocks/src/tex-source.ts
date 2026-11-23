/** Compilation-only compatibility for the engine's fixed standalone format.
 * Keep line breaks intact so TeX's input line numbers still identify the saved
 * source. This scans literal preamble commands, not expanded TeX/macros. */
export function prepareTexSource(source: string): string {
  const removals: { start: number; end: number }[] = [];
  let depth = 0, brackets = 0;
  let documentStart: number | undefined;
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (char === "%") { i = commentEnd(source, i); continue; }
    if (char === "{") { depth++; i++; continue; }
    if (char === "}") { depth--; i++; continue; }
    if (depth === 0 && char === "[") { brackets++; i++; continue; }
    if (depth === 0 && char === "]") { brackets--; i++; continue; }
    if (char !== "\\") { i++; continue; }
    const start = i;
    const command = /^\\([a-zA-Z@]+|[^\r\n])/u.exec(source.slice(i));
    if (!command) { i++; continue; }
    i += command[0].length;
    if (depth !== 0 || brackets !== 0) continue;
    const name = command[1];
    if (["newcommand", "renewcommand", "providecommand", "DeclareRobustCommand"].includes(name!)) {
      // An unbraced command name is an argument, not a declaration to heal.
      const at = whitespace(source, source[i] === "*" ? i + 1 : i);
      const argument = /^\\[a-zA-Z@]+/.exec(source.slice(at));
      if (argument) i = at + argument[0].length;
      continue;
    }
    // These primitives can change tokenization or consume an unbraced command
    // as data. Do not guess at their expansion or rewrite what follows them.
    if (["catcode", "def", "gdef", "edef", "xdef", "let", "futurelet", "csname", "string", "verb", "begingroup", "bgroup"].includes(name!)) break;
    if (name === "begin") {
      const argument = group(source, whitespace(source, i), "{", "}");
      if (argument && argument.value === "document") { documentStart = start; break; }
      // Do not inspect literal/verbatim content or other environments.
      break;
    }
    if (name !== "documentclass" && name !== "documentstyle") continue;
    let at = whitespace(source, i);
    if (source[at] === "[") {
      const options = group(source, at, "[", "]");
      if (!options) break;
      at = whitespace(source, options.end);
    }
    const argument = group(source, at, "{", "}");
    if (!argument) break;
    let end = argument.end;
    const releaseAt = whitespace(source, end);
    if (source[releaseAt] === "[") {
      const release = group(source, releaseAt, "[", "]");
      if (!release) break;
      end = release.end;
    }
    removals.push({ start, end }); i = end;
  }
  // Work backwards: original offsets remain valid. No change to the caller's
  // source, cache key, transcript, or raw-source fallback.
  let prepared = source;
  if (documentStart !== undefined) {
    // Load AFTER authored package declarations, so e.g. amsmath[fleqn] or
    // mathtools keeps its options. Requiring an already loaded package with no
    // options is harmless. No extra newline means no diagnostic line drift.
    prepared = prepared.slice(0, documentStart) + "\\usepackage{amsmath}" + prepared.slice(documentStart);
  }
  for (const { start, end } of removals.reverse()) {
    prepared = prepared.slice(0, start) + source.slice(start, end).replace(/[^\r\n]/g, " ") + prepared.slice(end);
  }
  return prepared;
}

function commentEnd(source: string, at: number): number {
  while (at < source.length && source[at] !== "\n" && source[at] !== "\r") at++;
  return at;
}
function whitespace(source: string, at: number): number {
  while (at < source.length) {
    if (/\s/.test(source[at]!)) at++;
    else if (source[at] === "%") at = commentEnd(source, at);
    else break;
  }
  return at;
}
function group(source: string, start: number, open: string, close: string): { value: string; end: number } | undefined {
  if (source[start] !== open) return;
  let depth = 1, braces = 0, value = "";
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i]!;
    if (char === "%") { i = commentEnd(source, i) - 1; continue; }
    if (char === "\\") { value += char + (source[++i] ?? ""); continue; }
    // Braced option values may contain a literal closing square bracket.
    if (open === "[") {
      if (char === "{") braces++;
      if (char === "}") braces--;
    }
    if (braces === 0 && char === open) depth++;
    if (braces === 0 && char === close && --depth === 0) return { value, end: i + 1 };
    value += char;
  }
}
