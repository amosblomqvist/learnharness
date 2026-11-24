const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

function startCheckoutServer(node, { log, onExit }) {
	const root = path.resolve(__dirname, "..");
	const child = spawn(node, [path.join(root, "scripts", "windows-checkout-server.cjs")], {
		cwd: root,
		env: { ...process.env, NODE_ENV: "development" },
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		windowsHide: true,
	});
	for (const output of [child.stdout, child.stderr]) {
		readline.createInterface({ input: output }).on("line", line => log(`checkout server: ${line}`));
	}
	const ready = new Promise((resolve, reject) => {
		const onMessage = message => {
			if (message?.type === "checkout-server-ready") {
				child.off("message", onMessage);
				resolve();
			} else if (message?.type === "checkout-server-error") {
				child.off("message", onMessage);
				reject(new Error(message.message));
			}
		};
		child.on("message", onMessage);
		child.on("error", reject);
		child.once("exit", (code, signal) => {
			const error = new Error(`The checkout server exited (${signal ?? code}).`);
			reject(error);
			onExit(error);
		});
	});
	return { child, ready };
}

module.exports = { startCheckoutServer };
