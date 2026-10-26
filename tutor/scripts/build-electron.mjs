// Bundles the Electron main process and preload into dist-electron/*.cjs.
import { build, context } from "esbuild"

const opts = {
  // acp-bridge: what the IDE's AI chat runs to reach Tutor (see electron/acp-agent.ts).
  entryPoints: { main: "electron/main.ts", preload: "electron/preload.ts", "farm-preload": "electron/farm-preload.ts", "acp-bridge": "electron/acp-bridge.ts" },
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  // Loaded at runtime: electron itself, the Agent SDK (it ships its own files), and node-pty
  // (a native module, for the Linux lab's live terminals).
  external: ["electron", "@anthropic-ai/claude-agent-sdk", "node-pty"],
  logLevel: "info"
}

export async function watchElectron(onRebuild) {
  const ctx = await context({ ...opts, plugins: [{ name: "notify", setup: (b) => b.onEnd((r) => !r.errors.length && onRebuild()) }] })
  await ctx.watch()
  return ctx
}

if (import.meta.url === `file://${process.argv[1]}`) await build(opts)
