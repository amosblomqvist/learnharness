/**
 * build-mobile.mjs — bundle the on-device backend for the phone build
 * (docs/mobile.md).
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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHIMS = path.join(ROOT, "src", "browser", "shims");
const VIRTUAL_ROOT = "/lh/app";

/** --minify = the deployable build: minified, no source maps, no metafile. */
const PROD = process.argv.includes("--minify");

/** AGPL-3.0 §13: the app links to the source of THIS build. LH_SOURCE_URL
 *  wins; else the checkout's origin remote (credentials stripped); else
 *  the upstream homepage from package.json. */
function sourceUrl() {
	if (process.env.LH_SOURCE_URL) return process.env.LH_SOURCE_URL;
	try {
		const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf-8" }).trim();
		const url = new URL(remote.replace(/^git@([^:]+):/, "https://$1/"));
		url.username = "";
		url.password = "";
		if (url.protocol === "https:") return url.href.replace(/\.git$/, "");
	} catch {
		// no git checkout or no origin
	}
	return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).homepage;
}

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
	define: { global: "globalThis", "process.env.NODE_ENV": '"production"', __LH_SOURCE_URL__: JSON.stringify(sourceUrl()) },
	plugins: [phonePlugin],
	sourcemap: !PROD,
	minify: PROD,
	metafile: true,
	logLevel: "warning",
	logOverride: { "empty-import-meta": "silent" },
});


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
const css = await postcss([tailwind({ base: ROOT, optimize: PROD })]).process(fs.readFileSync(cssFrom, "utf-8"), {
	from: cssFrom,
	to: path.join(OUTDIR, "app", "app.css"),
});
fs.writeFileSync(path.join(OUTDIR, "app", "app.css"), css.css);

// The service worker: versioned by the content of every file it caches
// first (hashed chunk names + the unhashed entry files), so any change to
// the app ships a new worker and a fresh cache.
const shell = appShell(result.metafile);
const version = createHash("sha256");
for (const out of Object.keys(result.metafile.outputs).sort()) version.update(out);
for (const file of ["index.html", "app/main.js", "app/main.css", "app/app.css", "manifest.webmanifest"]) {
	const full = path.join(OUTDIR, file);
	if (fs.existsSync(full)) version.update(fs.readFileSync(full));
}
fs.writeFileSync(
	path.join(OUTDIR, "sw.js"),
	fs
		.readFileSync(path.join(ROOT, "src", "browser", "app", "sw.template.js"), "utf-8")
		.replace("__LH_VERSION__", version.digest("hex").slice(0, 16))
		.replace("__LH_SHELL__", JSON.stringify(shell)),
);
if (!PROD) fs.writeFileSync(path.join(OUTDIR, "meta.json"), JSON.stringify(result.metafile));

/** The app shell for the service worker: the page, its styles, icons, and
 *  every chunk app/main.js imports STATICALLY (transitively) — what the app
 *  needs to start offline. Lazily imported chunks are cached on first use. */
function appShell(metafile) {
	const rel = (p) => "/" + toPosix(path.relative(OUTDIR, path.resolve(ROOT, p)));
	const byRel = new Map(Object.entries(metafile.outputs).map(([p, o]) => [rel(p), o]));
	const shell = new Set(["/", "/index.html", "/app/app.css", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png"]);
	const visit = (file) => {
		if (shell.has(file) || !byRel.has(file)) return;
		shell.add(file);
		const out = byRel.get(file);
		if (out.cssBundle) shell.add(rel(out.cssBundle));
		for (const imp of out.imports) if (imp.kind === "import-statement") visit(rel(imp.path));
	};
	visit("/app/main.js");
	return [...shell];
}

const bytes = fs.statSync(path.join(OUTDIR, "app", "app.css")).size + Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`[build-mobile] ${OUTDIR} — ${Object.keys(result.metafile.outputs).length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB (incl. sourcemaps)`);
