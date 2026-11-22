/**
 * build-server.mjs — curate the Electron shell's server payload.
 *
 * `next build` (output: "standalone") produces .next/standalone/ with
 * server.js + the traced node_modules subset, but leaves two pieces
 * outside that the docs require us to copy: public/ and .next/static/.
 * This script finishes the job and sanity-checks the result — including
 * the exclusion that keeps the repo's real data/ OUT of the bundle
 * (see next.config.ts outputFileTracingExcludes). It also removes exact
 * build-only paths the tracer sweeps in: plugin authoring projects,
 * old installers and the development Electron runtime. Broad trace exclusions break externals.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { validateCorePackages } from "./build-core-plugins.mjs";
import { buildPluginAuthoring } from "./build-plugin-authoring.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");

const copyTree = (from, to) => {
	fs.cpSync(from, to, { recursive: true });
};

const exists = (p) => fs.existsSync(p);

if (!exists(path.join(STANDALONE, "server.js"))) {
	console.error("[build-server] .next/standalone/server.js missing — run `next build` first (output: 'standalone').");
	process.exit(1);
}

// 1) Static assets: public/ → standalone/public, .next/static → standalone/.next/static
const staticFrom = path.join(ROOT, ".next", "static");
const staticTo = path.join(STANDALONE, ".next", "static");
if (!exists(staticFrom)) {
	console.error("[build-server] .next/static missing — the build looks incomplete.");
	process.exit(1);
}
copyTree(staticFrom, staticTo);
if (exists(path.join(ROOT, "public"))) {
	copyTree(path.join(ROOT, "public"), path.join(STANDALONE, "public"));
}

// 2) Safety: the repo's real data/ must NEVER ride along in the bundle.
const leakedData = path.join(STANDALONE, "data");
if (exists(leakedData)) {
	console.error("[build-server] REFUSING: standalone contains a data/ directory — repo session data would ship in the app.");
	console.error("             Check outputFileTracingExcludes in next.config.ts.");
	process.exit(1);
}

// 2b) Safety: the repo's dev SECRETS must never ride along either — the
// same trace sweep that catches data/ shipped the repo-root auth.json
// (the DEV BYOK key store, 0600) byte-identical into the DMG (caught in
// the 2026-10-08 payload audit; excluded in next.config.ts — this guard
// makes a regression loud instead of silent).
const subscriptionSecrets = fs.readdirSync(STANDALONE).filter((name) => /^(chatgpt|github-copilot|xai)-credentials\.json/.test(name));
for (const secret of ["auth.json", ...subscriptionSecrets, ".env", ".env.local"]) {
	if (exists(path.join(STANDALONE, secret))) {
		console.error(`[build-server] REFUSING: standalone contains ${secret} — dev secrets would ship in the app.`);
		console.error("             Check outputFileTracingExcludes in next.config.ts.");
		process.exit(1);
	}
}

// Assemble plugin assets only after refusing unsafe traced data/credentials.
// Runtime native plugin loader is deliberately outside Next's module graph.
// Copy it explicitly: external plugin entries must be loaded by native Node,
// not interpreted as build-time imports by webpack/Turbopack.
copyTree(path.join(ROOT, "scripts", "plugin-loader.cjs"), path.join(STANDALONE, "scripts", "plugin-loader.cjs"));
try {
	const core = path.join(ROOT, "core-plugins"), packagedCore = path.join(STANDALONE, "core-plugins");
	validateCorePackages(ROOT, core);
	fs.rmSync(packagedCore, { recursive: true, force: true });
	copyTree(core, packagedCore);
	validateCorePackages(ROOT, packagedCore);
} catch (error) {
	console.error("[build-server] REFUSING: Core plugin payload is missing or unsafe. Run npm run plugins:build-core.", error);
	process.exit(1);
}

// Reassemble from current source, never reuse a potentially stale dev download.
// Ship the complete portable skill plus its static ZIP; no application toolchain.
buildPluginAuthoring({ root: ROOT, standalone: true });

// 2c) Payload curation (2026-10-11): the trace sweep can copy repo-root
// plugins/ (authoring sources/tests), dist/ (previous installers), and the development Electron
// runtime (the demo helper's dev-only require). Neither belongs in the
// server: packaged helpers use process.execPath, the app's own binary.
// Remove ONLY these standalone-root paths AFTER tracing — excluding a
// generic dist/** earlier broke pi-ai / pi-agent-core's runtime dist/.
// Never touch ROOT/dist or ROOT/node_modules/electron (the running app
// and the build runtime); native canvas/resvg packages stay untouched.
for (const extra of ["plugins", "dist", path.join("node_modules", "electron")]) {
	const target = path.join(STANDALONE, extra);
	if (exists(target)) {
		fs.rmSync(target, { recursive: true, force: true });
		console.log(`[build-server] removed build-only payload: ${extra}`);
	}
}

// 2d) External-module links (#897): Turbopack reaches each server external
// that the project root cannot resolve through .next/node_modules/<name>-<hash>,
// a symlink to the traced package. The Windows installer copies that link as
// a plain directory, so the package then finds its dependencies only by
// walking up to standalone/node_modules. That works when the target is a
// top-level package there. A nested target (0.7.0: shiki under
// @streamdown/code/node_modules) loses its sibling dependencies. The server
// 500s on Windows while every symlink-preserving smoke passes.
const externalLinks = (directory) =>
	!exists(directory)
		? []
		: fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
				const full = path.join(directory, entry.name);
				if (entry.isSymbolicLink()) return [full];
				return entry.isDirectory() && entry.name.startsWith("@") ? externalLinks(full) : [];
			});
const tracedModules = path.join(fs.realpathSync(STANDALONE), "node_modules");
for (const link of externalLinks(path.join(STANDALONE, ".next", "node_modules"))) {
	let target;
	try {
		target = path.relative(tracedModules, fs.realpathSync(link));
	} catch {
		target = "(missing)";
	}
	const parts = target.split(path.sep);
	const topLevel = !path.isAbsolute(target) && parts[0] !== ".." && parts.length === (parts[0].startsWith("@") ? 2 : 1);
	if (!topLevel) {
		console.error(`[build-server] REFUSING: external module link ${path.relative(STANDALONE, link)} → node_modules/${target} is not a top-level package.`);
		console.error("             Installers that copy links as directories leave it unable to load its nested dependencies.");
		console.error("             Make the package resolvable from the project root (e.g. a direct dependency).");
		process.exit(1);
	}
}

// 3) Sanity: the runtime-read prompt assets must be present (the teacher
//    agent reads them from disk at request time).
for (const asset of [
	path.join("scripts", "plugin-loader.cjs"),
	path.join("public", "plugin-loader.js"),
	path.join("src", "agent", "system-prompt.md"),
	path.join("src", "agent", "prompts", "teacher", "20-teaching.md"),
	path.join("src", "agent", "prompts", "side-chat", "00-base.md"),
	path.join("src", "agent", "prompts", "side-chat", "90-style.md"),
]) {
	if (!exists(path.join(STANDALONE, asset))) {
		console.error(`[build-server] prompt asset missing from the trace: ${asset}`);
		process.exit(1);
	}
}

console.log("[build-server] server payload ready:", STANDALONE);