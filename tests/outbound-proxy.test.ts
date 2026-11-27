/** Provider sign-in must follow the OS proxy and HTTP(S)_PROXY. No Electron launch. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const installedFlag = "__lhDesktopProxyFetch";
const globals = globalThis as unknown as Record<string, unknown>;
const { serverProxyEnv, proxyUrlFromResolution, childEnvForSystemProxy, prepareOutboundProxy } = require("../electron/outbound-proxy.cjs");
const root = fileURLToPath(new URL("../", import.meta.url));
const mainFile = path.join(root, "electron/main.cjs");
const mainSource = readFileSync(mainFile, "utf8");
const mainRequire = createRequire(mainFile);

test("server child opts into Node's env proxy only when a proxy is configured", () => {
	assert.deepEqual(serverProxyEnv({}), {});
	assert.deepEqual(serverProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:10808" }), { NODE_USE_ENV_PROXY: "1" });
	assert.deepEqual(serverProxyEnv({ http_proxy: "http://127.0.0.1:9" }), { NODE_USE_ENV_PROXY: "1" });
	assert.deepEqual(serverProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:9", NODE_USE_ENV_PROXY: "0" }), {});
	assert.deepEqual(serverProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:9", NODE_USE_ENV_PROXY: "1" }), {});
});

test("Chromium proxy resolution becomes an HTTP proxy URL", () => {
	assert.equal(proxyUrlFromResolution("DIRECT"), "");
	assert.equal(proxyUrlFromResolution("PROXY 127.0.0.1:10808"), "http://127.0.0.1:10808");
	assert.equal(proxyUrlFromResolution("PROXY 127.0.0.1:10808; DIRECT"), "http://127.0.0.1:10808");
	assert.equal(proxyUrlFromResolution("SOCKS 127.0.0.1:1080"), "");
	assert.equal(proxyUrlFromResolution("HTTPS proxy.example:443"), "http://proxy.example:443");
});

test("a system proxy is copied onto the child only when the environment has none", () => {
	assert.deepEqual(childEnvForSystemProxy({}, "DIRECT"), {});
	assert.deepEqual(childEnvForSystemProxy({ HTTPS_PROXY: "http://127.0.0.1:9" }, "PROXY 10.0.0.1:8080"), {});
	assert.deepEqual(childEnvForSystemProxy({}, "PROXY 127.0.0.1:10808"), {
		HTTP_PROXY: "http://127.0.0.1:10808",
		HTTPS_PROXY: "http://127.0.0.1:10808",
		NODE_USE_ENV_PROXY: "1",
		NO_PROXY: "localhost,127.0.0.1,::1",
	});
	assert.deepEqual(childEnvForSystemProxy({ NODE_USE_ENV_PROXY: "0" }, "PROXY 127.0.0.1:10808"), {});
});

test("main-process fetch uses the session outside loopback and keeps provider cookies out", async () => {
	const previous = globalThis.fetch;
	const flagged = Object.prototype.hasOwnProperty.call(globals, installedFlag);
	const seen: Array<Record<string, unknown>> = [];
	const session = {
		async resolveProxy() { return "PROXY 127.0.0.1:10808"; },
		async setProxy(config: unknown) { seen.push({ op: "setProxy", config }); },
		async fetch(input: unknown, init: unknown) { seen.push({ op: "session", input, init }); return new Response("ok"); },
	};
	globalThis.fetch = (async (input: unknown, init: unknown) => {
		seen.push({ op: "node", input, init });
		return new Response("local");
	}) as typeof fetch;
	try {
		const child = await prepareOutboundProxy(session, {});
		assert.deepEqual(child, {
			HTTP_PROXY: "http://127.0.0.1:10808",
			HTTPS_PROXY: "http://127.0.0.1:10808",
			NODE_USE_ENV_PROXY: "1",
			NO_PROXY: "localhost,127.0.0.1,::1",
		});
		assert.equal(seen.some((entry) => entry.op === "setProxy"), false);
		await globalThis.fetch("https://auth.x.ai/oauth2/device/code", { method: "POST" });
		await globalThis.fetch("http://127.0.0.1:54321/health");
		const external = seen.find((entry) => entry.op === "session");
		assert.equal(external?.input, "https://auth.x.ai/oauth2/device/code");
		assert.equal((external?.init as { credentials?: string }).credentials, "omit");
		assert.equal((external?.init as { method?: string }).method, "POST");
		assert.equal(seen.some((entry) => entry.op === "node" && entry.input === "http://127.0.0.1:54321/health"), true);
	} finally {
		globalThis.fetch = previous;
		if (flagged) globals[installedFlag] = true;
		else delete globals[installedFlag];
	}
});

test("an env proxy is applied when Chromium is direct", async () => {
	const previous = globalThis.fetch;
	delete globals[installedFlag];
	const seen: Array<Record<string, unknown>> = [];
	const session = {
		async resolveProxy() { return "DIRECT"; },
		async setProxy(config: unknown) { seen.push({ op: "setProxy", config }); },
		async fetch(input: unknown, init: unknown) { seen.push({ op: "session", input, init }); return new Response("ok"); },
	};
	globalThis.fetch = (async () => new Response("node")) as typeof fetch;
	try {
		const child = await prepareOutboundProxy(session, { HTTPS_PROXY: "http://127.0.0.1:10808", NO_PROXY: "localhost,127.0.0.1" });
		assert.deepEqual(child, {});
		assert.deepEqual(seen[0], {
			op: "setProxy",
			config: { proxyRules: "http://127.0.0.1:10808", proxyBypassRules: "<local>;localhost;127.0.0.1" },
		});
		await globalThis.fetch("https://api.x.ai/v1/models");
		assert.equal(seen.at(-1)?.op, "session");
	} finally {
		globalThis.fetch = previous;
		delete globals[installedFlag];
	}
});

test("the desktop server launch passes the env-proxy opt-in to the child", async () => {
	let launch!: { options: { env: Record<string, string> } };
	const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
	const context = {
		require: (id: string) => id === "electron" ? {
			app: { setName() {}, requestSingleInstanceLock: () => false, quit() {}, getPath: () => "/fixture/user-data" },
		} : id === "node:child_process" ? {
			spawn(_binary: string, _args: string[], options: { env: Record<string, string> }) {
				launch = { options };
				return child;
			},
		} : mainRequire(id),
		process: {
			platform: "win32",
			argv: [],
			env: { FIXTURE: "kept", HTTPS_PROXY: "http://127.0.0.1:10808", NO_PROXY: "localhost" },
			on() {},
			execPath: "/fixture/LearnHarness",
			resourcesPath: "/fixture/resources",
		},
		__dirname: path.dirname(mainFile),
	};
	runInNewContext(mainSource, context, { filename: mainFile });
	await runInNewContext("startServer(54321)", context);
	assert.equal(launch.options.env.NODE_USE_ENV_PROXY, "1");
	assert.equal(launch.options.env.HTTPS_PROXY, "http://127.0.0.1:10808");
	assert.equal(launch.options.env.FIXTURE, "kept");
	assert.equal(launch.options.env.ELECTRON_RUN_AS_NODE, "1");
	assert.equal(launch.options.env.NODE_OPTIONS, undefined);
});

test("NODE_USE_ENV_PROXY makes fetch open CONNECT on the configured proxy", async () => {
	const connects: string[] = [];
	const proxy = createServer();
	proxy.on("connect", (request, socket) => {
		connects.push(request.url ?? "");
		socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
		socket.end();
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
	const address = proxy.address();
	if (!address || typeof address === "string") throw new Error("proxy port missing");
	const base: Record<string, string | undefined> = { ...process.env };
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY", "NO_PROXY", "no_proxy"]) delete base[key];
	const configured = { ...base, HTTPS_PROXY: `http://127.0.0.1:${address.port}`, NO_PROXY: "localhost,127.0.0.1,::1" };
	const childEnv = { ...configured, ...serverProxyEnv(configured) };
	try {
		assert.equal(childEnv.NODE_USE_ENV_PROXY, "1");
		const run = (env: NodeJS.ProcessEnv) => new Promise<void>((resolve, reject) => {
			const child = spawn(process.execPath, ["-e", "fetch('https://example.com/',{signal:AbortSignal.timeout(4000)}).then(r=>console.log(r.status)).catch(e=>console.log(e.name))"], { env });
			child.on("error", reject);
			child.on("exit", () => resolve());
		});
		await run(childEnv);
		assert.deepEqual(connects, ["example.com:443"]);
		connects.length = 0;
		await run(configured);
		assert.deepEqual(connects, []);
	} finally {
		await new Promise<void>((resolve) => proxy.close(() => resolve()));
	}
});
