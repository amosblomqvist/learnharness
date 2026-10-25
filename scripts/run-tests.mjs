import { readdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const files = args.some((arg) => /\.test\.tsx?$/.test(arg)) ? [] : readdirSync(path.join(root, "tests")).filter((name) => /\.test\.tsx?$/.test(name)).sort().map((name) => `tests/${name}`);
const child = spawn(process.execPath, ["--import", "tsx", "--test", ...args, ...files], {
	cwd: root, stdio: "inherit", env: { ...process.env, NODE_ENV: "test" },
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
