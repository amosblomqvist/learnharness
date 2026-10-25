// This worker is assigned to a Windows Job Object before it can spawn the
// adapter. Inherited job membership owns descendants even after wrappers exit.
const fs = require("node:fs");
const { PassThrough } = require("node:stream");
const spawn = require("cross-spawn");

const input = new PassThrough();
process.stdin.pipe(input);
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(1));
const ready = process.env.LH_ACP_READY;
const launch = JSON.parse(process.env.LH_ACP_LAUNCH);
const deadline = Date.now() + 10_000;
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("LH_ACP_")) delete env[key];

function start() {
	if (!fs.existsSync(ready)) {
		if (Date.now() >= deadline) process.exit(1);
		setTimeout(start, 10);
		return;
	}
	const adapter = spawn(launch.command, launch.args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
	input.pipe(adapter.stdin);
	adapter.stdin.on("error", () => {});
	adapter.stdout.pipe(process.stdout);
	adapter.stderr.pipe(process.stderr);
	adapter.on("error", () => process.exit(1));
	adapter.on("exit", (code) => {
		// Drain final protocol output, but never await `close`: a descendant
		// can inherit a pipe and keep it open after its adapter has exited.
		const finish = () => process.stdout.write("", () => process.exit(code ?? 1));
		adapter.stdout.once("end", finish);
		if (adapter.stdout.readableEnded) finish();
		setTimeout(() => process.exit(code ?? 1), 100);
	});
}
start();
