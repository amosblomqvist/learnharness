// File tools for the API-key models (Claude API, Grok, OpenAI, Ollama).
// Everything is confined to the chosen workspace folder. Writer mode adds the
// two write tools; tutor mode can only look.
import { tool, type ToolSet } from "ai"
import { z } from "zod"
import fs from "node:fs/promises"
import path from "node:path"

const SKIP = new Set([".git", "node_modules", "dist", "dist-electron", "build", ".next", ".venv", "venv", "__pycache__", ".idea", ".pytest_cache", ".mypy_cache", "target", "coverage"])
const MAX_READ = 200_000

function inside(root: string, rel: string): string {
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Path is outside the project: ${rel}`)
  return abs
}

async function walk(root: string, dir: string, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (out.length >= limit) return
    if (SKIP.has(e.name) || (e.name.startsWith(".") && e.name !== ".env.example")) continue
    const abs = path.join(dir, e.name)
    const rel = path.relative(root, abs)
    if (e.isDirectory()) {
      out.push(rel + "/")
      await walk(root, abs, out, limit)
    } else out.push(rel)
  }
}

export function workspaceTools(root: string, canWrite: boolean): ToolSet {
  const tools: ToolSet = {
    list_files: tool({
      description: "List files in the project (or a sub-folder), skipping node_modules, .git, build output and virtualenvs.",
      inputSchema: z.object({ dir: z.string().default(".").describe("Folder relative to the project root") }),
      execute: async ({ dir }) => {
        const out: string[] = []
        await walk(root, inside(root, dir), out, 500)
        return out.length >= 500 ? out.join("\n") + "\n… (truncated at 500 entries)" : out.join("\n")
      }
    }),
    read_file: tool({
      description: "Read a text file from the project. Optionally a line range (1-based, inclusive).",
      inputSchema: z.object({
        path: z.string(),
        from: z.number().int().positive().optional(),
        to: z.number().int().positive().optional()
      }),
      execute: async ({ path: p, from, to }) => {
        const text = await fs.readFile(inside(root, p), "utf8")
        const lines = text.split("\n")
        const a = (from ?? 1) - 1
        const b = to ?? lines.length
        const slice = lines.slice(a, b).map((l, i) => `${String(a + i + 1).padStart(5)}  ${l}`).join("\n")
        return slice.length > MAX_READ ? slice.slice(0, MAX_READ) + "\n… (truncated, ask for a line range)" : slice
      }
    }),
    search_text: tool({
      description: "Search the project for a plain-text or regex pattern. Returns file:line: text matches.",
      inputSchema: z.object({ pattern: z.string(), regex: z.boolean().default(false) }),
      execute: async ({ pattern, regex }) => {
        const re = regex ? new RegExp(pattern) : null
        const files: string[] = []
        await walk(root, root, files, 5000)
        const hits: string[] = []
        for (const rel of files) {
          if (rel.endsWith("/") || hits.length >= 200) continue
          let text: string
          try {
            const buf = await fs.readFile(path.join(root, rel))
            if (buf.length > 1_000_000 || buf.includes(0)) continue
            text = buf.toString("utf8")
          } catch {
            continue
          }
          text.split("\n").forEach((line, i) => {
            if (hits.length < 200 && (re ? re.test(line) : line.includes(pattern))) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`)
          })
        }
        return hits.length ? hits.join("\n") : "No matches."
      }
    })
  }

  if (canWrite) {
    tools.write_file = tool({
      description: "Create or overwrite a file in the project with the complete new contents. Creates folders as needed.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path: p, content }) => {
        const abs = inside(root, p)
        const before = await fs.readFile(abs, "utf8").catch(() => null)
        await fs.mkdir(path.dirname(abs), { recursive: true })
        await fs.writeFile(abs, content)
        const n = content.split("\n").length
        return before === null ? `Created ${p} (${n} lines)` : `Rewrote ${p} (${before.split("\n").length} → ${n} lines)`
      }
    })
    tools.edit_file = tool({
      description: "Replace one exact, unique snippet in a project file. Use for small edits to big files; old_text must match exactly once.",
      inputSchema: z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }),
      execute: async ({ path: p, old_text, new_text }) => {
        const abs = inside(root, p)
        const text = await fs.readFile(abs, "utf8")
        const count = text.split(old_text).length - 1
        if (count !== 1) throw new Error(`old_text matched ${count} times in ${p}; it must match exactly once`)
        await fs.writeFile(abs, text.replace(old_text, () => new_text))
        return `Edited ${p}`
      }
    })
  }
  return tools
}
