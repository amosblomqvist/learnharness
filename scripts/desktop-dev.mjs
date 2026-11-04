/**
 * desktop-dev.mjs — `npm run desktop:dev`: `next dev` plus the Electron dev
 * shell, sharing one per-launch desktop secret so the desktop-only gates
 * (including local speech) behave as they do in the packaged app.
 *
 * Both children get the same LH_DESKTOP_API_SECRET; the dev server also gets
 * LH_DESKTOP_SERVER=1 and, when a speech runtime was prepared, its path.
 * Either child exiting stops the other.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");

/** A free loopback port: another dev server may already hold 3000. */
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
        srv.on("error", reject);
    });
}

const port = await freePort();
const secret = randomBytes(32).toString("hex");
const require = createRequire(import.meta.url);
const electron = require("electron");
const speechRuntime = path.join(ROOT, ".next", "speech-runtime");
const speechEnv = fs.existsSync(speechRuntime) ? { LH_SPEECH_RESOURCES: speechRuntime } : {};
const shared = { ...process.env, LH_DESKTOP_API_SECRET: secret };

const dev = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--port", String(port)], {
    cwd: ROOT,
    env: { ...shared, LH_DESKTOP_SERVER: "1", ...speechEnv },
    stdio: "inherit",
});
/** Open the window only once `next dev` answers, or the first load races the server. */
async function waitForServer(url, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { await fetch(url); return; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    throw new Error(`next dev did not respond at ${url}`);
}
await waitForServer(`http://localhost:${port}/`);
const shell = spawn(electron, ["."], {
    cwd: ROOT,
    env: { ...shared, LH_DEV_URL: `http://localhost:${port}` },
    stdio: "inherit",
});

const stop = () => { dev.kill(); shell.kill(); };
dev.on("exit", (code) => { shell.kill(); process.exitCode = code ?? 0; });
shell.on("exit", () => { dev.kill(); });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
