// Bundles scripts/check-study.ts and runs it with Node (see that file).
import { build } from "esbuild"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"

const out = path.join(os.tmpdir(), "tutor-check-study.cjs")
await build({ entryPoints: ["scripts/check-study.ts"], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "warning", external: ["electron", "node-pty"] })
const r = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: "inherit" })
process.exit(r.status ?? 1)
