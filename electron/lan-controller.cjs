"use strict";
/**
 * LAN controller: owns the gateway lifecycle for electron/main.cjs and the IPC handlers.
 * Node builtins only; no Electron import, so it is testable under tsx.
 *
 *   const ctl = createLanController({ config, createGateway, targetPort, getSecret });
 *   await ctl.start();               // at app launch: binds when the config says enabled
 *   ctl.state()                      -> { enabled, port, hasPassword, running, error, urls } (never the hash or key)
 *   await ctl.setEnabled(bool)       // bind failure => saved enabled:false plus state().error
 *   await ctl.setPort(n)             // RangeError for an invalid port; restarts while running
 *   ctl.setPassword(str|null)        // no restart: the gateway reads config.getAuth() per request
 *   await ctl.close()                // app quit
 * `createGateway` is `createLanGateway` (injected so tests can fake it).
 */
const os = require("node:os");

function describeBindError(err, port) {
	if (err?.code === "EADDRINUSE") return `Port ${port} is already in use.`;
	if (err?.code === "EACCES") return `Port ${port} is not allowed on this computer.`;
	return `Could not listen on port ${port}: ${err?.message ?? err}`;
}

function createLanController({ config, createGateway, targetPort, getSecret, networkInterfaces = os.networkInterfaces }) {
	let gateway = null;
	let boundPort = null;
	let error = null;
	let chain = Promise.resolve();
	// Every lifecycle operation runs one at a time, so concurrent callers cannot race on the port.
	const serial = (fn) => {
		const run = chain.then(fn, fn);
		chain = run.catch(() => {});
		return run;
	};

	async function stop() {
		const gw = gateway;
		gateway = null;
		boundPort = null;
		await gw?.close();
	}

	async function bind() {
		await stop();
		const { port } = config.publicView();
		const gw = createGateway({ targetPort, getSecret, getAuth: config.getAuth });
		try {
			await gw.listen(port, "0.0.0.0");
			gateway = gw;
			boundPort = port;
			error = null;
		} catch (err) {
			config.setEnabled(false);
			error = describeBindError(err, port);
		}
	}

	return {
		start: () => serial(async () => {
			if (config.publicView().enabled) await bind();
		}),
		setEnabled: (enabled) => serial(async () => {
			config.setEnabled(enabled === true);
			if (enabled === true) await bind();
			else {
				error = null;
				await stop();
			}
		}),
		setPort: (port) => serial(async () => {
			config.setPort(port); // throws RangeError before anything changes
			if (gateway) await bind();
		}),
		setPassword: (password) => config.setPassword(password),
		close: () => serial(stop),
		state() {
			const { enabled, port, hasPassword } = config.publicView();
			const urls = boundPort === null ? [] : Object.values(networkInterfaces() ?? {})
				.flat()
				.filter((i) => i && i.family === "IPv4" && !i.internal)
				.map((i) => `http://${i.address}:${boundPort}`);
			return { enabled, port, hasPassword, running: boundPort !== null, error, urls };
		},
	};
}

module.exports = { createLanController };
