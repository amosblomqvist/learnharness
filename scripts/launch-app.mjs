import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { localAppEnv } from "./local-app-env.mjs";

const root = path.resolve(import.meta.dirname, "..");
const entry = path.join(root, ".next", "standalone", "server.js");
const port = Number(process.env.LH_PORT ?? 3005);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("LH_PORT must be a port number from 1 to 65535");
if (!existsSync(entry) || !existsSync(path.join(root, ".next", "standalone", "src", "agent", "acp", "windows-job.ps1"))) {
	console.error("Build the local app first:\n  npm run build -- --webpack\n  node scripts/build-server.mjs");
	process.exit(1);
}
const available = await new Promise((resolve) => {
	const probe = net.createServer();
	probe.once("error", () => resolve(false));
	probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
});
if (!available) {
	console.error(`Port ${port} is already in use. If LearnHarness is already open, visit http://127.0.0.1:${port}/chat/new.\nTo use another port in PowerShell: $env:LH_PORT='3006'; npm run app`);
	process.exit(1);
}
const env = { ...localAppEnv(root, port), NODE_ENV: "production" };
console.log(`Open LearnHarness: http://127.0.0.1:${port}/chat/new\nKeep this terminal open. Press Ctrl+C to stop.\nSaved app data: ${env.LH_DATA_DIR}`);
const child = spawn(process.execPath, [entry], { cwd: path.dirname(entry), env, stdio: "inherit", windowsHide: true });
const stop = () => { if (child.exitCode === null) child.kill(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 0; });
