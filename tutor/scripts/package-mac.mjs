// npm run app → builds Tutor.app (its own name + bundle id, so macOS lists it as
// "Tutor" under Screen Recording), signs it ad-hoc and installs it to /Applications.
// npm run dist → the same build, not installed: zipped as release/Tutor-<version>-mac-<arch>.zip to share.
// Both bundle the Root Access farm, built from ROOT_ACCESS_DIR (default: ../root-access, then ~/Desktop/root-access).
import { execFileSync as run } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const out = path.join(root, "release", "Tutor.app")
const res = path.join(out, "Contents", "Resources")
const appDir = path.join(res, "app")
const sh = (cmd, args, opts = {}) => run(cmd, args, { stdio: "inherit", ...opts })

const dist = process.argv.includes("--dist")
sh("npm", ["run", "build"], { cwd: root })

// The farm game, built once here so the app can serve it without the root-access folder.
const farmSrc = [process.env.ROOT_ACCESS_DIR, path.join(root, "..", "root-access"), path.join(os.homedir(), "Desktop", "root-access")].find((d) => d && fs.existsSync(path.join(d, "package.json")))
if (farmSrc) sh("npm", ["run", "build"], { cwd: farmSrc })
else console.warn("No root-access folder found: this build won't include the farm.")

fs.rmSync(path.join(root, "release"), { recursive: true, force: true })
fs.mkdirSync(path.dirname(out), { recursive: true })
sh("ditto", [path.join(root, "node_modules/electron/dist/Electron.app"), out])
fs.rmSync(path.join(res, "default_app.asar"), { force: true })

// Identity
const plist = path.join(out, "Contents", "Info.plist")
const set = (key, type, value) => {
  try {
    run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist])
  } catch {
    run("/usr/libexec/PlistBuddy", ["-c", `Add :${key} ${type} ${value}`, plist])
  }
}
set("CFBundleName", "string", "Tutor")
set("CFBundleDisplayName", "string", "Tutor")
set("CFBundleIdentifier", "string", "com.windeckersoftware.tutor")
set("CFBundleShortVersionString", "string", pkg.version)
set("CFBundleVersion", "string", pkg.version)

// Icon: assets/icon.png (from `npx electron scripts/render-icon.cjs`) → iconset → icns
try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-icon-"))
  const png = path.join(root, "assets/icon.png")
  const set_ = path.join(tmp, "icon.iconset")
  fs.mkdirSync(set_)
  for (const s of [16, 32, 128, 256, 512]) {
    sh("sips", ["-z", s, s, png, "--out", path.join(set_, `icon_${s}x${s}.png`)], { stdio: "ignore" })
    sh("sips", ["-z", s * 2, s * 2, png, "--out", path.join(set_, `icon_${s}x${s}@2x.png`)], { stdio: "ignore" })
  }
  sh("iconutil", ["-c", "icns", set_, "-o", path.join(res, "electron.icns")])
} catch (err) {
  console.warn("Icon step skipped:", err.message)
}

// App code: the bundled main/preload + UI, plus the few packages loaded at runtime.
fs.mkdirSync(appDir, { recursive: true })
for (const dir of ["dist", "dist-electron"])
  fs.cpSync(path.join(root, dir), path.join(appDir, dir), { recursive: true, filter: (src) => !src.endsWith(".map") })
fs.copyFileSync(path.join(root, "scripts", "setup-linux-lab.sh"), path.join(appDir, "setup-linux-lab.sh"))
if (farmSrc) fs.cpSync(path.join(farmSrc, "dist"), path.join(appDir, "farm"), { recursive: true, filter: (src) => !src.endsWith(".map") })
// The Python visualizer (a local Python Tutor) from the lessons, for a copy of Tutor without them.
const vizSrc = [process.env.VIZ_PY, path.join(os.homedir(), "code-reading", "python", "viz.py")].find((f) => f && fs.existsSync(f))
if (vizSrc) {
  fs.mkdirSync(path.join(appDir, "viz"), { recursive: true })
  fs.copyFileSync(vizSrc, path.join(appDir, "viz", "viz.py"))
} else console.warn("No ~/code-reading/python/viz.py found: this build won't include the Python visualizer.")
// The native TypeScript compiler, for type-checking exercises and projects (tsc --strict).
const tsNative = path.join(root, "node_modules/@typescript/typescript-darwin-arm64")
if (fs.existsSync(tsNative)) fs.cpSync(tsNative, path.join(appDir, "vendor/typescript-native"), { recursive: true })
else console.warn("No native TypeScript compiler found: exercises won't be type-checked.")
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")).packages
const v = (name) => lock[`node_modules/${name}`].version
// node-pty: the Linux lab's live terminals (a native module with prebuilt binaries).
const runtime = ["@anthropic-ai/claude-agent-sdk", "@modelcontextprotocol/sdk", "@anthropic-ai/sdk", "zod", "node-pty"]
fs.writeFileSync(
  path.join(appDir, "package.json"),
  JSON.stringify({ name: pkg.name, productName: "Tutor", version: pkg.version, main: pkg.main, dependencies: Object.fromEntries(runtime.map((n) => [n, v(n)])) }, null, 2)
)
// --omit=optional skips the Agent SDK's bundled 200 MB Claude binary; Tutor uses your installed `claude`.
// Clean env: `npm run app` passes its own npm_config_* settings down, which this install rejects.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith("npm_")))
sh("npm", ["install", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: appDir, env: cleanEnv })

// --ignore-scripts also skips the step that marks node-pty's helper executable: do it here, before signing.
for (const d of ["build/Release", `prebuilds/darwin-${process.arch}`]) {
  const helper = path.join(appDir, "node_modules/node-pty", d, "spawn-helper")
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
}

sh("codesign", ["--force", "--deep", "--sign", "-", out])

if (dist) {
  const zip = path.join(root, "release", `Tutor-${pkg.version}-mac-${process.arch}.zip`)
  sh("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", out, zip])
  console.log(`\nShareable build: ${zip}`)
  process.exit(0)
}

// The main /Applications folder, so it shows up in System Settings' "+" picker; ~/Applications if that isn't writable.
const appsDir = (() => {
  try {
    fs.accessSync("/Applications", fs.constants.W_OK)
    return "/Applications"
  } catch {
    return path.join(os.homedir(), "Applications")
  }
})()
const installed = path.join(appsDir, "Tutor.app")
fs.rmSync(installed, { recursive: true, force: true })
fs.mkdirSync(path.dirname(installed), { recursive: true })
sh("ditto", [out, installed])
console.log(`\nInstalled ${installed}`)
