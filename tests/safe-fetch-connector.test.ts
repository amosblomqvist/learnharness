import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo, LookupFunction } from "node:net";
import { it } from "node:test";
import { createAddressCheckedAgent, isPublicAddress, safeFetch } from "../src/agent/tools/safe-fetch.ts";

// Public hostname strings are never resolved externally. Only the owned
// loopback listeners below are contacted, via this deterministic lookup.
function lookup(next: () => string): LookupFunction {
	return (_hostname, options, callback) => {
		const address = next(), family = address.includes(":") ? 6 : 4;
		if (options.all) callback(null, [{ address, family }]);
		else callback(null, address, family);
	};
}

it("checks a hostname's actual peer again when DNS changes on a new connection", async () => {
	let hits = 0, lookups = 0;
	const server = http.createServer((_request, response) => {
		hits++;
		response.writeHead(200, { Connection: "close" });
		response.end("owned public-policy stand-in");
	});
	await new Promise<void>(resolve => server.listen(0, "::1", resolve));
	const rebound = http.createServer((_request, response) => { hits++; response.end("must not be read"); });
	await new Promise<void>(resolve => rebound.listen((server.address() as AddressInfo).port, "127.0.0.1", resolve));
	const agent = createAddressCheckedAgent(address => address === "::1", {
		lookup: lookup(() => ++lookups === 1 ? "::1" : "127.0.0.1"),
	});
	try {
		const url = `http://research.invalid:${(server.address() as AddressInfo).port}/`;
		assert.equal(await (await safeFetch(url, {}, agent)).text(), "owned public-policy stand-in");
		await assert.rejects(safeFetch(url, {}, agent), /refusing to connect/);
		assert.equal(lookups, 2);
		assert.equal(hits, 1, "second connection must not send an HTTP request");
	} finally {
		await agent.close();
		await Promise.all([server, rebound].map(listener => new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))));
	}
});

it("HTTPS preserves certificate/SNI validation and refuses a private peer before HTTP dispatch", async () => {
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
		await assert.rejects(safeFetch(`https://research.invalid:${port}/`, {}, refused), /refusing to connect/);
		assert.equal(hits, 0);
		assert.equal(await (await safeFetch(`https://research.invalid:${port}/`, {}, allowed)).text(), "owned TLS fixture");
		assert.equal(hits, 1);
		assert.ok(handshakes >= 1, "TLS contact is allowed before the HTTP policy check");
		assert.ok(names.every(name => name === "research.invalid"), "original SNI is retained");
		await assert.rejects(safeFetch(`https://wrong.invalid:${port}/`, {}, allowed), error => {
			assert.equal((error as { cause?: { code?: string } }).cause?.code, "ERR_TLS_CERT_ALTNAME_INVALID");
			return true;
		});
		await assert.rejects(safeFetch(`https://research.invalid:${port}/`, {}, untrusted));
		assert.equal(hits, 1, "untrusted or wrong-name TLS never sends HTTP");
	} finally {
		await Promise.all([refused.close(), allowed.close(), untrusted.close()]);
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});
