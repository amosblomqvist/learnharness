/**
 * The research fetch tools follow model-chosen URLs, and a fetched page can
 * steer the model. They must reach only public addresses: never loopback,
 * the LAN, or cloud metadata, whether named directly, by hostname, or
 * through a redirect. All servers here are local; nothing touches the network.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createPdfReadTools } from "../src/agent/tools/pdf-read.ts";
import { createAddressCheckedAgent, isPublicAddress, safeFetch } from "../src/agent/tools/safe-fetch.ts";
import { createWebTools } from "../src/agent/tools/web.ts";

function server(host: string, handler: http.RequestListener) {
	const state = { hits: 0, port: 0, close: () => {} };
	const srv = http.createServer((req, res) => {
		state.hits++;
		handler(req, res);
	});
	return new Promise<typeof state>((resolve) => {
		srv.listen(0, host, () => {
			state.port = (srv.address() as AddressInfo).port;
			state.close = () => srv.close();
			resolve(state);
		});
	});
}

async function runTool(tool: { execute: (id: string, input: unknown) => Promise<unknown> }, url: string): Promise<string> {
	const result = (await tool.execute("call-1", { url })) as { content: { type: string; text?: string }[] };
	return result.content.map((part) => part.text ?? "").join("");
}

describe("isPublicAddress", () => {
	it("refuses loopback, private, link-local, metadata and reserved ranges, in every spelling", () => {
		for (const ip of [
			"127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
			"169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
			"::1", "::", "fd00::1", "fc00::1", "fe80::1", "ff02::1", "64:ff9b::a00:1", "2002:a00:1::",
			"::ffff:127.0.0.1", "::ffff:10.0.0.1", "[::1]", "::FFFF:169.254.169.254",
			"not an ip", "",
		]) {
			assert.equal(isPublicAddress(ip), false, ip);
		}
	});

	it("allows public IPv4 and IPv6 addresses", () => {
		for (const ip of ["93.184.215.14", "8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8"]) {
			assert.equal(isPublicAddress(ip), true, ip);
		}
	});
});

describe("research fetch tools refuse local destinations", () => {
	let target: Awaited<ReturnType<typeof server>>;
	let dir: string;
	before(async () => {
		target = await server("127.0.0.1", (_req, res) => {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("internal secret");
		});
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-safe-fetch-"));
	});
	after(() => {
		target.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	for (const host of ["127.0.0.1", "localhost", "[::ffff:127.0.0.1]"]) {
		it(`web_fetch refuses http://${host}`, async () => {
			const text = await runTool(createWebTools(() => null).web_fetch!, `http://${host}:${target.port}/secret`);
			assert.match(text, /refusing to connect to a private or local address/);
			assert.doesNotMatch(text, /internal secret/);
		});
	}

	it("web_fetch_pdf refuses a local address", async () => {
		const text = await runTool(createPdfReadTools(dir).web_fetch_pdf!, `http://127.0.0.1:${target.port}/paper.pdf`);
		assert.match(text, /refusing to connect to a private or local address/);
	});

	it("no request ever reached the local server", () => {
		assert.equal(target.hits, 0);
	});
});

describe("redirects are checked at every hop", () => {
	it("an allowed page redirecting to a refused address is stopped before the second request", async () => {
		const secret = await server("127.0.0.1", (_req, res) => res.end("internal secret"));
		const bounce = await server("::1", (_req, res) => {
			res.writeHead(302, { location: `http://127.0.0.1:${secret.port}/secret` });
			res.end();
		});
		// Treat ::1 as "public" so the first hop is allowed; 127.0.0.1 stays refused.
		const agent = createAddressCheckedAgent((address) => address === "::1");
		try {
			await assert.rejects(safeFetch(`http://[::1]:${bounce.port}/start`, {}, agent), /refusing to connect to a private or local address/);
			assert.equal(bounce.hits, 1);
			assert.equal(secret.hits, 0);
		} finally {
			bounce.close();
			secret.close();
			await agent.close();
		}
	});

	it("allowed destinations fetch normally", async () => {
		const ok = await server("127.0.0.1", (_req, res) => res.end("hello"));
		const agent = createAddressCheckedAgent(() => true);
		try {
			const response = await safeFetch(`http://127.0.0.1:${ok.port}/`, {}, agent);
			assert.equal(response.status, 200);
			assert.equal(await response.text(), "hello");
		} finally {
			ok.close();
			await agent.close();
		}
	});
});
