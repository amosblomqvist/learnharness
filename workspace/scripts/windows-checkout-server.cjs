// A source-checkout server owned by Electron. Binding and readiness happen in
// the same process, so Electron never trusts an unrelated loopback listener.
const { createServer } = require("node:http");
const path = require("node:path");
const next = require("next");

const hostname = "localhost";
const port = 3000;

function fail(error) {
	console.error(error);
	const message = error.code === "EADDRINUSE"
		? "localhost:3000 is already in use. Close the other server and try again."
		: error.message;
	process.send?.({ type: "checkout-server-error", message }, () => process.exit(1));
	if (!process.connected) process.exit(1);
}

async function start() {
	if (!process.connected) throw new Error("The checkout server requires a connected desktop process.");
	process.once("disconnect", () => process.exit(0));
	const server = createServer();
	const ipv6 = createServer();
	// Chromium and Node can choose different address families for localhost.
	// Both must reach the server this process owns, including HMR upgrades.
	ipv6.on("request", (...args) => server.emit("request", ...args));
	ipv6.on("upgrade", (...args) => {
		if (!server.emit("upgrade", ...args)) args[1].destroy();
	});
	const app = next({ dev: true, dir: path.resolve(__dirname, ".."), hostname, port, httpServer: server });
	await app.prepare();
	const handle = app.getRequestHandler();
	server.on("request", (request, response) => {
		void handle(request, response).catch(error => {
			console.error(error);
			if (response.headersSent) response.destroy();
			else response.writeHead(500).end("Internal Server Error");
		});
	});
	const listen = (listener, host) => new Promise((resolve, reject) => {
		listener.once("error", reject);
		listener.listen({ port, host, exclusive: true }, () => {
			listener.removeListener("error", reject);
			listener.on("error", fail);
			resolve();
		});
	});
	await Promise.all([
		listen(server, "127.0.0.1"),
		listen(ipv6, "::1").catch(error => {
			if (error.code !== "EAFNOSUPPORT" && error.code !== "EADDRNOTAVAIL") throw error;
		}),
	]);
	process.send({ type: "checkout-server-ready" });
}

start().catch(fail);
