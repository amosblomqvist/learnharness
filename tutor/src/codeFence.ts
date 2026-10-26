// Models sometimes put code into a card's text without a ``` fence; Markdown then joins its lines
// into one paragraph. This finds a run of code-looking lines at the end of the text and fences it,
// so it shows like in an IDE: one line per row, indentation kept, highlighted.

const KEYWORD = /^(def|class|import|from|return|print|for|while|if|elif|else|try|except|finally|with|async|await|const|let|var|function|export|type|interface|enum|console|assert|raise|yield|lambda|match|case|pass|break|continue|del|global|nonlocal|new|throw|switch)\b/
const isCodeLine = (l: string) =>
  /^(\s{2,}|\t)\S/.test(l) || // indented
  KEYWORD.test(l) ||
  /^(@\w|#|\/\/|>>> |\.\.\. )/.test(l) || // decorator, comment, REPL
  /^[}\])]/.test(l) || // closing bracket
  (/^[\w.[\]'"*]+(\s*,\s*[\w.*]+)*\s*(=|\+=|-=|\*=|\/=|\(|\[|\.)/.test(l) && !/[.?!]$/.test(l) && !/^\w+ \w+ \w+ /.test(l)) // assignment or call, not a sentence

function guessLang(code: string): string {
  if (/\b(interface|type)\s+\w+|:\s*(string|number|boolean)\b|<\w+>\(/.test(code)) return "typescript"
  if (/\b(const|let|function)\b|=>|console\.|;\s*$/m.test(code)) return "javascript"
  if (/^\s*(def|class|import|from|print|elif|async def)\b|:\s*$|\bNone\b|\bself\b/m.test(code)) return "python"
  return "text"
}

export function fenceCode(text: string): string {
  if (!text.includes("\n") || text.includes("```")) return text
  const lines = text.split("\n")
  // The code is the tail: from the first code line to the end, every line code or blank.
  const start = lines.findIndex(isCodeLine)
  if (start < 0) return text
  const tail = lines.slice(start)
  if (!tail.every((l) => !l.trim() || isCodeLine(l) || /^\s/.test(l))) {
    // Prose after the code: fence only up to the last code line, if the rest is a short sentence or two.
    let end = tail.length
    while (end > 0 && (!tail[end - 1].trim() || !isCodeLine(tail[end - 1]))) end--
    if (end < 2 || !tail.slice(0, end).every((l) => !l.trim() || isCodeLine(l) || /^\s/.test(l))) return text
    const code = tail.slice(0, end).join("\n")
    return [...lines.slice(0, start), "```" + guessLang(code), code, "```", ...tail.slice(end)].join("\n")
  }
  if (tail.filter((l) => l.trim()).length < 2) return text
  const code = tail.join("\n").replace(/\s+$/, "")
  return [...lines.slice(0, start), "```" + guessLang(code), code, "```"].join("\n")
}
