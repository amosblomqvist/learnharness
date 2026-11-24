/** Windows checkout launcher. Setup runs before the desktop startup deadline. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForDevServer } from "../electron/dev-server-readiness.cjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = "http://localhost:3000";
const require = createRequire(import.meta.url);
const setupFile = path.join(root, "node_modules", ".learnharness-windows-setup.json");
// npm and plugin build scripts must use the same Node as this launcher.
const env = { ...process.env, NODE_ENV: "development", PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}` };

function fingerprint(files) {
	const hash = createHash("sha256");
	hash.update(`${process.platform}/${process.arch}/${process.versions.node.split(".")[0]}`);
	for (const filename of files) hash.update(filename).update("\0").update(readFileSync(path.join(root, filename))).update("\0");
	return hash.digest("hex");
}

function runNpm(args) {
	console.log(`[launcher] npm ${args.join(" ")}`);
	const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, env, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw Error(`npm ${args.join(" ")} failed (${result.signal ?? result.status}). Fix the error above and double-click the launcher again.`);
}

function prepareDependencies() {
	let previous = {};
	try { previous = JSON.parse(readFileSync(setupFile, "utf8")); } catch { /* First launch or interrupted setup. */ }
	const rootHash = fingerprint(["package.json", "package-lock.json"]);
	const rootFiles = ["node_modules/.package-lock.json", "node_modules/next/package.json", "node_modules/concurrently/package.json", "node_modules/electron/package.json"];
	if (previous.root !== rootHash || rootFiles.some(filename => !existsSync(path.join(root, filename)))) {
		runNpm(["ci", "--include=dev"]);
		previous = { root: rootHash };
		writeFileSync(setupFile, JSON.stringify(previous));
	}
	const projects = readdirSync(path.join(root, "plugins"), { withFileTypes: true })
		.filter(entry => entry.isDirectory() && existsSync(path.join(root, "plugins", entry.name, "package.json")))
		.map(entry => `plugins/${entry.name}`).sort();
	const pluginHash = fingerprint(projects.flatMap(directory => [`${directory}/package.json`, `${directory}/package-lock.json`]));
	const missingPlugin = projects.some(directory => {
		const manifest = JSON.parse(readFileSync(path.join(root, directory, "package.json"), "utf8"));
		return !existsSync(path.join(root, directory, "node_modules", ".package-lock.json")) ||
			(typeof manifest.scripts?.sdk === "string" && !existsSync(path.join(root, directory, ".sdk", "package.json")));
	});
	if (previous.plugins !== pluginHash || missingPlugin) {
		runNpm(["run", "plugins:setup"]);
		writeFileSync(setupFile, JSON.stringify({ root: rootHash, plugins: pluginHash }));
	}
	// Electron 44 downloads its executable lazily on require, rather than npm ci.
	// Complete that download here, before the server readiness deadline starts.
	console.log("[launcher] Checking the desktop runtime (downloads Electron if needed)...");
	if (!existsSync(require("electron"))) {
		throw Error("Electron's executable is missing. Run npx install-electron --no, then try again.");
	}
}

async function checkPort() {
	await new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once("error", error => reject(error.code === "EADDRINUSE"
			? Error("localhost:3000 is already in use. Close the other LearnHarness launcher or server, then try again.") : error));
		probe.listen(3000, "localhost", () => probe.close(resolve));
	});
}

async function openDesktop() {
	console.log(`[launcher] Waiting for ${origin} (first startup may take a few minutes)...`);
	await waitForDevServer(origin, { timeoutMs: 180000 });
	const electronEnv = { ...env, LH_DEV_URL: origin };
	delete electronEnv.ELECTRON_RUN_AS_NODE;
	const desktop = spawn(require("electron"), [root], { cwd: root, env: electronEnv, stdio: "inherit" });
	await new Promise((resolve, reject) => {
		desktop.once("error", reject);
		desktop.once("exit", (code, signal) => code === 0 ? resolve() : reject(Error(`Desktop exited (${signal ?? code}).`)));
	});
}

async function main() {
	if (process.platform !== "win32") throw Error("This launcher is for Windows only.");
	if (process.versions.node.split(".")[0] !== "26") throw Error(`Node.js 26.x is required; found ${process.version}.`);
	if (process.argv[2] === "--electron") return openDesktop();
	if (!process.env.npm_execpath) throw Error("Run Launch LearnHarness.cmd or npm run desktop:windows.");
	await checkPort();
	prepareDependencies();
	const { default: concurrently } = await import("concurrently");
	console.log("[launcher] Starting LearnHarness. Closing the desktop app stops its server. Keep this console open; Ctrl+C stops both.");
	const { result } = concurrently([
		{ name: "server", command: `"${process.execPath}" "${process.env.npm_execpath}" run dev -- --port 3000`, env },
		{ name: "desktop", command: `"${process.execPath}" scripts/launch-windows-desktop.mjs --electron`, env },
	], { cwd: root, shell: process.env.ComSpec || "cmd.exe", killOthersOn: ["success", "failure"], successCondition: "first" });
	try { await result; }
	catch { throw Error("LearnHarness startup or shutdown failed. See the server/desktop error above."); }
}

main().catch(error => {
	console.error(`[launcher] ${error.message}`);
	process.exitCode = 1;
});
