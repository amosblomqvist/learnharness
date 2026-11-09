/**
 * Wave E stage 3 (owner 2026-10-10): demos run in the app's own Chromium
 * via a --browser-service helper (main.cjs boots a hidden window with a CDP
 * port), system Chrome as fallback. These pin the pure halves of that
 * chain: the handshake line parser and the spawn-env sanitizer. The live
 * chain (spawn → connect → pages() → run) is exercised on dev machines,
 * not in the suite.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import { browserServiceSpawnEnv, parseBrowserServiceLine, realHeadless } from "../src/agent/subagents/headless.ts";

describe("browser-service helper (pure halves)", () => {
	it("parses the handshake line into a port", () => {
		assert.equal(parseBrowserServiceLine("BROWSER_SERVICE_CDP 54321"), 54321);
	});

	it("rejects non-handshake lines", () => {
		assert.equal(parseBrowserServiceLine("DevTools listening on ws://127.0.0.1:57983/devtools/browser/x"), null);
		assert.equal(parseBrowserServiceLine(""), null);
		assert.equal(parseBrowserServiceLine("BROWSER_SERVICE_CDP 0"), null);
		assert.equal(parseBrowserServiceLine("BROWSER_SERVICE_CDP 99999"), null);
	});

	it("spawn env strips ELECTRON_RUN_AS_NODE — the helper must be a full app", () => {
		const env = browserServiceSpawnEnv({
			ELECTRON_RUN_AS_NODE: "1",
			LH_DEV_URL: "http://localhost:3000",
			PATH: "/usr/bin",
		});
		assert.equal("ELECTRON_RUN_AS_NODE" in env, false);
		assert.equal("LH_DEV_URL" in env, false);
		assert.equal(env.PATH, "/usr/bin");
	});

	it("spawn env never mutates the caller's env object", () => {
		const original = { ELECTRON_RUN_AS_NODE: "1", KEEP: "yes" };
		browserServiceSpawnEnv(original);
		assert.equal(original.ELECTRON_RUN_AS_NODE, "1");
		assert.equal(original.KEEP, "yes");
	});
});

describe("browser-service helper (shared across demo jobs)", () => {
	const cp = createRequire(import.meta.url)("node:child_process");

	async function withFakeHelpers(run: (helpers: EventEmitter[]) => Promise<void>) {
		const realSpawn = cp.spawn;
		const realFetch = globalThis.fetch;
		const realConnect = puppeteer.connect;
		const electron = Object.getOwnPropertyDescriptor(process.versions, "electron");
		const helpers: EventEmitter[] = [];
		cp.spawn = () => {
			const proc = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(), exitCode: null as number | null, kill() { return true; },
			});
			helpers.push(proc);
			setTimeout(() => proc.stdout.emit("data", Buffer.from(`BROWSER_SERVICE_CDP ${9500 + helpers.length}\n`)), 10);
			return proc;
		};
		syncBuiltinESMExports();
		// A connected fake helper page lets runDemo settle and clean its temp dir
		// without falling back to launching real Chrome.
		const page = { target: () => ({ type: () => "page" }), on() {}, goto: async () => null };
		globalThis.fetch = (async () => ({ json: async () => ({ webSocketDebuggerUrl: "ws://fake" }) })) as unknown as typeof fetch;
		puppeteer.connect = (async () => ({ pages: async () => [page] })) as unknown as typeof puppeteer.connect;
		Object.defineProperty(process.versions, "electron", { value: "test", configurable: true });
		try {
			await run(helpers);
		} finally {
			for (const helper of helpers) helper.emit("exit", 0);
			cp.spawn = realSpawn;
			syncBuiltinESMExports();
			globalThis.fetch = realFetch;
			puppeteer.connect = realConnect;
			if (electron) Object.defineProperty(process.versions, "electron", electron);
			else delete (process.versions as Record<string, unknown>).electron;
		}
	}

	it("two demo jobs started together share one helper, and a new one starts after it exits", async () => {
		await withFakeHelpers(async (helpers) => {
			const runs = [
				realHeadless.runDemo("<button>count</button>", { settleMs: 0 }),
				realHeadless.runDemo("<input type=range>", { settleMs: 0 }),
			];
			while (helpers.length === 0) await sleep(10);
			await sleep(200);
			assert.equal(helpers.length, 1);

			helpers[0]!.emit("exit", 0);
			runs.push(realHeadless.runDemo("<p>next</p>", { settleMs: 0 }));
			await sleep(200);
			assert.equal(helpers.length, 2);
			await Promise.all(runs);
		});
	});
});
