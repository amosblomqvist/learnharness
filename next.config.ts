import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string; homepage: string };

const nextConfig: NextConfig = {
	// Public build metadata only; no new runtime Electron version API.
	env: { LH_VERSION: pkg.version, LH_HOMEPAGE: pkg.homepage },
	// Desktop target (Electron wrapper, 2026-09-17): standalone output = a
	// self-contained .next/standalone/server.js the Electron shell spawns
	// on 127.0.0.1. Harmless for plain web deploys (extra build output).
	// The manual copies the docs require — public/ and .next/static — are
	// done by scripts/build-server.mjs.
	output: "standalone",
	// SAFETY (empirically verified 2026-09-17): without this, output file
	// tracing sweeps the repo's real data/ — chat records, graph ledgers —
	// INTO the standalone bundle. A shipped desktop app would carry the
	// developer's session data inside it.
	//
	// SECRETS (2026-10-08, caught in the payload audit): the same sweep
	// ships the repo-root auth.json — the DEV BYOK key store — byte-identical
	// into the DMG (the packaged app never reads it: the shell passes
	// LH_AUTH_FILE → userData). Excluded here; build-server.mjs also REFUSES
	// to package any standalone still containing it. .env* belt-and-braces
	// the same class. Next also copies loaded bare .env after tracing;
	// the build-server refusal remains required even with these excludes.
	//
	// ⚠ EXCLUDE PATTERNS ARE LOAD-BEARING IN WAYS THE DOCS DON'T DESCRIBE
	// (empirically established 2026-10-08): adding dir excludes like
	// "dist/**/*" / "./dist/**/*" for repo-root output dirs STRIPPED THE
	// server-external packages (pi-ai / pi-agent-core lost everything
	// under their dist/ — the traced copy collapsed to a bare package.json
	// and the packaged server died on ERR_MODULE_NOT_FOUND; openai/
	// @anthropic-ai — pi-ai's deps — vanished from the trace entirely).
	// Anchored "./"-prefixed forms behave the same. **/data/**/* fixes
	// suffix matching in Next's JavaScript collector, but NOT its native
	// Turbopack tracer: that still prunes gcp-metadata and its private deps.
	// Keep the narrow closure workaround below AND the native runtime gate.
	// Real SDK data/ directories still need their explicit includes too.
	// The recursive-DMG payload (repo dist/ swept into the bundle, shipping
	// the previous build inside the next) is instead prevented by the
	// desktop:dist clean step AND targeted post-trace curation in
	// scripts/build-server.mjs (2026-10-11): remove standalone-root dist/
	// and node_modules/electron/ (the demo helper's DEV runtime; packaged
	// helpers use the app's own binary). Runtime dependencies' dist/ dirs
	// stay intact, and the script guards against leaked data/keys.
	outputFileTracingExcludes: {
		"*": [
			"**/data/**/*",
			"auth.json",
			"chatgpt-credentials.json*",
			"github-copilot-credentials.json*",
			"xai-credentials.json*",
			".env*",
		],
	},
	// Empirically verified gaps (2026-09-17 standalone smoke): the tracer
	// misses JSON loaded via `import ... with { type: "json" }` attributes —
	// pi-ai's provider catalog (39 JSON files) vanished from the trace and
	// the server 500s on module load. Include the whole data dirs of the
	// runtime-loaded engine packages.
	// pdfjs-dist (sources v0 live smoke, 2026-09-19): its legacy build loads
	// the node fake worker (pdf.worker.mjs) and our standard_fonts dir via
	// runtime-resolved paths — invisible to the tracer. Bundling (without
	// serverExternalPackages below) additionally breaks the worker's
	// import.meta.url resolution inside .next/dev chunks — the live smoke
	// caught it; unit tests run unbundled and never see it.
	outputFileTracingIncludes: {
		"*": [
			// The standalone trace omitted this entire runtime-imported directory
			// in 0.3.0, so importing puppeteer-core failed before browser startup.
			"node_modules/@puppeteer/browsers/lib/browser-data/**/*.js",
			"node_modules/pdfjs-dist/legacy/**/*",
			"node_modules/pdfjs-dist/standard_fonts/**/*",
			// Wave E (2026-10-10): pdf_render paints via @napi-rs/canvas — its
			// platform binary (@napi-rs/canvas-<platform>-<arch>) is a dynamic
			// optional-dep require the tracer cannot see. Builds run per-OS and
			// npm installs only the current platform's binary, so this glob
			// resolves to exactly one Skia binary per build.
			"node_modules/@napi-rs/canvas-*/**/*",
			// Pi-compatible image resizing runs in an unbundled worker. Photon
			// loads its colocated WASM through Node, also in packaged Electron.
			"src/agent/image-processing/*.mjs",
			"src/agent/image-processing/LICENSE",
			"node_modules/@silvia-odwyer/photon-node/**/*",
			// Wave E stage 2: resvg rasterizes visual-maker SVGs natively; same
			// per-platform-binary story as the canvas above (one per build).
			"node_modules/@resvg/resvg-js-*/**/*",
			"node_modules/@earendil-works/pi-ai/dist/providers/data/**/*",
			// Public native OAuth factories load these flows through variable imports.
			// Electron main uses the same standalone SDK; the offline runtime gate
			// evaluates their real toAuth paths without login or provider requests.
			"node_modules/@earendil-works/pi-ai/dist/auth/oauth/{load,github-copilot,xai,device-code}.js",
			"node_modules/@earendil-works/pi-ai/dist/utils/sleep.js",
			"node_modules/@earendil-works/pi-agent-core/dist/**/*.json",
			// Next 16.3.2 native Turbopack applies unanchored excludes while
			// traversing modules; **/data/**/* still prunes gcp-metadata and
			// its private runtime chain. Includes are applied after traversal.
			// This is the verified GoogleAuth closure, not a general dep copy;
			// the offline native Pi gate must catch future SDK closure changes.
			"node_modules/gcp-metadata/**/*",
			"node_modules/json-bigint/**/*",
			"node_modules/bignumber.js/**/*",
		],
	},
	// Framework-free core lives in src/ (plain TS, imported by routes and CLI alike).
	// The pi engine must stay external: its providers are runtime-loaded Node
	// code (undici streams, catalog data) that breaks when bundled into routes.
	serverExternalPackages: [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"pdfjs-dist", // sources v0: bundling breaks its node fake-worker path
		"@napi-rs/canvas", // native binding — bundling breaks the .node require
		"@silvia-odwyer/photon-node", // CJS loads its adjacent WASM from disk
		"@resvg/resvg-js", // native binding — same
	],
};

export default nextConfig;