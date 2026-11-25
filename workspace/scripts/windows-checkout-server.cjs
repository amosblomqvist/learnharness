// A source-checkout server owned by Electron. Binding and readiness happen in
// the same process, so Electron never trusts an unrelated loopback listener.
const { createServer, get } = require("node:http");
const path = require("node:path");

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

/**
 * Request the home page once and discard it. Next compiles routes on first request
 * in development, so this overlaps the page compile with Electron creating the
 * window; the window's own request joins the compile already in progress.
 */
function warmHomePage(port, host = "127.0.0.1") {
	return new Promise(resolve => {
		const request = get({ host, port, path: "/", headers: { host: `${hostname}:${port}` } }, response => {
			response.resume();
			response.once("end", () => resolve(response.statusCode));
			response.once("error", () => resolve(undefined));
		});
		request.once("error", () => resolve(undefined));
	});
}

async function start() {
	if (!process.connected) throw new Error("The checkout server requires a connected desktop process.");
	const next = require("next");
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
	void warmHomePage(port);
	process.send({ type: "checkout-server-ready" });
}

if (require.main === module) start().catch(fail);

module.exports = { warmHomePage };
