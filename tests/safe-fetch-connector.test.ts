import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo, LookupFunction } from "node:net";
import { it } from "node:test";
import { createAddressCheckedAgent, isPublicAddress, safeFetch } from "../src/agent/tools/safe-fetch.ts";

// Public hostname strings are never resolved externally: every test injects
// a deterministic lookup and only contacts its own loopback listeners.
function lookup(next: () => string): LookupFunction {
	return (_hostname, options, callback) => {
		const address = next(), family = address.includes(":") ? 6 : 4;
		if (options.all) callback(null, [{ address, family }]);
		else callback(null, address, family);
	};
}

it("re-validates a changed DNS answer on a new connection", async () => {
	let hits = 0, lookups = 0;
	const server = http.createServer((_request, response) => {
		hits++;
		response.writeHead(200, { Connection: "close" });
		response.end("owned public-policy stand-in");
	});
	await new Promise<void>(resolve => server.listen(0, "::1", resolve));
	// A resolved non-public address must be refused before a socket is opened.
	let reboundSockets = 0;
	const rebound = http.createServer((_request, response) => { hits++; response.end("must not be read"); });
	rebound.on("connection", () => { reboundSockets++; });
	await new Promise<void>(resolve => rebound.listen((server.address() as AddressInfo).port, "127.0.0.1", resolve));
	const agent = createAddressCheckedAgent(address => address === "::1", {
		lookup: lookup(() => ++lookups === 1 ? "::1" : "127.0.0.1"),
	});
	try {
		const url = `http://research.invalid:${(server.address() as AddressInfo).port}/`;
		assert.equal(await (await safeFetch(url, {}, agent)).text(), "owned public-policy stand-in");
		await assert.rejects(safeFetch(url, {}, agent), /refusing to connect to a private or local address \(research\.invalid\)/);
		assert.equal(lookups, 2, "the second connection resolved the hostname again");
		assert.equal(reboundSockets, 0, "no socket opens to the rebound address");
		assert.equal(hits, 1, "only the first, allowed connection sent an HTTP request");
	} finally {
		await agent.close();
		await Promise.all([server, rebound].map(listener => new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))));
	}
});

it("HTTPS keeps certificate/SNI validation and refuses a non-public address before HTTP dispatch", async () => {
	const cert = readFileSync(new URL("./fixtures/security-tls/cert.pem", import.meta.url));
	const key = readFileSync(new URL("./fixtures/security-tls/key.pem", import.meta.url));
	let hits = 0, handshakes = 0;
	const names: (string | false | null)[] = [];
	const server = https.createServer({ cert, key }, (_request, response) => { hits++; response.end("owned TLS fixture"); });
	server.on("secureConnection", socket => { handshakes++; names.push(socket.servername); });
	server.on("tlsClientError", () => {}); // expected untrusted/name-mismatch controls
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const options = { ca: cert, lookup: lookup(() => "127.0.0.1") };
	const refused = createAddressCheckedAgent(isPublicAddress, options);
	const allowed = createAddressCheckedAgent(() => true, options);
	const untrusted = createAddressCheckedAgent(() => true, { lookup: options.lookup });
	try {
		const port = (server.address() as AddressInfo).port;
		await assert.rejects(safeFetch(`https://research.invalid:${port}/`, {}, refused), /refusing to connect to a private or local address \(research\.invalid\)/);
		assert.equal(hits, 0, "a refused address never sends an HTTP request");
		assert.equal(await (await safeFetch(`https://research.invalid:${port}/`, {}, allowed)).text(), "owned TLS fixture");
		assert.equal(hits, 1);
		assert.ok(handshakes >= 1, "the allowed request completed a real TLS handshake");
		assert.ok(names.every(name => name === "research.invalid"), "original SNI is retained");
		await assert.rejects(safeFetch(`https://wrong.invalid:${port}/`, {}, allowed), error => {
			const cause: unknown = typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
			assert.equal(typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined, "ERR_TLS_CERT_ALTNAME_INVALID");
			return true;
		});
		await assert.rejects(safeFetch(`https://research.invalid:${port}/`, {}, untrusted));
		assert.equal(hits, 1, "untrusted or wrong-name TLS never sends HTTP");
	} finally {
		await Promise.all([refused.close(), allowed.close(), untrusted.close()]);
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});

it("refuses when any resolved candidate is non-public, even if the first is allowed", async () => {
	// Both candidates are live and loopback: "::1" is the allowed stand-in,
	// "127.0.0.1" is the non-public address under test. A check that judged
	// only the winning or first candidate would connect to the refused one.
	let allowedHits = 0, privateHits = 0, allowedSockets = 0, privateSockets = 0;
	const allowedServer = http.createServer((_request, response) => { allowedHits++; response.end("allowed stand-in"); });
	allowedServer.on("connection", () => { allowedSockets++; });
	await new Promise<void>(resolve => allowedServer.listen(0, "::1", resolve));
	const port = (allowedServer.address() as AddressInfo).port;
	const privateServer = http.createServer((_request, response) => { privateHits++; response.end("must not be read"); });
	privateServer.on("connection", () => { privateSockets++; });
	await new Promise<void>(resolve => privateServer.listen(port, "127.0.0.1", resolve));
	const mixed: LookupFunction = (_hostname, options, callback) => {
		const candidates: [LookupAddress, LookupAddress] = [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }];
		if (options.all) callback(null, candidates);
		else callback(null, candidates[0].address, candidates[0].family);
	};
	const agent = createAddressCheckedAgent(address => address === "::1", { lookup: mixed });
	try {
		await assert.rejects(safeFetch(`http://research.invalid:${port}/`, {}, agent), /refusing to connect/);
		assert.deepEqual([allowedSockets, privateSockets], [0, 0], "refusal precedes any accepted TCP connection");
		assert.deepEqual([allowedHits, privateHits], [0, 0], "no HTTP request reaches either candidate");
	} finally {
		await agent.close();
		await Promise.all([allowedServer, privateServer].map(listener => new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))));
	}
});

it("an IP-literal host is judged before any connection is attempted", async () => {
	// The resolver is never consulted for an IP literal, so the pre-connect
	// check is the only gate in front of the socket.
	const agent = createAddressCheckedAgent(isPublicAddress, { lookup: lookup(() => "::1") });
	try {
		await assert.rejects(safeFetch("http://127.0.0.1:65535/", {}, agent), /refusing to connect to a private or local address \(127\.0\.0\.1\)/);
		await assert.rejects(safeFetch("http://[::1]:65535/", {}, agent), /refusing to connect to a private or local address \(::1\)/);
		await assert.rejects(safeFetch("http://169.254.169.254/latest/meta-data/", {}, agent), /refusing to connect to a private or local address \(169\.254\.169\.254\)/);
	} finally {
		await agent.close();
	}
	// Even a public literal goes through the injected policy, so the refusal
	// is the policy's and no socket is opened to prove it.
	const denying = createAddressCheckedAgent(() => false, { lookup: lookup(() => "::1") });
	try {
		await assert.rejects(safeFetch("http://8.8.8.8:80/", {}, denying), /refusing to connect to a private or local address \(8\.8\.8\.8\)/);
	} finally {
		await denying.close();
	}
});

it("a unix-socket connector is refused before dispatch", async () => {
	// The socket path is never dialled, so any value proves the guard; the IPC
	// option shape is what undici would hand the connector.
	const agent = createAddressCheckedAgent(() => true, { path: "unused-socket" });
	try {
		await assert.rejects(safeFetch("http://research.invalid:80/", {}, agent), /refusing to connect to a private or local address \(research\.invalid\)/);
	} finally {
		await agent.close();
	}
});
