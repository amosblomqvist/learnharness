/** LAN controller: lifecycle around a fake gateway and a real temp lan.json. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createLanController } = require("../electron/lan-controller.cjs");
const { createLanConfig } = require("../electron/lan-config.cjs");

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const IFACES = () => ({
	lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
	eth0: [
		{ family: "IPv4", address: "192.168.1.20", internal: false },
		{ family: "IPv6", address: "fe80::1", internal: false },
	],
});

function setup(opts: { failWith?: string; interfaces?: () => object } = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "lan-ctl-"));
	dirs.push(dir);
	const file = path.join(dir, "lan.json");
	const config = createLanConfig(file);
	const log: string[] = [];
	const createGateway = () => ({
		listen: async (port: number, host: string) => {
			if (opts.failWith) throw Object.assign(new Error("boom"), { code: opts.failWith });
			log.push(`listen ${host}:${port}`);
		},
		close: async () => {
			log.push("close");
		},
	});
	const make = () => createLanController({ config, createGateway, targetPort: 3000, getSecret: () => "s", networkInterfaces: opts.interfaces ?? IFACES });
	return { config, file, log, ctl: make(), make };
}

describe("lan controller", () => {
	it("enabling binds 0.0.0.0 on the configured port and lists urls", async () => {
		const { ctl, log } = setup();
		await ctl.setEnabled(true);
		assert.deepEqual(log, ["listen 0.0.0.0:4747"]);
		const s = ctl.state();
		assert.equal(s.running, true);
		assert.equal(s.enabled, true);
		assert.deepEqual(s.urls, ["http://192.168.1.20:4747"]);
		assert.equal(s.error, null);
	});

	it("lists only interfaces other devices can reach, not container or VM bridges", async () => {
		const v4 = (address: string) => [{ family: "IPv4", address, internal: false }];
		const { ctl } = setup({
			interfaces: () => ({
				wlan0: v4("192.168.1.30"),
				tailscale0: v4("100.64.0.7"),
				docker0: v4("172.17.0.1"),
				"br-39f52c001687": v4("172.20.0.1"),
				virbr0: v4("192.168.122.1"),
				veth12ab: v4("172.17.0.9"),
			}),
		});
		await ctl.setEnabled(true);
		assert.deepEqual(ctl.state().urls, ["http://192.168.1.30:4747", "http://100.64.0.7:4747"]);
	});

	it("a bind failure saves enabled=false and reports a readable error", async () => {
		const { ctl, file } = setup({ failWith: "EADDRINUSE" });
		await ctl.setEnabled(true);
		const s = ctl.state();
		assert.equal(s.enabled, false);
		assert.equal(s.running, false);
		assert.deepEqual(s.urls, []);
		assert.equal(s.error, "Port 4747 is already in use.");
		assert.equal(JSON.parse(readFileSync(file, "utf8")).enabled, false);
	});

	it("changing the port while running restarts the gateway", async () => {
		const { ctl, log } = setup();
		await ctl.setEnabled(true);
		await ctl.setPort(5050);
		assert.deepEqual(log, ["listen 0.0.0.0:4747", "close", "listen 0.0.0.0:5050"]);
		assert.deepEqual(ctl.state().urls, ["http://192.168.1.20:5050"]);
	});

	it("an invalid port is rejected and leaves the gateway alone", async () => {
		const { ctl, log } = setup();
		await ctl.setEnabled(true);
		await assert.rejects(() => ctl.setPort(80), RangeError);
		assert.deepEqual(log, ["listen 0.0.0.0:4747"]);
	});

	it("disabling closes the gateway", async () => {
		const { ctl, log } = setup();
		await ctl.setEnabled(true);
		await ctl.setEnabled(false);
		assert.deepEqual(log, ["listen 0.0.0.0:4747", "close"]);
		assert.equal(ctl.state().running, false);
		assert.deepEqual(ctl.state().urls, []);
	});

	it("start() binds only when the config says enabled", async () => {
		const off = setup();
		await off.ctl.start();
		assert.deepEqual(off.log, []);
		off.config.setEnabled(true);
		await off.make().start();
		assert.deepEqual(off.log, ["listen 0.0.0.0:4747"]);
	});

	it("password changes need no restart and state never leaks secrets", async () => {
		const { ctl, config, log } = setup();
		await ctl.setEnabled(true);
		ctl.setPassword("hunter2");
		assert.equal(ctl.state().hasPassword, true);
		assert.deepEqual(log, ["listen 0.0.0.0:4747"]);
		const dump = JSON.stringify(ctl.state());
		assert.ok(!dump.includes(config.getAuth().passwordHash));
		assert.ok(!dump.includes(config.getAuth().sessionKey.toString("base64")));
		assert.deepEqual(Object.keys(ctl.state()).sort(), ["enabled", "error", "hasPassword", "port", "running", "urls"]);
		ctl.setPassword(null);
		assert.equal(ctl.state().hasPassword, false);
	});

	it("close() shuts a running gateway", async () => {
		const { ctl, log } = setup();
		await ctl.setEnabled(true);
		await ctl.close();
		assert.equal(log.at(-1), "close");
	});

	it("concurrent setEnabled(true) calls leave one gateway listening and a consistent state", async () => {
		const { config, log } = setup();
		const bound = new Set<number>();
		let alive = 0;
		const createGateway = () => {
			let port = 0;
			return {
				listen: async (p: number) => {
					await new Promise((r) => setTimeout(r, 10));
					if (bound.has(p)) throw Object.assign(new Error("in use"), { code: "EADDRINUSE" });
					bound.add(p);
					port = p;
					alive++;
					log.push("up");
				},
				close: async () => {
					await new Promise((r) => setTimeout(r, 5));
					if (port) { bound.delete(port); alive--; }
				},
			};
		};
		const ctl = createLanController({ config, createGateway, targetPort: 3000, getSecret: () => "s", networkInterfaces: IFACES });
		await Promise.all([ctl.setEnabled(true), ctl.setEnabled(true)]);
		const st = ctl.state();
		assert.equal(st.running, st.enabled);
		assert.equal(st.error, null);
		assert.equal(alive, 1);
	});
});
