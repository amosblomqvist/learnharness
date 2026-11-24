/** Launcher startup shortcuts: the output stamp cache and the checkout server's home-page warm-up. */
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { cached, fingerprint } from "../scripts/launch-windows-desktop.mjs";

const { warmHomePage } = createRequire(import.meta.url)("../scripts/windows-checkout-server.cjs") as {
	warmHomePage: (port: number, host?: string) => Promise<number | undefined>;
};

function workspace(t: TestContext) {
	const directory = mkdtempSync(path.join(tmpdir(), "learnharness-launcher-cache-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	mkdirSync(path.join(directory, "out", "nested"), { recursive: true });
	writeFileSync(path.join(directory, "out", "a.js"), "alpha");
	writeFileSync(path.join(directory, "out", "nested", "b.js"), "beta");
	let builds = 0;
	const build = () => { builds++; };
	return { directory, build, builds: () => builds };
}

describe("launcher output cache", () => {
	it("builds once, then reuses outputs while the input and stamp match", t => {
		const w = workspace(t);
		const first = cached(w.directory, undefined, "input-1", ["out"], w.build);
		assert.equal(w.builds(), 1);
		assert.equal(first.output, fingerprint(w.directory, ["out"]));
		assert.equal(first.stamp, fingerprint(w.directory, ["out"], { contents: false }));
		assert.equal(cached(w.directory, first, "input-1", ["out"], w.build), first);
		assert.equal(w.builds(), 1);
	});

	it("adopts state saved before stamps existed without rebuilding", t => {
		const w = workspace(t);
		const legacy = { input: "input-1", output: fingerprint(w.directory, ["out"]) };
		const next = cached(w.directory, legacy, "input-1", ["out"], w.build);
		assert.equal(w.builds(), 0);
		assert.deepEqual(next, { ...legacy, stamp: fingerprint(w.directory, ["out"], { contents: false }) });
	});

	it("keeps outputs whose files were touched but not changed, refreshing only the stamp", t => {
		const w = workspace(t);
		const first = cached(w.directory, undefined, "input-1", ["out"], w.build);
		const later = new Date(Date.now() + 60_000);
		utimesSync(path.join(w.directory, "out", "a.js"), later, later);
		const next = cached(w.directory, first, "input-1", ["out"], w.build);
		assert.equal(w.builds(), 1);
		assert.equal(next.output, first.output, "dependents keyed on the content hash are unaffected");
		assert.notEqual(next.stamp, first.stamp);
	});

	it("rebuilds when an output changes, disappears or gains a file, or the input changes", t => {
		const w = workspace(t);
		let state = cached(w.directory, undefined, "input-1", ["out"], w.build);
		writeFileSync(path.join(w.directory, "out", "a.js"), "ALPHA");
		state = cached(w.directory, state, "input-1", ["out"], w.build);
		assert.equal(w.builds(), 2);
		rmSync(path.join(w.directory, "out", "nested", "b.js"));
		state = cached(w.directory, state, "input-1", ["out"], w.build);
		assert.equal(w.builds(), 3);
		writeFileSync(path.join(w.directory, "out", "c.js"), "gamma");
		state = cached(w.directory, state, "input-1", ["out"], w.build);
		assert.equal(w.builds(), 4);
		cached(w.directory, state, "input-2", ["out"], w.build);
		assert.equal(w.builds(), 5);
	});

	it("refuses a linked output when checking stamps", t => {
		const w = workspace(t);
		const outside = path.join(w.directory, "outside");
		mkdirSync(outside);
		symlinkSync(outside, path.join(w.directory, "out", "linked"), "junction");
		assert.throws(() => fingerprint(w.directory, ["out"], { contents: false }), /Refusing linked or special launcher file/);
	});
});

describe("checkout server home-page warm-up", () => {
	it("requests / once with the development host name and drains the response", async t => {
		const requests: { url?: string; method?: string; headers: IncomingHttpHeaders }[] = [];
		const server = createServer((request, response) => {
			requests.push({ url: request.url, method: request.method, headers: request.headers });
			response.end("x".repeat(64 * 1024));
		});
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		t.after(() => server.close());
		const { port } = server.address() as AddressInfo;
		assert.equal(await warmHomePage(port), 200);
		assert.equal(requests.length, 1);
		assert.equal(requests[0]!.url, "/");
		assert.equal(requests[0]!.method, "GET");
		assert.equal(requests[0]!.headers.host, `localhost:${port}`);
	});

	it("settles quietly when nothing is listening", async () => {
		const probe = createServer();
		await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
		const { port } = probe.address() as AddressInfo;
		await new Promise(resolve => probe.close(resolve));
		assert.equal(await warmHomePage(port), undefined);
	});
});
