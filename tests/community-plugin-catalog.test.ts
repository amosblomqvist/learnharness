import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { COMMUNITY_FEED_URL, communityListingReport, compatibleCommunityRelease, parseCommunityFeed } from "../src/core/community-catalog.ts";
import { createCommunityPluginCatalog } from "../src/server/community-plugin-catalog.ts";
import { createPluginHost, type PluginHostDependencies } from "../src/server/plugin-host.ts";
import { createPluginTransport } from "../src/server/plugin-transport.ts";
import { readCommunityPluginZip } from "../src/server/community-plugin-zip.ts";
import { publishCatalogFiles } from "../src/server/community-plugin-files.ts";
import seed from "../plugin-catalog/community-plugins.json";
import coreIds from "../core-plugins.json";

const id = "fixture-plugin", repo = "example/fixture-plugin";
const manifest = (version: string, extra = {}) => JSON.stringify({ id, version, name: "Fixture plugin", minAppVersion: "0.7.0", apiVersion: 1, backend: "backend.cjs", main: "main.js", ...extra });
const backend = (value: string) => `exports.activate = ctx => { ctx.handle('proof', () => ${JSON.stringify(value)}); ctx.cleanup(() => ctx.learning.history.push('cleanup')); };`;
const frontend = "export function activate() {}";

function zip(entries: [string, string, number?][], descriptors = false) {
	const [locals, records] = [[], []] as Buffer[][];
	let offset = 0;
	for (const [name, value, mode = 0x81a4] of entries) {
		const filename = Buffer.from(name), payload = Buffer.from(value), checksum = crc32(payload);
		const compressed = deflateRawSync(payload), flags = descriptors ? 8 : 0;
		const local = Buffer.alloc(30), central = Buffer.alloc(46), descriptor = Buffer.alloc(descriptors ? 16 : 0);
		local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(filename.length, 26);
		if (descriptors) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(payload.length, 12); }
		else { local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(payload.length, 22); }
		central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(8, 10);
		central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(payload.length, 24);
		central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(mode * 65536, 38); central.writeUInt32LE(offset, 42);
		locals!.push(local, filename, compressed, descriptor); records!.push(central, filename); offset += local.length + filename.length + compressed.length + descriptor.length;
	}
	const central = Buffer.concat(records!), end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals!, central, end]);
}
function build(version = "1.0.0", prefix = "", extra: [string, string, number?][] = [], manifestText = manifest(version)) {
	return zip([[`${prefix}manifest.json`, manifestText], [`${prefix}main.js`, frontend], [`${prefix}backend.cjs`, backend(version)], ...extra], true);
}
function release(bytes: Buffer, version = "1.0.0") {
	return { version, minAppVersion: "0.7.0", apiVersion: 1, publishedAt: "2026-11-26T01:00:00Z", tag: `v${version}`, asset: "fixture.zip", sha256: createHash("sha256").update(bytes).digest("hex") };
}
function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(tmpdir(), "lh-catalog-test-"));
	const directory = path.join(root, "plugins"), core = path.join(root, "core"), state = path.join(root, "plugins-state.json");
	const history: string[] = [];
	const hooks: { enter?: () => void; pending?: Promise<void> } = {};
	const deps: PluginHostDependencies = { directory, appVersion: "0.7.0", core: { directory: core, dataDirectory: path.join(root, "core-data"), ids: ["official"] },
		createServices: () => { history.push("activate"); return { learning: { history, hooks }, agents: { dispose() {} }, workers: { dispose() {} } } as never; } };
	const hosts = new Set<ReturnType<typeof createPluginHost>>();
	function newHost() { const h = createPluginHost(deps); hosts.add(h); return h; }
	let host = newHost();
	t.after(async () => { await Promise.all([...hosts].map(h => h.dispose())); fs.rmSync(root, { recursive: true, force: true }); });
	let bytes: Buffer = build();
	let current = release(bytes), delisted = false;
	let assetResponse: Response | undefined;
	const fetched: string[] = [];
	const catalog = createCommunityPluginCatalog({ appVersion: deps.appVersion, coreIds: ["official"], getHost: async () => { await host.initialize(); return host; }, fetch: async (input, options) => {
		const url = String(input); fetched.push(url);
		assert.equal(options?.credentials, "omit");
		assert.equal(options?.redirect, "manual");
		if (url === COMMUNITY_FEED_URL) return Response.json({ schemaVersion: 1, plugins: delisted ? [] : [{ id, name: "Fixture plugin", author: "Example", description: "A test fixture", repository: repo, releases: [current] }] });
		assert.equal(url, `https://github.com/${repo}/releases/download/${current.tag}/${current.asset}`);
		return assetResponse ?? new Response(Uint8Array.from(bytes));
	} });
	const request = () => new Request("http://localhost/api/plugin-catalog");
	return { directory, core, state, history, hooks, fetched, get host() { return host; },
		async restart() { await host.dispose(); host = newHost(); await host.initialize(); },
		async browse() { const response = await catalog.list(request()); return { status: response.status, body: await response.json() }; },
		install(action = "Install", sha256 = current.sha256) { return catalog.install(id, new Request(request(), { method: "POST", body: JSON.stringify({ action, sha256 }) })); },
		setBuild(zipBytes: Buffer, version?: string) { bytes = zipBytes; current = release(bytes, version); },
		setResponse(response?: Response) { assetResponse = response; }, delist() { delisted = true; },
	};
}

test("the nine seeds use verified compatible releases or source-only, and listing reports are distinguishable from author issues", () => {
	const { plugins } = parseCommunityFeed(seed, coreIds);
	assert.equal(plugins.length, 9);
	assert.deepEqual(plugins.filter(p => !p.releases.length).map(p => p.id), ["activity-heatmap", "meme-plugin"]);
	const english = plugins.find(p => p.id === "speak-english")!;
	assert.equal(compatibleCommunityRelease(english, "0.6.1", 1), null);
	assert.equal(compatibleCommunityRelease(english, "0.7.0", 2), null);
	assert.equal(compatibleCommunityRelease(english, "0.7.0", 1)?.version, "0.2.0");
	const report = new URL(communityListingReport(english));
	assert.equal(report.pathname, "/amosblomqvist/learnharness/issues/new");
	assert.equal(report.searchParams.get("labels"), "community-plugin");
	assert.match(report.searchParams.get("body")!, /Plugin ID: speak-english\nSource: https:\/\/github.com\/wangdepin\/speak-english-plugin/);
	assert.throws(() => parseCommunityFeed({ schemaVersion: 1, plugins: [{ ...english, repository: "../bad" }] }));
	assert.throws(() => parseCommunityFeed({ schemaVersion: 1, plugins: [english, english] }));
});

test("global off migrates only execution; explicit opt-in resumes previously enabled community and leaves Core alone", async t => {
	const f = fixture(t);
	const add = (dir: string, pluginId: string) => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "manifest.json"), manifest("1.0.0", { id: pluginId }));
		fs.writeFileSync(path.join(dir, "backend.cjs"), backend(pluginId));
		fs.writeFileSync(path.join(dir, "main.js"), frontend);
	};
	add(path.join(f.directory, id, "dist"), id); add(path.join(f.core, "official"), "official");
	fs.writeFileSync(f.state, JSON.stringify({ version: 1, enabled: { [id]: true, official: true } }));
	await f.host.initialize();
	assert.equal(f.host.communityEnabled(), false); assert.deepEqual(f.history, ["activate"]);
	assert.equal(await f.host.call("official", "proof"), "official");
	await assert.rejects(f.host.setEnabled(id, true), /are off/);
	assert.equal((await f.browse()).status, 409); assert.deepEqual(f.fetched, []);
	await f.host.setCommunityEnabled(true); assert.equal(await f.host.call(id, "proof"), id);
	await f.host.setCommunityEnabled(false); assert.deepEqual(f.history, ["activate", "activate", "cleanup"]);
	assert.equal(await f.host.call("official", "proof"), "official");
	await assert.rejects(f.host.call(id, "proof"), /disabled/);
	assert.throws(() => f.host.asset(id, ["main.js"]), /disabled/);
	await f.restart(); assert.equal(f.host.communityEnabled(), false);
	assert.equal(f.host.list().find(p => p.id === id)?.enabled, false);
	await f.host.setCommunityEnabled(true); await f.restart(); assert.equal(await f.host.call(id, "proof"), id);
});

for (const startup of [false, true]) test(`global Off fences an unfinished saved activation and keeps Core usable (${startup ? "startup" : "opt-in"})`, { timeout: 3000 }, async t => {
	const f = fixture(t);
	let entered!: () => void, releasePending!: () => void;
	const began = new Promise<void>(resolve => { entered = resolve; });
	f.hooks.enter = entered;
	f.hooks.pending = new Promise<void>(resolve => { releasePending = resolve; });
	const add = (pluginId: string, code: string) => {
		const target = pluginId === "official" ? path.join(f.core, pluginId) : path.join(f.directory, pluginId, "dist");
		fs.mkdirSync(target, { recursive: true });
		fs.writeFileSync(path.join(target, "manifest.json"), manifest("1.0.0", { id: pluginId }));
		fs.writeFileSync(path.join(target, "main.js"), frontend);
		fs.writeFileSync(path.join(target, "backend.cjs"), code);
	};
	add("official", backend("core"));
	add("a-ready", backend("ready"));
	add("b-paused", `exports.activate = async ctx => {
		const { hooks, history } = ctx.learning;
		ctx.cleanup(() => history.push('paused cleanup'));
		hooks.enter(); await hooks.pending;
		try { ctx.handle('late', () => 'not admitted'); } catch { history.push('late registration refused'); }
		return () => history.push('late cleanup');
	};`);
	add("c-after", "exports.activate = ctx => ctx.learning.history.push('unexpected later activation');");
	const enabled = { official: true, "a-ready": true, "b-paused": true, "c-after": true };
	fs.writeFileSync(f.state, JSON.stringify({ version: 1, enabled, communityEnabled: startup }));
	await f.host.initialize({ backgroundCommunity: true });
	const transport = createPluginTransport({ getHost: async () => f.host, directory: f.directory });
	const mode = (allowed: boolean) => transport.setCommunityEnabled(new Request("http://localhost/api/plugins", { method: "PUT", body: JSON.stringify({ enabled: allowed }) }));
	if (!startup) assert.equal((await (await mode(true)).json()).communityEnabled, true);
	await began;
	assert.equal((await (await transport.list()).json()).communityEnabled, true);
	assert.equal(await f.host.call("a-ready", "proof"), "ready");
	assert.equal((await (await mode(false)).json()).communityEnabled, false);
	assert.equal(f.host.communityEnabled(), false);
	assert.deepEqual(JSON.parse(fs.readFileSync(f.state, "utf8")).enabled, enabled);
	assert.throws(() => f.host.asset("a-ready", ["main.js"]), /disabled/);
	await assert.rejects(f.host.call("a-ready", "proof"), /disabled/);
	assert.equal(await f.host.call("official", "proof"), "core");
	assert.ok(f.host.asset("official", ["main.js"]).bytes.length);
	await f.host.setEnabled("official", false); // Can drain the host queue before the plugin cooperates.
	assert.ok(f.history.includes("paused cleanup"));
	assert.equal(f.history.includes("unexpected later activation"), false);
	releasePending(); await new Promise<void>(resolve => setImmediate(resolve));
	await f.host.refresh();
	assert.ok(f.history.includes("late registration refused"));
	assert.ok(f.history.includes("late cleanup"));
	assert.equal(f.history.includes("unexpected later activation"), false);
});

test("browse, install, update and restart do not execute a downloaded build before explicit Enable; data survives", async t => {
	const f = fixture(t);
	// A removed local package can leave an old enable bit for this ID.
	fs.writeFileSync(f.state, JSON.stringify({ version: 1, communityEnabled: true, enabled: { [id]: true } }));
	assert.equal((await f.browse()).body.offers[0].action, "Install"); assert.deepEqual(f.fetched, [COMMUNITY_FEED_URL]);
	assert.equal((await f.install()).status, 200);
	assert.deepEqual(f.history, []); assert.equal(f.host.list().find(p => p.id === id)?.repository, repo);
	assert.throws(() => f.host.asset(id, ["main.js"]), /disabled/);
	await f.restart(); assert.deepEqual(f.history, []);
	await f.host.setEnabled(id, true); assert.equal(await f.host.call(id, "proof"), "1.0.0");
	const data = path.join(f.directory, id, "data", "fixture.txt"); fs.writeFileSync(data, "preserved");
	f.setBuild(build("1.1.0", `${id}/dist/`, [[`${id}/README.md`, "ignore outside dist"]]), "1.1.0");
	assert.equal((await f.browse()).body.offers[0].action, null);
	await f.host.setEnabled(id, false);
	assert.equal((await f.browse()).body.offers[0].action, "Update");
	const result = await f.install("Update"); assert.equal(result.status, 200); assert.deepEqual(await result.json(), { restartRequired: true });
	assert.equal(fs.readFileSync(data, "utf8"), "preserved");
	assert.equal(f.host.list().find(p => p.id === id)?.enabled, false);
	await assert.rejects(f.host.setEnabled(id, true), /Restart required/);
	await f.restart(); assert.deepEqual(f.history, ["activate", "cleanup"]);
	// A delisting cannot revoke a local build.
	f.delist(); assert.equal((await f.browse()).body.offers.length, 0);
	assert.equal((await f.install("Update")).status, 409);
	await f.host.setEnabled(id, true);
	// The test restarts the host but not Node's CJS module cache; a real process restart clears it.
	assert.equal(f.host.list().find(p => p.id === id)?.manifest?.version, "1.1.0");
});

test("bad feed selection, partial data, unexpected redirects and invalid packages leave no new files; locally edited builds are not overwritten", async t => {
	const f = fixture(t); await f.host.setCommunityEnabled(true);
	assert.equal((await f.install("Install", "0".repeat(64))).status, 409);
	assert.deepEqual(f.fetched, [COMMUNITY_FEED_URL]);
	f.setResponse(new Response("partial")); assert.equal((await f.install()).status, 409);
	f.setResponse(new Response(null, { status: 302, headers: { location: "https://example.invalid/artifact" } })); assert.equal((await f.install()).status, 503);
	f.setResponse(); f.setBuild(build("1.0.0", "", [], manifest("2.0.0"))); assert.equal((await f.install()).status, 409);
	f.setBuild(build("1.0.0", "", [], manifest("1.0.0", { main: "missing.js" }))); assert.equal((await f.install()).status, 409);
	assert.equal(fs.existsSync(path.join(f.directory, id)), false);
	f.setBuild(build()); assert.equal((await f.install()).status, 200);
	f.setBuild(build("1.1.0"), "1.1.0");
	const local = path.join(f.directory, id, "dist", "local.txt"); fs.writeFileSync(local, "local change");
	assert.equal((await f.browse()).body.offers[0].action, null);
	const requests = f.fetched.length;
	assert.equal((await f.install("Update")).status, 409);
	assert.deepEqual(f.fetched.slice(requests), [COMMUNITY_FEED_URL]);
	assert.equal(fs.readFileSync(local, "utf8"), "local change"); assert.deepEqual(f.history, []);
	fs.rmSync(local);
	assert.equal((await f.browse()).body.offers[0].action, "Update");
	const update = build("1.1.0");
	f.setResponse(new Response(new ReadableStream({ pull(controller) {
		fs.writeFileSync(local, "edited during download");
		controller.enqueue(Uint8Array.from(update)); controller.close();
	} }, { highWaterMark: 0 })));
	assert.equal((await f.install("Update")).status, 409);
	assert.equal(fs.readFileSync(local, "utf8"), "edited during download");
});

test("ZIP reader admits documented builds but rejects invalid paths, conflicting members and non-regular entries", () => {
	assert.deepEqual([...readCommunityPluginZip(build(), id).keys()], ["manifest.json", "main.js", "backend.cjs"]);
	assert.deepEqual([...readCommunityPluginZip(build("1.0.0", `${id}/dist/`, [[`${id}/dist/docs/a.txt`, "excluded"], [`${id}/dist/assets/a.txt`, "included"]]), id).keys()], ["manifest.json", "main.js", "backend.cjs", "assets/a.txt"]);
	for (const entry of [["../file", "bad"], ["dir\\file", "bad"], ["Main.js", "bad"], ["assets/a.txt", "bad", 0xa1ff], ["data/secret", "bad"], ["manifest.json", "bad"], ["assets/CON.txt", "bad"]] as [string, string, number?][]) {
		assert.throws(() => readCommunityPluginZip(build("1.0.0", "", [entry]), id), /Invalid plugin ZIP/);
	}
	const bytes = build(); assert.throws(() => readCommunityPluginZip(bytes.subarray(0, -1), id), /missing directory/);
});

test("staged publication rolls back the old build if state commit fails", t => {
	const f = fixture(t), dir = path.join(f.directory, id);
	fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
	fs.writeFileSync(path.join(dir, "dist", "old.txt"), "old");
	assert.throws(() => publishCatalogFiles(f.directory, id, new Map([["new.txt", Buffer.from("new")]]), true, () => { throw new Error("state failure"); }), /state failure/);
	assert.deepEqual(fs.readdirSync(path.join(dir, "dist")), ["old.txt"]);
	assert.deepEqual(fs.readdirSync(f.directory), [id]);
});
