// CODEX_PATH's stdio boundary: maintained ACP adapters do not yet forward
// thread/start.ephemeral. Keep LearnHarness rounds out of Codex chat history
// without moving CODEX_HOME or reading/copying any subscription credentials.
const { createRequire } = require("node:module");
const { existsSync, realpathSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { createInterface } = require("node:readline");
const spawn = require("cross-spawn");

function executable(command, env) {
	if (path.isAbsolute(command) || /[/\\]/.test(command)) return path.resolve(command);
	const extensions = process.platform === "win32" ? [...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";"), ""] : [""];
	for (const dir of (env.PATH ?? "").split(path.delimiter)) for (const extension of extensions) {
		const candidate = path.join(dir.replace(/^"|"$/g, ""), command + extension);
		if (existsSync(candidate)) return candidate;
	}
}

function nativeLaunch(adapter, explicit, env) {
	if (explicit) return { command: explicit, args: [] };
	const candidates = [...adapter.args.filter((arg) => /\.[cm]?js$/.test(arg) && path.isAbsolute(arg)), executable(adapter.command, env)];
	for (const file of candidates) {
		if (!file || !existsSync(file)) continue;
		const from = createRequire(realpathSync(file));
		try {
			// Resolve from the adapter's package so its compatible bundled
			// Codex version is retained, including global npm .cmd shims.
			const entry = from.resolve("@agentclientprotocol/codex-acp");
			return { command: process.execPath, args: [createRequire(entry).resolve("@openai/codex/bin/codex.js")] };
		} catch { /* A custom adapter may use an independently installed CLI. */ }
		try { return { command: process.execPath, args: [from.resolve("@openai/codex/bin/codex.js")] }; }
		catch { /* Try the next installed entry. */ }
	}
	const installed = executable("codex", env);
	if (installed) return { command: installed, args: [] };
	throw new Error("Install the Codex CLI or set CODEX_PATH to its executable to use nonpersistent ACP sessions.");
}

function run() {
	const adapter = JSON.parse(process.env.LH_CODEX_ADAPTER_LAUNCH);
	const launch = nativeLaunch(adapter, process.env.LH_CODEX_NATIVE_PATH, process.env);
	const acknowledgement = process.env.LH_CODEX_EPHEMERAL_ACK;
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("LH_CODEX_") || key === "CODEX_PATH") delete env[key];
	const child = spawn(launch.command, [...launch.args, ...process.argv.slice(2)], { env, windowsHide: true, stdio: "pipe" });
	const pending = new Set();
	const verified = new Set();
	const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
	const input = createInterface({ input: process.stdin });
	input.on("line", (line) => {
		try {
			const request = JSON.parse(line);
			if (request.method === "thread/start" || request.method === "thread/fork") {
				request.params = { ...request.params, ephemeral: true };
				pending.add(request.id);
			}
			if (!child.stdin.write(`${JSON.stringify(request)}\n`)) input.pause();
		} catch { console.error("Invalid Codex request; refusing to continue."); child.kill(); process.exitCode = 1; }
	});
	child.stdin.on("drain", () => input.resume());
	child.stdin.on("error", () => {});
	input.on("close", () => child.stdin.end());
	createInterface({ input: child.stdout }).on("line", (line) => {
		try {
			const response = JSON.parse(line);
			if (!response.method && pending.delete(response.id) && !response.error) {
				const thread = response.result?.thread;
				if (thread?.ephemeral !== true || typeof thread.id !== "string") {
					send({ id: response.id, error: { code: -32603, message: "Codex did not confirm a nonpersistent (ephemeral) thread. Update the Codex CLI; LearnHarness will not send a prompt to a stored chat." } });
					return;
				}
				verified.add(thread.id);
				writeFileSync(acknowledgement, JSON.stringify([...verified]), { mode: 0o600 });
			}
			send(response);
		} catch { console.error("Invalid Codex persistence acknowledgement; refusing to continue."); child.kill(); process.exitCode = 1; }
	});
	child.stderr.pipe(process.stderr);
	child.once("error", () => { console.error("Could not start the Codex CLI for nonpersistent ACP sessions."); process.exit(1); });
	child.once("exit", (code) => {
		// A surviving descendant must not hold the proxy alive by its pipes.
		setTimeout(() => process.exit(code ?? 1), 100).unref();
	});
	child.once("close", (code) => process.exit(code ?? 1));
}

if (require.main === module) {
	try { run(); } catch (error) { console.error(error.message); process.exit(1); }
}
module.exports = { nativeLaunch };
