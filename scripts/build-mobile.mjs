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
 * It also builds the phone app itself (src/browser/app/): the desktop
 * components bundled as a single-page app, with `next/navigation` and
 * `next/link` resolved to a small client router, Tailwind compiled from
 * app/globals.css, and public/ copied alongside.
 *
 * Usage: node scripts/build-mobile.mjs [--outdir dist-mobile] [--minify]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

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

		// The components' Next.js surface (useRouter/usePathname/Link) → the
		// phone build's client router.
		build.onResolve({ filter: /^next\/(navigation|link)$/ }, () => ({ path: path.join(ROOT, "src", "browser", "app", "navigation.tsx") }));

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
			// The learner-files fragment teaches tools the phone build does not
			// have (config.ts LEARNER_FILES_AVAILABLE): leave it out.
			const files = walk(path.join(ROOT, "src", "agent"), (f) => f.endsWith(".md") && !f.endsWith(path.join("shared", "30-learner-files.md")));
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
	entryPoints: {
		"app/main": path.join(ROOT, "src", "browser", "app", "main.tsx"),
		"spike/main": path.join(ROOT, "src", "browser", "spike", "main.ts"),
	},
	outdir: OUTDIR,
	entryNames: "[dir]/[name]",
	chunkNames: "chunks/[name]-[hash]",
	assetNames: "assets/[name]-[hash]",
	loader: { ".woff2": "file", ".woff": "file", ".ttf": "file", ".svg": "file", ".png": "file" },
	jsx: "automatic",
	bundle: true,
	splitting: true,
	format: "esm",
	platform: "browser",
	target: ["es2022", "safari16"],
	conditions: ["browser", "import", "default"],
	mainFields: ["browser", "module", "main"],
	inject: [path.join(SHIMS, "globals.ts")],
	define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
	plugins: [phonePlugin],
	sourcemap: true,
	minify: process.argv.includes("--minify"),
	metafile: true,
	logLevel: "warning",
	logOverride: { "empty-import-meta": "silent" },
});

fs.copyFileSync(path.join(ROOT, "src", "browser", "spike", "index.html"), path.join(OUTDIR, "spike", "index.html"));

// The app shell: index.html at the root (the host serves it for every
// unknown path — single-page-app routing), public/ (fonts, worklets) and
// the phone-only static files (manifest, icons, service worker).
fs.copyFileSync(path.join(ROOT, "src", "browser", "app", "index.html"), path.join(OUTDIR, "index.html"));
fs.cpSync(path.join(ROOT, "public"), OUTDIR, { recursive: true });
const STATIC = path.join(ROOT, "src", "browser", "static");
if (fs.existsSync(STATIC)) fs.cpSync(STATIC, OUTDIR, { recursive: true });

// Tailwind: the same globals.css the desktop app compiles (its automatic
// source scan covers components/ and src/).
const cssFrom = path.join(ROOT, "app", "globals.css");
const css = await postcss([tailwind({ base: ROOT, optimize: process.argv.includes("--minify") })]).process(fs.readFileSync(cssFrom, "utf-8"), {
	from: cssFrom,
	to: path.join(OUTDIR, "app", "app.css"),
});
fs.writeFileSync(path.join(OUTDIR, "app", "app.css"), css.css);
fs.writeFileSync(path.join(OUTDIR, "meta.json"), JSON.stringify(result.metafile));

const bytes = fs.statSync(path.join(OUTDIR, "app", "app.css")).size + Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`[build-mobile] ${OUTDIR} — ${Object.keys(result.metafile.outputs).length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB (incl. sourcemaps)`);
