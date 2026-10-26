import hljs from "highlight.js/lib/core"
import python from "highlight.js/lib/languages/python"
import typescript from "highlight.js/lib/languages/typescript"
import javascript from "highlight.js/lib/languages/javascript"
import bash from "highlight.js/lib/languages/bash"
import json from "highlight.js/lib/languages/json"
import yaml from "highlight.js/lib/languages/yaml"
import dockerfile from "highlight.js/lib/languages/dockerfile"
import sql from "highlight.js/lib/languages/sql"
import css from "highlight.js/lib/languages/css"
import xml from "highlight.js/lib/languages/xml"
import rust from "highlight.js/lib/languages/rust"
import go from "highlight.js/lib/languages/go"

const langs = { python, typescript, javascript, bash, json, yaml, dockerfile, sql, css, xml, rust, go }
for (const [name, def] of Object.entries(langs)) hljs.registerLanguage(name, def)
hljs.registerAliases(["py"], { languageName: "python" })
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" })
hljs.registerAliases(["js", "jsx", "mjs"], { languageName: "javascript" })
hljs.registerAliases(["sh", "shell", "zsh", "console"], { languageName: "bash" })
hljs.registerAliases(["html", "svg"], { languageName: "xml" })
hljs.registerAliases(["yml"], { languageName: "yaml" })
hljs.registerAliases(["docker"], { languageName: "dockerfile" })

// Returns escaped HTML (hljs escapes the source), safe for innerHTML.
export function highlight(code: string, lang?: string): string {
  if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  return hljs.highlightAuto(code, Object.keys(langs)).value
}
