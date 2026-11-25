const { createHash } = require("node:crypto");
const { realpathSync } = require("node:fs");
const { createConnection, createServer } = require("node:net");

const stopRequest = "R";
const stopAccepted = "A";

function pipeName(workspace) {
	const checkout = realpathSync(workspace).toLowerCase();
	const profile = (process.env.LOCALAPPDATA ?? "").toLowerCase();
	const key = createHash("sha256").update(`${profile}\0${checkout}`).digest("hex");
	return `\\\\.\\pipe\\learnharness-restart-${key}`;
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
			// Keep the connection open. Windows closes it when Electron exits.
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(address, () => {
			server.off("error", reject);
			server.on("error", error => log(`restart listener failed: ${error.message}`));
			server.unref();
			resolve(server);
		});
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

module.exports = { listenForStop, pipeName, requestStop };
