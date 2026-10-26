// MCP servers from the settings JSON (same shape Claude Desktop / Cursor use):
// { "mcpServers": { "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] },
//                   "docs": { "type": "http", "url": "https://example.com/mcp" } } }
// JetBrains IDEs don't need an entry here: ide.ts finds them by itself. Brave Search is added
// automatically when a Brave key is saved.
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp"
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio"
import type { ToolSet } from "ai"

export type McpServer =
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> }
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }

export function parseMcpJson(json: string): Record<string, McpServer> {
  if (!json.trim()) return {}
  const parsed = JSON.parse(json)
  return (parsed.mcpServers ?? parsed) as Record<string, McpServer>
}

// Tools that change things. Tutor mode leaves these out so it can only look.
// Split names into words ("open_file_in_editor" → open, file, in, editor) so "editor" isn't "edit".
const WRITE_WORDS = new Set(["create", "write", "replace", "edit", "update", "delete", "remove", "rename", "reformat", "execute", "exec", "run", "build", "commit", "push", "terminal", "install", "apply", "patch", "move", "insert", "set", "send", "post", "drop"])
export function isWriteTool(name: string): boolean {
  return name
    .split(/[_\-.\s]+|(?=[A-Z])/)
    .map((w) => w.toLowerCase())
    .some((w) => WRITE_WORDS.has(w))
}

// Servers Tutor adds by itself. Brave Search (github.com/brave/brave-search-mcp-server) once a key is saved.
// Only the tools a coding tutor needs, to keep every request's tool list short.
const BRAVE_TOOLS = ["brave_web_search", "brave_news_search", "brave_llm_context"]
export function builtinServers(braveKey: string | undefined): Record<string, McpServer> {
  if (!braveKey) return {}
  return {
    brave: {
      command: "npx",
      args: ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"],
      env: { BRAVE_API_KEY: braveKey, BRAVE_MCP_ENABLED_TOOLS: BRAVE_TOOLS.join(" ") }
    }
  }
}

// Built-ins plus the user's own JSON (theirs wins on a name clash).
export function allServers(json: string, braveKey: string | undefined): Record<string, McpServer> {
  return { ...builtinServers(braveKey), ...parseMcpJson(json) }
}

let clients: { key: string; list: { name: string; client: MCPClient }[] } | null = null

async function connect(servers: Record<string, McpServer>) {
  const key = JSON.stringify(servers)
  if (clients?.key === key) return clients.list
  await closeMcp()
  const list: { name: string; client: MCPClient }[] = []
  for (const [name, cfg] of Object.entries(servers)) {
    try {
      const transport =
        "url" in cfg
          ? { type: cfg.type === "sse" ? ("sse" as const) : ("http" as const), url: cfg.url, headers: cfg.headers }
          : new StdioMCPTransport({ command: cfg.command, args: cfg.args, env: { ...process.env, ...cfg.env } as Record<string, string> })
      list.push({ name, client: await createMCPClient({ transport }) })
    } catch (err) {
      console.error(`[mcp] ${name} failed to connect:`, err)
    }
  }
  clients = { key, list }
  return list
}

export async function mcpTools(json: string, braveKey: string | undefined, canWrite: boolean): Promise<{ tools: ToolSet; errors: string[] }> {
  const errors: string[] = []
  let list
  try {
    list = await connect(allServers(json, braveKey))
  } catch (err) {
    return { tools: {}, errors: [`MCP settings are not valid JSON: ${(err as Error).message}`] }
  }
  const tools: ToolSet = {}
  for (const { name, client } of list) {
    try {
      const set = await client.tools()
      for (const [toolName, t] of Object.entries(set)) {
        if (!canWrite && isWriteTool(toolName)) continue
        tools[`${name}__${toolName}`] = t
      }
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`)
    }
  }
  return { tools, errors }
}

// For the Claude Agent SDK route: the exact "mcp__server__tool" names this mode may use.
export async function mcpAllowedNames(json: string, braveKey: string | undefined, canWrite: boolean): Promise<string[]> {
  const { tools } = await mcpTools(json, braveKey, canWrite)
  return Object.keys(tools).map((n) => `mcp__${n}`)
}

export async function closeMcp(): Promise<void> {
  if (!clients) return
  await Promise.allSettled(clients.list.map((c) => c.client.close()))
  clients = null
}
