/**
 * build-mobile.mjs — bundle the on-device backend for the phone build
 * (mobile Phase 0: the proof page in src/browser/spike/).
 *
 * The desktop server code runs unchanged in the browser. This script makes
 * that possible at bundle time:
 *   - Node built-ins resolve to src/browser/shims/* (fs → an in-memory tree
 *     persisted to IndexedDB; desktop-only modules → throw-on-call stubs);
 *   - `process` and `Buffer` globals are injected from the shims;
 *   - config.ts's `import.meta.url` is pinned to the virtual app root, so
 *     PATHS resolve inside the virtual file system;
 *   - `lh:routes` enumerates every app/api/**\/route.ts (lazy imports);
 *   - `lh:assets` embeds the agent prompt files read at runtime.
 *
 * Usage: node scripts/build-mobile.mjs [--outdir dist-mobile]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHIMS = path.join(ROOT, "src", "browser", "shims");
const VIRTUAL_ROOT = "/lh/app";

const argOut = process.argv.indexOf("--outdir");
const OUTDIR = path.resolve(ROOT, argOut > -1 ? process.argv[argOut + 1] : "dist-mobile");

const SHIM_FOR = {
	fs: "fs.ts",
	"fs/promises": "fs-promises.ts",
	path: "path.ts",
	"path/posix": "path.ts",
	os: "os.ts",
	crypto: "crypto.ts",
	url: "url.ts",
	buffer: "buffer.ts",
	process: "process.ts",
};
/** Built-ins with no phone equivalent: reachable only from desktop features. */
const UNSUPPORTED = [
	"child_process", "http", "https", "net", "tls", "dns", "worker_threads", "readline",
	"util", "module", "async_hooks", "stream", "stream/promises", "zlib", "events", "v8", "vm", "perf_hooks", "assert",
	"http2",
];
/** npm packages that are native binaries or Node servers. Each is reached
 *  only by a desktop feature (SVG/PDF rasterizing, headless Chrome, MCP
 *  stdio/HTTP servers, AWS Bedrock's HTTP/2 client). */
const STUB_PACKAGES = [
	"@resvg/resvg-js",
	"@napi-rs/canvas",
	"@silvia-odwyer/photon-node",
	"puppeteer-core",
	"@hono/node-server",
	"@smithy/node-http-handler",
	"electron-updater",
];

function walk(dir, keep) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full, keep));
		else if (keep(full)) out.push(full);
	}
	return out;
}

const toPosix = (p) => p.split(path.sep).join("/");

const phonePlugin = {
	name: "learnharness-phone",
	setup(build) {
		const builtin = new RegExp(`^(node:)?(${[...Object.keys(SHIM_FOR), ...UNSUPPORTED].map((m) => m.replace("/", "\\/")).join("|")})$`);
		build.onResolve({ filter: builtin }, (args) => {
			const name = args.path.replace(/^node:/, "");
			const shim = SHIM_FOR[name] ?? "unsupported.ts";
			return { path: path.join(SHIMS, shim) };
		});
		const stubbed = new RegExp(`^(${STUB_PACKAGES.map((p) => p.replace(/[/.]/g, "\\$&")).join("|")})(/.*)?$`);
		build.onResolve({ filter: stubbed }, () => ({ path: path.join(SHIMS, "unsupported.ts") }));

		build.onResolve({ filter: /^lh:(routes|assets)$/ }, (args) => ({ path: args.path, namespace: "lh-virtual" }));
		build.onLoad({ filter: /^lh:routes$/, namespace: "lh-virtual" }, () => {
			const files = walk(path.join(ROOT, "app", "api"), (f) => path.basename(f) === "route.ts").sort();
			const lines = files.map((file) => {
				const rel = toPosix(path.relative(path.join(ROOT, "app"), path.dirname(file)));
				return `\t{ path: ${JSON.stringify("/" + rel)}, load: () => import(${JSON.stringify(file)}) },`;
			});
			return { contents: `export const routes = [\n${lines.join("\n")}\n];\n`, loader: "js", resolveDir: ROOT };
		});
		build.onLoad({ filter: /^lh:assets$/, namespace: "lh-virtual" }, () => {
			const files = walk(path.join(ROOT, "src", "agent"), (f) => f.endsWith(".md"));
			const assets = Object.fromEntries(
				files.map((file) => [`${VIRTUAL_ROOT}/${toPosix(path.relative(ROOT, file))}`, fs.readFileSync(file, "utf-8")]),
			);
			return { contents: `export const assets = ${JSON.stringify(assets)};\n`, loader: "js" };
		});

		// config.ts derives ROOT from its own URL; pin it inside the virtual FS.
		build.onLoad({ filter: /[\\/]config\.ts$/ }, (args) => {
			if (args.path !== path.join(ROOT, "config.ts")) return undefined;
			const source = fs.readFileSync(args.path, "utf-8");
			return { contents: source.replaceAll("import.meta.url", JSON.stringify(`file://${VIRTUAL_ROOT}/config.ts`)), loader: "ts" };
		});
	},
};

fs.rmSync(OUTDIR, { recursive: true, force: true });

const result = await esbuild.build({
	absWorkingDir: ROOT,
	entryPoints: { "spike/main": path.join(ROOT, "src", "browser", "spike", "main.ts") },
	outdir: OUTDIR,
	entryNames: "[dir]/[name]",
	chunkNames: "chunks/[name]-[hash]",
	bundle: true,
	splitting: true,
	format: "esm",
	platform: "browser",
	target: ["es2022", "safari16"],
	conditions: ["browser", "import", "default"],
	mainFields: ["browser", "module", "main"],
	inject: [path.join(SHIMS, "globals.ts")],
	define: { global: "globalThis" },
	plugins: [phonePlugin],
	sourcemap: true,
	minify: process.argv.includes("--minify"),
	metafile: true,
	logLevel: "warning",
	logOverride: { "empty-import-meta": "silent" },
});

fs.copyFileSync(path.join(ROOT, "src", "browser", "spike", "index.html"), path.join(OUTDIR, "spike", "index.html"));
fs.writeFileSync(path.join(OUTDIR, "meta.json"), JSON.stringify(result.metafile));

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`[build-mobile] ${OUTDIR} — ${Object.keys(result.metafile.outputs).length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB (incl. sourcemaps)`);
