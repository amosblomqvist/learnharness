import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import net from "node:net";
import { localAppEnv } from "./local-app-env.mjs";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.LH_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid LH_PORT");
const available = await new Promise((resolve) => {
	const probe = net.createServer();
	probe.once("error", () => resolve(false));
	probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
});
if (!available) { console.error(`Port ${port} is already in use; stop the existing app or choose LH_PORT.`); process.exit(1); }
const env = { ...localAppEnv(root, port), NODE_ENV: "development" };
const next = spawn(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, stdio: "inherit", windowsHide: true });
let electron;
let stopping = false;
function stop() { stopping = true; next.kill(); electron?.kill(); }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
next.once("error", (error) => { console.error(error.message); process.exitCode = 1; stop(); });
next.once("exit", (code) => { if (!stopping && code) process.exitCode = code; stopping = true; electron?.kill(); });
const deadline = Date.now() + 120_000;
while (!stopping) {
	try {
		const ready = await fetch(`http://127.0.0.1:${port}/api/activity`, { signal: AbortSignal.timeout(2000) });
		if (ready.ok) break;
	} catch { /* Next is still starting. */ }
	if (Date.now() > deadline) { console.error("Next did not become ready within two minutes"); process.exitCode = 1; stop(); break; }
	await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!stopping) {
	const executable = createRequire(import.meta.url)("electron");
	const electronEnv = { ...env, LH_DEV_URL: `http://127.0.0.1:${port}` };
	delete electronEnv.ELECTRON_RUN_AS_NODE;
	electron = spawn(executable, ["."], { cwd: root, env: electronEnv, stdio: "inherit", windowsHide: true });
	electron.once("error", (error) => { console.error(error.message); process.exitCode = 1; stop(); });
	electron.once("exit", () => stop());
}
