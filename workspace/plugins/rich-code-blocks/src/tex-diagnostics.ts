export const TEX_ERROR_BYTES = 2048;

/** Diagnostics cross the worker boundary as bounded plain text, never markup or
 * a full TeX transcript. The host already renders errors beside the raw block. */
export function boundTexError(message: string): string {
  const clean = message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const bytes = new TextEncoder().encode(clean);
  return bytes.length <= TEX_ERROR_BYTES ? clean : new TextDecoder().decode(bytes.subarray(0, TEX_ERROR_BYTES - 3), { stream: true }) + "…";
}

export function texErrorMessage(error: unknown, source: string): string {
  const message = error instanceof Error ? error.message : "TeX rendering failed.";
  const log = error && typeof error === "object" && "texLog" in error && typeof error.texLog === "string" ? error.texLog : "";
  const lines = log.slice(0, 4096).split(/\r\n|[\r\n]/);
  const first = lines.findIndex(line => line.startsWith("! "));
  if (first < 0) return boundTexError(message);
  const details = [lines[first]!.slice(2).trim()];
  let lineNumber: number | undefined;
  let excerpt = "";
  for (const line of lines.slice(first + 1, first + 25)) {
    if (line.startsWith("! ")) break;
    const location = /^l\.(\d+)\s*(.*)/.exec(line);
    if (location) {
      // The pinned engine prepends exactly one newline. prepareTexSource keeps
      // authored line breaks intact, including removed class/style declarations.
      lineNumber = Number(location[1]) - 1;
      excerpt = location[2]!.replace(/^\.\.\./, "").trim();
      break;
    }
    if (details.length < 5 && line.trim() && !/^(See |Type |For |\s*\.\.\.|<)/.test(line)) details.push(line.trim());
  }
  const originalLine = lineNumber !== undefined && lineNumber > 0 ? source.split(/\r\n|[\r\n]/)[lineNumber - 1]?.trim() : undefined;
  // A package's own error can report a line in its .sty file. Only attribute
  // it to saved source when the engine's actual excerpt agrees with that line.
  const agrees = originalLine && excerpt && originalLine.replace(/\s+/g, " ").includes(excerpt.replace(/\s+/g, " "));
  const context = agrees ? ` Line ${lineNumber}: ${originalLine.slice(0, 400)}` : "";
  return boundTexError(`TeX compilation failed: ${details.join(" ")}${context}`);
}
