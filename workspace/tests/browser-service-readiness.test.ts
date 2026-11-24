/** Shipping helper readiness, with real loopback HTTP but no Electron/display. */
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { waitForBrowserService } from "../electron/browser-service-readiness.cjs";

const endpoint = (port: number) => `ws://127.0.0.1:${port}/devtools/browser/test-browser-id`;
const version = (port: number) => JSON.stringify({ webSocketDebuggerUrl: endpoint(port) });
const short = { timeoutMs: 250, requestTimeoutMs: 50, retryMs: 10 };

async function withEndpoint(
	reply: (request: http.IncomingMessage, response: http.ServerResponse, port: number) => void,
	test: (port: number, idle: () => Promise<void>) => Promise<void>,
) {
	let port = 0;
	const sockets = new Set<Socket>();
	const server = http.createServer((request, response) => reply(request, response, port));
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	const idle = async () => {
		const deadline = Date.now() + 1000;
		while (sockets.size && Date.now() < deadline) await delay(10);
		assert.equal(sockets.size, 0, "readiness left an HTTP connection open");
	};
	try { await test(port, idle); }
	finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe("browser-service shipping readiness", () => {
	it("waits for a TCP endpoint that starts listening after readiness began", async () => {
		const server = http.createServer((_req, res) => res.end(version(port)));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		let ready = false;
		const waiting = waitForBrowserService(port, { timeoutMs: 2000, requestTimeoutMs: 500, retryMs: 10 }).then((value) => { ready = true; return value; });
		try {
			await delay(40);
			assert.equal(ready, false, "announced readiness before the endpoint listened");
			await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
			assert.equal(await waiting, endpoint(port));
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("waits through delayed/non-200 startup and only accepts the exact CDP endpoint", async () => {
		let requests = 0;
		await withEndpoint((req, res, port) => {
			assert.equal(req.url, "/json/version");
			assert.equal(req.headers.host, `127.0.0.1:${port}`);
			if (++requests < 3) { res.writeHead(503); res.end(); }
			else setTimeout(() => res.end(version(port)), 20);
		}, async (port, idle) => {
			assert.equal(await waitForBrowserService(port, { ...short, timeoutMs: 2000 }), endpoint(port));
			assert.equal(requests, 3);
			await idle();
			await delay(40);
			assert.equal(requests, 3, "polling continued after readiness");
		});
	});

	it("retries malformed JSON and a missing browser WebSocket endpoint", async () => {
		let requests = 0;
		await withEndpoint((_req, res, port) => {
			requests++;
			res.end(requests === 1 ? "not json" : requests === 2 ? "{}" : version(port));
		}, async (port, idle) => {
			assert.equal(await waitForBrowserService(port, { ...short, timeoutMs: 2000 }), endpoint(port));
			assert.equal(requests, 3);
			await idle();
		});
	});

	it("rejects arbitrary, wrong-port, credentialed, and non-browser WebSocket URLs", async () => {
		const invalid = [
			"ws://example.com:1234/devtools/browser/id",
			"ws://127.0.0.1:1/devtools/browser/id",
			"wss://127.0.0.1:1234/devtools/browser/id",
			"ws://user:password@127.0.0.1:1234/devtools/browser/id",
			"ws://127.0.0.1:1234/devtools/page/id",
			"ws://127.0.0.1:1234/devtools/browser/id?query=1",
			"ws://127.0.0.1:1234/devtools/browser/id#fragment",
			"ws://127.0.0.1:1234/devtools/browser/",
		];
		let requests = 0;
		await withEndpoint((_req, res, port) => {
			const bad = invalid[requests++];
			res.end(bad ? JSON.stringify({ webSocketDebuggerUrl: bad.replaceAll(":1234", `:${port}`) }) : version(port));
		}, async (port, idle) => {
			assert.equal(await waitForBrowserService(port, { ...short, timeoutMs: 2000 }), endpoint(port));
			assert.equal(requests, invalid.length + 1);
			await idle();
		});
	});

	it("bounds response size and retries instead of accepting oversized data", async () => {
		let requests = 0;
		await withEndpoint((_req, res, port) => {
			res.end(++requests === 1 ? "x".repeat(16 * 1024 + 1) : version(port));
		}, async (port, idle) => {
			assert.equal(await waitForBrowserService(port, { ...short, timeoutMs: 2000 }), endpoint(port));
			assert.equal(requests, 2);
			await idle();
		});
	});

	it("fails within the readiness budget and retains the last HTTP failure", async () => {
		let requests = 0;
		await withEndpoint((_req, res) => { requests++; res.writeHead(503); res.end(); }, async (port, idle) => {
			const start = Date.now();
			await assert.rejects(waitForBrowserService(port, short), (error: Error) => {
				assert.match(error.message, /not ready within 250ms/);
				assert.match(String(error.cause), /CDP HTTP status 503/);
				return true;
			});
			assert.ok(Date.now() - start < 2000, "readiness exceeded its bounded budget");
			await idle();
			const stopped = requests;
			await delay(40);
			assert.equal(requests, stopped, "polling continued after timeout");
		});
	});

	it("destroys hung requests on the per-request and overall timeouts", async () => {
		let requests = 0;
		await withEndpoint(() => { requests++; }, async (port, idle) => {
			await assert.rejects(waitForBrowserService(port, short), /not ready within/);
			assert.ok(requests >= 2, "hung attempt was not bounded before the overall deadline");
			await idle();
		});
	});

	it("aborts a hung request on parent EOF and leaves no polling/connection behind", async () => {
		const controller = new AbortController();
		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => { started = resolve; });
		let requests = 0;
		await withEndpoint(() => { requests++; started(); }, async (port, idle) => {
			const waiting = waitForBrowserService(port, { signal: controller.signal });
			await requestStarted;
			controller.abort(new Error("parent EOF"));
			await assert.rejects(waiting, /parent EOF/);
			await idle();
			await delay(80);
			assert.equal(requests, 1);
		});
	});

	it("does not start any request if the parent already closed", async () => {
		const controller = new AbortController();
		controller.abort(new Error("parent EOF"));
		let requests = 0;
		await withEndpoint(() => { requests++; }, async (port) => {
			await assert.rejects(waitForBrowserService(port, { signal: controller.signal }), /parent EOF/);
			await delay(40);
			assert.equal(requests, 0);
		});
	});
});
