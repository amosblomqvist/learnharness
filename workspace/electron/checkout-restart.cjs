const { createHash } = require("node:crypto");
const { lstatSync, mkdirSync, realpathSync, rmSync } = require("node:fs");
const { createConnection, createServer } = require("node:net");
const path = require("node:path");

const stopRequest = "R";
const stopAccepted = "A";

/**
 * The per-user folder for Linux checkout sockets. XDG_RUNTIME_DIR is private to
 * the signed-in user; the subfolder must stay a real directory only they can open.
 */
function socketDirectory() {
	const runtime = process.env.XDG_RUNTIME_DIR;
	if (!runtime || !path.isAbsolute(runtime)) {
		throw new Error("XDG_RUNTIME_DIR is not set. Start LearnHarness from a desktop session.");
	}
	const directory = path.join(runtime, "learnharness");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid())) {
		throw new Error(`Refusing an unsafe LearnHarness socket folder: ${directory}`);
	}
	return directory;
}

/** A local IPC address for one checkout: a named pipe on Windows, a Unix socket on Linux. */
function checkoutAddress(kind, workspace) {
	const checkout = realpathSync(workspace);
	if (process.platform === "win32") {
		const key = kind === "restart"
			? createHash("sha256").update(`${(process.env.LOCALAPPDATA ?? "").toLowerCase()}\0${checkout.toLowerCase()}`).digest("hex")
			: createHash("sha256").update(checkout.toLowerCase()).digest("hex");
		return `\\\\.\\pipe\\learnharness-${kind === "restart" ? "restart" : "checkout"}-${key}`;
	}
	// Unix socket paths are limited to about 108 bytes, so the key is shortened.
	const key = createHash("sha256").update(checkout).digest("hex").slice(0, 32);
	return path.join(socketDirectory(), `${kind}-${key}.sock`);
}

function pipeName(workspace) {
	return checkoutAddress("restart", workspace);
}

/**
 * Listen on a local address. A Unix socket file outlives a crashed owner, so on
 * EADDRINUSE an address that refuses connections is removed and listened on again.
 */
function listenLocal(server, address) {
	const attempt = () => new Promise((resolve, reject) => {
		const failed = error => reject(error);
		server.once("error", failed);
		server.listen(address, () => {
			server.off("error", failed);
			resolve();
		});
	});
	return attempt().catch(error => {
		if (process.platform === "win32" || error.code !== "EADDRINUSE") throw error;
		return new Promise((resolve, reject) => {
			const probe = createConnection(address);
			probe.once("connect", () => {
				probe.destroy();
				reject(error);
			});
			probe.once("error", probeError => {
				if (probeError.code !== "ECONNREFUSED") return reject(error);
				const stat = lstatSync(address, { throwIfNoEntry: false });
				if (stat && !stat.isSocket()) return reject(new Error(`Refusing to replace a non-socket file: ${address}`));
				rmSync(address, { force: true });
				attempt().then(resolve, reject);
			});
		});
	});
}

function listenForStop(address, quit, log) {
	let quitting = false;
	const server = createServer(socket => {
		socket.unref();
		socket.setTimeout(1000, () => socket.destroy());
		socket.on("error", () => socket.destroy());
		socket.once("data", request => {
			if (request.toString() !== stopRequest) {
				socket.destroy();
				return;
			}
			socket.setTimeout(0);
			socket.write(stopAccepted, error => {
				if (error || quitting) return;
				quitting = true;
				quit();
			});
			// Keep the connection open. The OS closes it when Electron exits.
		});
	});
	return listenLocal(server, address).then(() => {
		server.on("error", error => log(`restart listener failed: ${error.message}`));
		server.unref();
		return server;
	});
}

function requestStop(address, timeoutMs = 30_000) {
	return new Promise((resolve, reject) => {
		let connected = false;
		let accepted = false;
		const socket = createConnection(address);
		const timer = setTimeout(() => {
			finish(new Error("LearnHarness did not shut down within 30 seconds."));
		}, timeoutMs);
		function finish(error, stopped) {
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(stopped);
		}
		socket.once("connect", () => {
			connected = true;
			socket.write(stopRequest);
		});
		socket.once("data", response => {
			accepted = response.toString() === stopAccepted;
			if (!accepted) finish(new Error("The checkout desktop returned an invalid restart response."));
		});
		socket.once("error", error => {
			if (!connected && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) finish(null, false);
			else if (accepted && error.code === "ECONNRESET") finish(null, true);
			else finish(error);
		});
		socket.once("end", () => {
			if (accepted) finish(null, true);
			else finish(new Error("The checkout desktop closed the restart connection before acknowledging it."));
		});
	});
}

module.exports = { checkoutAddress, listenForStop, listenLocal, pipeName, requestStop };
