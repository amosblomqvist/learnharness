/** Launcher startup shortcuts: the output stamp cache and the checkout server's home-page warm-up. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { cached, fingerprint } from "../scripts/launch-checkout-desktop.mjs";

const { warmHomePage } = createRequire(import.meta.url)("../scripts/checkout-server.cjs") as {
	warmHomePage: (port: number, host?: string) => Promise<number | undefined>;
};
const restartModule = fileURLToPath(new URL("../electron/checkout-restart.cjs", import.meta.url));
const { checkoutAddress, listenLocal, pipeName, requestStop } = createRequire(import.meta.url)(restartModule) as {
	checkoutAddress: (kind: string, workspace: string) => string;
	listenLocal: (server: Server, address: string) => Promise<void>;
	pipeName: (workspace: string) => string;
	requestStop: (address: string, timeoutMs?: number) => Promise<boolean>;
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

/** Point Linux checkout sockets at a private temporary runtime folder. */
function runtimeDirectory(t: TestContext) {
	if (process.platform !== "linux") return;
	const directory = mkdtempSync(path.join(tmpdir(), "learnharness-runtime-"));
	const previous = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = directory;
	t.after(() => {
		if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	});
	return directory;
}

describe("checkout restart", { skip: process.platform !== "win32" && process.platform !== "linux" }, () => {
	it("distinguishes a closed checkout and waits for a running checkout to exit", { timeout: 10_000 }, async t => {
		runtimeDirectory(t);
		const w = workspace(t);
		const address = pipeName(w.directory);
		assert.equal(await requestStop(address), false);
		const desktop = spawn(process.execPath, ["-e", `
			const { listenForStop } = require(process.argv[1]);
			listenForStop(process.argv[2], () => process.send('stopping'), console.error)
				.then(() => process.send('ready'));
			process.on('message', () => process.exit(0));
		`, restartModule, address], { stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true, env: process.env });
		t.after(() => { if (desktop.exitCode === null && desktop.signalCode === null) desktop.kill(); });
		const [ready] = await once(desktop, "message");
		assert.equal(ready, "ready");
		const stopping = once(desktop, "message");
		const stopped = requestStop(address);
		const [message] = await stopping;
		assert.equal(message, "stopping");
		await assert.rejects(requestStop(address, 200), /did not shut down within 30 seconds/);
		const exit = once(desktop, "exit");
		desktop.send("exit");
		assert.equal(await stopped, true);
		assert.deepEqual(await exit, [0, null]);
		assert.equal(await requestStop(address), false);
	});
});

describe("Linux checkout sockets", { skip: process.platform !== "linux" }, () => {
	async function listen(t: TestContext, address: string) {
		const server = createNetServer(socket => socket.destroy());
		t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
		await listenLocal(server, address);
		return server;
	}

	it("keys each checkout by its exact, case-sensitive path inside a private folder", t => {
		const runtime = runtimeDirectory(t)!;
		const w = workspace(t);
		const upper = path.join(w.directory, "Checkout"), lower = path.join(w.directory, "checkout");
		mkdirSync(upper); mkdirSync(lower);
		const address = checkoutAddress("checkout", upper);
		assert.equal(path.dirname(address), path.join(runtime, "learnharness"));
		assert.match(path.basename(address), /^checkout-[0-9a-f]{32}\.sock$/);
		assert.notEqual(address, checkoutAddress("checkout", lower));
		assert.notEqual(address, checkoutAddress("restart", upper));
		assert.equal(pipeName(upper), checkoutAddress("restart", upper));
		assert.equal(statSync(path.dirname(address)).mode & 0o777, 0o700);
	});

	it("refuses a missing XDG_RUNTIME_DIR and an unsafe socket folder", t => {
		const runtime = runtimeDirectory(t)!;
		const w = workspace(t);
		delete process.env.XDG_RUNTIME_DIR;
		assert.throws(() => checkoutAddress("checkout", w.directory), /XDG_RUNTIME_DIR is not set/);
		process.env.XDG_RUNTIME_DIR = runtime;
		mkdirSync(path.join(runtime, "learnharness"), { mode: 0o755 });
		chmodSync(path.join(runtime, "learnharness"), 0o755);
		assert.throws(() => checkoutAddress("checkout", w.directory), /unsafe LearnHarness socket folder/);
		rmSync(path.join(runtime, "learnharness"), { recursive: true });
		symlinkSync(w.directory, path.join(runtime, "learnharness"));
		assert.throws(() => checkoutAddress("checkout", w.directory), /unsafe LearnHarness socket folder/);
	});

	it("replaces a socket left by a crashed owner but refuses a live owner and a regular file", async t => {
		runtimeDirectory(t);
		const w = workspace(t);
		const address = checkoutAddress("checkout", w.directory);
		// A child that exits without closing its server leaves the socket file behind.
		const crashed = spawn(process.execPath, ["-e", `
			require("node:net").createServer().listen(process.argv[1], () => process.exit(0));
		`, address], { stdio: "ignore" });
		await once(crashed, "exit");
		assert.ok(lstatSync(address).isSocket());
		await listen(t, address);
		await assert.rejects(listen(t, address), { code: "EADDRINUSE" });
		const file = checkoutAddress("restart", w.directory);
		writeFileSync(file, "not a socket");
		// listen() reports EADDRINUSE for any existing path; a probe then finds no listener.
		await assert.rejects(listen(t, file), /non-socket file/);
		assert.equal(readFileSync(file, "utf8"), "not a socket");
	});
});
