import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import {
	checkCommunityFeatured, COMMUNITY_FEED_URL, communityDetailUrl, communityFeatured, communityListingReport, communityOffersFor, compatibleCommunityRelease,
	parseCommunityDetail, parseCommunityFeatured, parseCommunityFeed, reviewedCommunityRelease, type CommunityListing, type CommunityOffer,
} from "../src/core/community-catalog.ts";
import { createCommunityPluginCatalog } from "../src/server/community-plugin-catalog.ts";
import { createPluginHost, type PluginHostDependencies } from "../src/server/plugin-host.ts";
import { createPluginTransport } from "../src/server/plugin-transport.ts";
import { readCommunityPluginZip } from "../src/server/community-plugin-zip.ts";
import { publishCatalogFiles } from "../src/server/community-plugin-files.ts";
import seed from "../plugin-catalog/community-plugins.json";
import featuredList from "../plugin-catalog/featured.json";
import coreIds from "../core-plugins.json";
import { zip } from "./community-zip.ts";

const id = "fixture-plugin", repo = "example/fixture-plugin";
const manifest = (version: string, extra = {}) => JSON.stringify({ id, version, name: "Fixture plugin", minAppVersion: "0.7.0", apiVersion: 1, backend: "backend.cjs", main: "main.js", ...extra });
const backend = (value: string) => `exports.activate = ctx => { ctx.handle('proof', () => ${JSON.stringify(value)}); ctx.cleanup(() => ctx.learning.history.push('cleanup')); };`;
const frontend = "export function activate() {}";

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
	let detailResponse: () => Response = () => Response.json({ schemaVersion: 1, id, readme: { tag: current.tag, markdown: "# Fixture" }, releases: [{ version: current.version, notes: "First." }] });
	const fetched: string[] = [];
	const catalog = createCommunityPluginCatalog({ appVersion: deps.appVersion, coreIds: ["official"], getHost: async () => { await host.initialize(); return host; }, fetch: async (input, options) => {
		const url = String(input); fetched.push(url);
		assert.equal(options?.credentials, "omit");
		assert.equal(options?.redirect, "manual");
		if (url === COMMUNITY_FEED_URL) return Response.json({ schemaVersion: 1, plugins: delisted ? [] : [{ id, name: "Fixture plugin", author: "Example", description: "A test fixture", repository: repo, downloads: 7, listedAt: "2026-11-20T00:00:00Z", releases: [current] }] });
		if (url === communityDetailUrl(id)) return detailResponse();
		assert.equal(url, `https://github.com/${repo}/releases/download/${current.tag}/${current.asset}`);
		return assetResponse ?? new Response(Uint8Array.from(bytes));
	} });
	const request = () => new Request("http://localhost/api/plugin-catalog");
	return { directory, core, state, history, hooks, fetched, get host() { return host; },
		async restart() { await host.dispose(); host = newHost(); await host.initialize(); },
		async browse() { const response = await catalog.list(request()); return { status: response.status, body: await response.json() }; },
		async detail(pluginId = id) { const response = await catalog.detail(pluginId, request()); return { status: response.status, body: await response.json() }; },
		setDetail(response: () => Response) { detailResponse = response; },
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

const sha = (char: string) => char.repeat(64);
function catalogListing(extra: Partial<CommunityListing> = {}): CommunityListing {
	return { id: "sample", name: "Sample", author: "Example", description: "A sample listing", repository: "example/sample", downloads: 0, listedAt: "2026-11-01T00:00:00Z", releases: [
		{ version: "1.0.0", apiVersion: 1, minAppVersion: "0.7.0", publishedAt: "2026-11-01T00:00:00Z", tag: "v1.0.0", asset: "sample.zip", sha256: sha("a") },
	], ...extra };
}

test("the feed requires download counts and listing dates, and featured is only a literal true on a release", () => {
	const valid = catalogListing();
	assert.deepEqual(parseCommunityFeed({ schemaVersion: 1, plugins: [valid] }).plugins[0], valid);
	for (const broken of [{ downloads: undefined }, { downloads: -1 }, { downloads: 1.5 }, { downloads: "3" }, { listedAt: undefined }, { listedAt: "2026-11-01" }, { listedAt: "2026-11-01T00:00:00.000Z" }])
		assert.throws(() => parseCommunityFeed({ schemaVersion: 1, plugins: [{ ...valid, ...broken }] }), /listing/, JSON.stringify(broken));
	const release = valid.releases[0]!;
	assert.equal(parseCommunityFeed({ schemaVersion: 1, plugins: [{ ...valid, releases: [{ ...release, featured: true }] }] }).plugins[0]!.releases[0]!.featured, true);
	for (const featured of [false, "true", 1]) assert.throws(() => parseCommunityFeed({ schemaVersion: 1, plugins: [{ ...valid, releases: [{ ...release, featured }] }] }), /release/);
	assert.equal("featured" in parseCommunityFeed({ schemaVersion: 1, plugins: [valid] }).plugins[0]!.releases[0]!, false);
});

test("Browse views drop listings without a release, sort by downloads or listing date, and mark only a reviewed offered release", () => {
	const release = (version: string, featured = false) => ({ version, apiVersion: 1, minAppVersion: "0.7.0", publishedAt: "2026-11-01T00:00:00Z", tag: `v${version}`, asset: "a.zip", sha256: sha(version[0]!), ...(featured ? { featured: true as const } : {}) });
	const offer = (id: string, downloads: number, listedAt: string, offered: ReturnType<typeof release> | null, releases = offered ? [offered] : []): CommunityOffer =>
		({ listing: catalogListing({ id, name: id, downloads, listedAt, releases }), release: offered, action: offered ? "Install" : null });
	const reviewedOld = release("1.0.0", true), unreviewedNew = release("2.0.0");
	const offers = [
		offer("alpha", 10, "2026-11-01T00:00:00Z", release("1.0.0", true)),
		offer("bravo", 50, "2026-11-10T00:00:00Z", unreviewedNew, [reviewedOld, unreviewedNew]),
		offer("charlie", 99, "2026-11-30T00:00:00Z", null),
		offer("delta", 10, "2026-11-20T00:00:00Z", release("3.0.0")),
	];
	const ids = (view: Parameters<typeof communityOffersFor>[1]) => communityOffersFor(offers, view).map(entry => entry.listing.id);
	assert.deepEqual(ids("featured"), ["alpha"]);
	assert.deepEqual(ids("downloads"), ["bravo", "alpha", "delta"], "ties fall back to name");
	assert.deepEqual(ids("newest"), ["delta", "bravo", "alpha"]);
	assert.equal(communityFeatured(offers[1]!), false, "a newer unreviewed release carries no mark");
	assert.equal(reviewedCommunityRelease(offers[1]!.listing)?.version, "1.0.0");
	assert.equal(reviewedCommunityRelease(offers[3]!.listing), null);
});

test("featured.json is the only source of featured flags, and the shipped feed matches it", () => {
	const listing = catalogListing();
	const feed = (featured: boolean) => ({ schemaVersion: 1 as const, plugins: [{ ...listing, releases: [{ ...listing.releases[0]!, ...(featured ? { featured: true as const } : {}) }] }] });
	const list = parseCommunityFeatured({ schemaVersion: 1, featured: [{ id: "sample", sha256: sha("a") }] });
	checkCommunityFeatured(feed(true), list);
	assert.throws(() => checkCommunityFeatured(feed(false), list), /out of sync/);
	assert.throws(() => checkCommunityFeatured(feed(true), parseCommunityFeatured({ schemaVersion: 1, featured: [] })), /out of sync/);
	assert.throws(() => checkCommunityFeatured(feed(false), parseCommunityFeatured({ schemaVersion: 1, featured: [{ id: "gone", sha256: sha("b") }] })), /not in the feed/);
	for (const broken of [{ schemaVersion: 2, featured: [] }, { schemaVersion: 1, featured: [{ id: "sample" }] }, { schemaVersion: 1, featured: [{ id: "sample", sha256: sha("a"), by: "me" }] }, { schemaVersion: 1, featured: [{ id: "sample", sha256: sha("a") }, { id: "sample", sha256: sha("a") }] }])
		assert.throws(() => parseCommunityFeatured(broken), JSON.stringify(broken));
	checkCommunityFeatured(parseCommunityFeed(seed, coreIds), parseCommunityFeatured(featuredList));
});

test("plugin details are cross-checked against their listing, size-capped, and every seed has one", () => {
	const listing = catalogListing();
	const valid = { schemaVersion: 1, id: "sample", readme: { tag: "v1.0.0", markdown: "# Sample" }, releases: [{ version: "1.0.0", notes: "" }] };
	assert.deepEqual(parseCommunityDetail(valid, listing), valid);
	assert.equal(parseCommunityDetail({ ...valid, readme: null }, listing).readme, null);
	for (const broken of [{ id: "other" }, { schemaVersion: 2 }, { readme: { tag: "v9.9.9", markdown: "" } }, { readme: { tag: "v1.0.0", markdown: "x".repeat(128 * 1024 + 1) } },
		{ releases: [{ version: "9.9.9", notes: "" }] }, { releases: [{ version: "1.0.0", notes: "x".repeat(16 * 1024 + 1) }] }, { releases: [{ version: "1.0.0", notes: "" }, { version: "1.0.0", notes: "" }] }])
		assert.throws(() => parseCommunityDetail({ ...valid, ...broken }, listing), JSON.stringify(broken).slice(0, 80));
	const { plugins } = parseCommunityFeed(seed, coreIds);
	assert.deepEqual(fs.readdirSync(new URL("../plugin-catalog/details/", import.meta.url)).sort(), plugins.map(plugin => `${plugin.id}.json`).sort());
	for (const plugin of plugins) {
		const bytes = fs.readFileSync(new URL(`../plugin-catalog/details/${plugin.id}.json`, import.meta.url));
		assert.ok(bytes.length <= 256 * 1024, plugin.id);
		const detail = parseCommunityDetail(JSON.parse(bytes.toString("utf8")), plugin);
		assert.equal(detail.readme === null, plugin.releases.length === 0, `${plugin.id}: a README snapshot exactly when there is a release`);
	}
});

test("the detail route needs community plugins on and a listed ID, and reports a bad or missing snapshot as unavailable", async t => {
	const f = fixture(t);
	await f.host.initialize();
	assert.equal((await f.detail()).status, 409);
	assert.deepEqual(f.fetched, [], "nothing is fetched while community plugins are off");
	await f.host.setCommunityEnabled(true);
	const ok = await f.detail();
	assert.equal(ok.status, 200);
	assert.equal(ok.body.detail.readme.markdown, "# Fixture");
	assert.deepEqual(f.fetched.slice(-2), [COMMUNITY_FEED_URL, communityDetailUrl(id)]);
	assert.equal((await f.detail("Bad/ID")).status, 400);
	assert.equal((await f.detail("not-listed")).status, 404);
	for (const response of [() => new Response("nope", { status: 404 }), () => Response.json({ schemaVersion: 1, id: "other", readme: null, releases: [] }),
		() => new Response("x".repeat(256 * 1024 + 1)), () => new Response(null, { status: 302, headers: { Location: "https://evil.example/x.json" } })]) {
		f.setDetail(response);
		const failed = await f.detail();
		assert.equal(failed.status, 503);
		assert.match(failed.body.error, /details are unavailable/);
	}
});
