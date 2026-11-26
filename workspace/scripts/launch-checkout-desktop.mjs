/** Prepare the Windows or Linux checkout and hand its lifetime over to Electron. */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { assertNodeModulesUnlocked } from "./windows-node-modules-locks.mjs";
import checkoutRestart from "../electron/checkout-restart.cjs";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const origin = "http://localhost:3000";
const archive = "public/plugin-authoring/learnharness-plugins.zip";
const cache = `node_modules/.cache/learnharness-${process.platform === "win32" ? "windows" : "linux"}`;
const sdkName = `${cache}/plugin-sdk`;
const commonInputs = ["package.json", "package-lock.json", "scripts/launch-checkout-desktop.mjs"];
const projectInputs = ["package.json", "package-lock.json", "manifest.json", "README.md", "LICENSE", "THIRD-PARTY.md", "FSRS-LICENSE.txt", ".gitignore", "tsconfig.json", "src", "scripts", "tests", "licenses"];

/** Hash file contents, or with `contents: false` only sizes and modification times. */
export function fingerprint(workspace, names, { contents = true } = {}) {
	const hash = createHash("sha256");
	hash.update(`${process.platform}/${process.arch}/${process.versions.node}`);
	function visit(name) {
		const filename = path.join(workspace, name);
		const stat = lstatSync(filename, { throwIfNoEntry: false, bigint: !contents });
		hash.update(`\0${name}\0`);
		if (!stat) hash.update("missing");
		else if (stat.isDirectory()) {
			hash.update("directory");
			for (const entry of readdirSync(filename).sort()) visit(`${name}/${entry}`);
		} else if (stat.isFile()) {
			hash.update(`file:${stat.size}\0`);
			if (contents) hash.update(readFileSync(filename));
			else hash.update(`mtime:${stat.mtimeNs}`);
		} else throw new Error(`Refusing linked or special launcher file: ${filename}`);
	}
	for (const name of names) visit(name);
	return hash.digest("hex");
}

function runNode(args, cwd = root) {
	const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${path.basename(cwd)}: ${args.slice(1).join(" ") || args[0]} failed (${result.signal ?? result.status}).`);
}

function runNpm(args, cwd = root) {
	if (args[0] === "ci") {
		// npm ci deletes node_modules first. Windows cannot delete a loaded binary, so refuse
		// before that if a running process holds one. Linux deletes files that are in use.
		if (process.platform === "win32") assertNodeModulesUnlocked(path.join(cwd, "node_modules"));
		// Deprecation and install-script notices come from upstream packages and are not actionable here.
		args = [...args, "--loglevel=error"];
	}
	console.log(`[launcher] npm ${args.join(" ")}`);
	runNode([process.env.npm_execpath, ...args], cwd);
}

function readState(filename) {
	try { return JSON.parse(readFileSync(filename, "utf8")) ?? {}; }
	catch { return {}; }
}

/**
 * Reuse generated outputs while their input is unchanged. A size/mtime `stamp` avoids
 * re-reading the outputs each launch; the content `output` hash is checked only when
 * the stamp differs (first run, or files touched) and stays the key dependents use.
 */
export function cached(workspace, previous, input, outputNames, build) {
	if (previous?.input === input) {
		const stamp = fingerprint(workspace, outputNames, { contents: false });
		if (previous.stamp === stamp) return previous;
		if (previous.output === fingerprint(workspace, outputNames)) return { ...previous, stamp };
	}
	build();
	return { input, output: fingerprint(workspace, outputNames), stamp: fingerprint(workspace, outputNames, { contents: false }) };
}

function prepareDependencies() {
	const filename = path.join(root, cache, "state.json");
	const rootHash = fingerprint(root, commonInputs.slice(0, 2));
	let state = readState(filename);
	const required = ["node_modules/.package-lock.json", "node_modules/next/package.json", "node_modules/electron/package.json", "node_modules/typescript/package.json"];
	if (state.dependencies !== rootHash || required.some(name => !existsSync(path.join(root, name)))) {
		runNpm(["ci", "--include=dev"]);
		state = { dependencies: rootHash };
	}
	for (const directory of ["node_modules", "node_modules/.cache", cache]) {
		const filename = path.join(root, directory);
		mkdirSync(filename, { recursive: true });
		if (lstatSync(filename).isSymbolicLink()) throw new Error(`Refusing redirected launcher cache: ${filename}`);
	}
	const save = () => {
		const temporary = `${filename}.${randomUUID()}`;
		writeFileSync(temporary, JSON.stringify(state), { flag: "wx" });
		try { renameSync(temporary, filename); }
		finally { rmSync(temporary, { force: true }); }
	};
	save();
	return { state, save };
}

async function preparePlugins({ state, save }) {
	const { setupPlugins } = await import("./setup-plugins.mjs");
	const { buildCorePlugins, readCoreCatalog } = await import("./build-core-plugins.mjs");
	const { AUTHORING_DOCS, AUTHORING_EXAMPLES, AUTHORING_PROJECTS, buildPluginAuthoring } = await import("./build-plugin-authoring.mjs");
	const sdk = path.join(root, sdkName);
	const sdkInput = fingerprint(root, [...commonInputs, "scripts/build-plugin-types.mjs", "src", "lib", "components", "config.ts"]);
	state.sdk = cached(root, state.sdk, sdkInput, [sdkName], () => {
		// Generate into a new directory so a failed generation leaves the prior SDK intact.
		const stage = `${sdk}.${randomUUID()}`;
		try {
			runNode([path.join(root, "scripts/build-plugin-types.mjs"), stage]);
			if (existsSync(sdk)) {
				fingerprint(root, [sdkName]); // Reject junctions anywhere in the prior output before removing it.
				rmSync(sdk, { recursive: true });
			}
			renameSync(stage, sdk);
		} finally { rmSync(stage, { recursive: true, force: true }); }
	});
	save();
	const projects = readdirSync(path.join(root, "plugins"), { withFileTypes: true })
		.filter(entry => entry.isDirectory() && existsSync(path.join(root, "plugins", entry.name, "package.json")))
		.map(entry => `plugins/${entry.name}`).sort();
	const dependencyInput = fingerprint(root, [...commonInputs, "scripts/setup-plugins.mjs",
		...projects.flatMap(project => [`${project}/package.json`, `${project}/package-lock.json`])]);
	const dependencyKey = `${dependencyInput}:${state.sdk.output}`;
	const missing = projects.some(project => {
		const manifest = JSON.parse(readFileSync(path.join(root, project, "package.json"), "utf8"));
		return !existsSync(path.join(root, project, "node_modules/.package-lock.json")) ||
			(typeof manifest.scripts?.sdk === "string" &&
				(!existsSync(path.join(root, project, ".sdk/package.json")) ||
				!existsSync(path.join(root, project, "node_modules/learnharness-plugin-api/package.json"))));
	});
	if (state.pluginDependencies !== dependencyKey || missing) {
		setupPlugins(root, { run: runNpm, sharedSdk: sdk });
		state.pluginDependencies = dependencyKey;
		save();
	}
	const coreInput = fingerprint(root, [...commonInputs, "scripts/build-core-plugins.mjs", "core-plugins.json",
		...readCoreCatalog(root).flatMap(id => projectInputs.map(name => `plugins/${id}/${name}`))]);
	state.core = cached(root, state.core, `${coreInput}:${dependencyKey}`, ["core-plugins"], () => buildCorePlugins(root, { run: runNpm }));
	save();
	const authoringInput = fingerprint(root, [...commonInputs, "LICENSE", "skills/learnharness-plugins",
		"scripts/build-plugin-authoring.mjs", "scripts/build-plugin-api-reference.mjs", "scripts/install-plugin-local.mjs",
		...AUTHORING_DOCS.map(name => `docs/${name}`),
		...AUTHORING_EXAMPLES.flatMap(id => [`examples/plugins/${id}/README.md`, `examples/plugins/${id}/dist`]),
		...AUTHORING_PROJECTS.flatMap(id => projectInputs.map(name => `plugins/${id}/${name}`))]);
	state.authoring = cached(root, state.authoring, `${authoringInput}:${state.sdk.output}`, [archive, "dist/plugin-authoring"],
		() => buildPluginAuthoring({ root, sharedSdk: sdk }));
	save();
}

async function startDesktop() {
	console.log("[launcher] Checking the desktop runtime (downloads Electron if needed)...");
	const executable = require("electron");
	if (!existsSync(executable)) throw new Error("Electron's executable is missing. Run npx install-electron --no, then try again.");
	const env = { ...process.env, LH_DEV_URL: origin, LH_CHECKOUT_NODE: process.execPath };
	delete env.ELECTRON_RUN_AS_NODE;
	console.log("[launcher] Starting LearnHarness. The console closes when its window opens.");
	const desktop = spawn(executable, [root], { cwd: root, env, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
	let cancel;
	try {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => cancel(new Error("The desktop window did not open within three minutes.")), 180000);
			const interrupted = () => cancel(new Error("Desktop startup cancelled."));
			const exited = (code, signal) => cancel(new Error(`Desktop exited before its window opened (${signal ?? code}). See the desktop main.log.`));
			const message = payload => {
				if (payload?.type === "checkout-window-open") cancel();
				else if (payload?.type === "checkout-startup-error") cancel(new Error(payload.message));
			};
			cancel = error => {
				clearTimeout(timer);
				process.off("SIGINT", interrupted);
				desktop.off("exit", exited);
				desktop.off("message", message);
				if (error) reject(error);
				else resolve();
			};
			process.once("SIGINT", interrupted);
			desktop.once("exit", exited);
			desktop.once("error", cancel);
			desktop.on("message", message);
		});
	} finally {
		if (desktop.connected) desktop.disconnect();
		desktop.unref();
	}
}

async function main() {
	if (process.platform !== "win32" && process.platform !== "linux") throw new Error("This launcher is for Windows and Linux only.");
	const script = process.env.npm_lifecycle_event;
	const ownScript = process.platform === "win32" ? "desktop:windows" : "desktop:linux";
	if ((script === "desktop:windows" || script === "desktop:linux") && script !== ownScript) {
		throw new Error(`npm run ${script} is not for this platform. Use npm run ${ownScript}.`);
	}
	if (!process.versions.node.startsWith("26.")) throw new Error(`Node.js 26.x is required; found ${process.version}.`);
	const args = process.argv.slice(2);
	const restart = args.length === 1 && args[0] === "restart";
	if (args.length && !restart) throw new Error("Usage: learn [restart]");
	const npm = process.env.npm_execpath;
	if (!npm || !path.isAbsolute(npm) || path.basename(npm).toLowerCase() !== "npm-cli.js") {
		throw new Error(process.platform === "win32"
			? "Run Launch LearnHarness.cmd or npm run desktop:windows."
			: "Run Launch LearnHarness.desktop or npm run desktop:linux.");
	}
	process.env.NODE_ENV = "development";
	process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`;

	// The OS releases the checkout lock even when the launcher is terminated.
	const lock = createServer(socket => socket.destroy());
	await checkoutRestart.listenLocal(lock, checkoutRestart.checkoutAddress("checkout", root)).catch(error => {
		throw error.code === "EADDRINUSE" || error.code === "EACCES"
			? new Error("Another launcher is already preparing this checkout.") : error;
	});
	try {
		const started = performance.now();
		if (restart) {
			console.log("[launcher] Checking for a running LearnHarness desktop...");
			if (await checkoutRestart.requestStop(checkoutRestart.pipeName(root))) {
				console.log("[launcher] Previous LearnHarness desktop stopped.");
			}
		}
		const dependencies = prepareDependencies();
		console.log(`[launcher] Dependencies ready in ${((performance.now() - started) / 1000).toFixed(1)}s.`);
		const pluginsStarted = performance.now();
		await preparePlugins(dependencies);
		console.log(`[launcher] Plugins ready in ${((performance.now() - pluginsStarted) / 1000).toFixed(1)}s.`);
		await startDesktop();
		console.log(`[launcher] Window opened in ${((performance.now() - started) / 1000).toFixed(1)}s.`);
	} finally { lock.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch(error => {
		for (const line of error.message.split("\n")) console.error(`[launcher] ${line}`);
		process.exitCode = 1;
	});
}
