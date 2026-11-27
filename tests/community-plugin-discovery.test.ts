import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parseCommunityFeed, type CommunityListing, type CommunityRelease } from "../src/core/community-catalog.ts";
import { communityZipManifestIds } from "../src/server/community-plugin-zip.ts";
import { code, discoverCommunityPlugins, GITHUB_API, renderDiscoveryReport, serializeCommunityFeed } from "../scripts/discover-community-plugins.ts";
import { OSV_BATCH_URL } from "../scripts/check-community-catalog.ts";
import { zip } from "./community-zip.ts";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const noExceptions = { schemaVersion: 1, exceptions: [] };
type Manifest = Record<string, unknown>;
function plugin(id: string, version: string, options: { wrapped?: boolean; manifest?: Manifest; main?: string } = {}) {
	const manifest = { id, name: `Plugin ${id}`, version, minAppVersion: "0.7.0", apiVersion: 1, main: "main.js", ...options.manifest };
	const prefix = options.wrapped ? `${id}/dist/` : "";
	return zip([[`${prefix}manifest.json`, JSON.stringify(manifest)], [`${prefix}main.js`, options.main ?? "export function activate() {}"]]);
}
const listed = (id: string, repository: string, releases: Partial<CommunityRelease>[] = []): CommunityListing => ({
	id, name: `Hand name ${id}`, author: "Hand author", description: "Hand description", repository,
	releases: releases.map(release => ({ version: "1.0.0", apiVersion: 1, minAppVersion: "0.7.0", publishedAt: "2026-11-01T00:00:00Z", tag: "v1.0.0", asset: `${id}.zip`, sha256: "0".repeat(64), ...release })),
});

interface Release { tag: string; assets: { name: string; bytes?: Buffer; digest?: string | null }[]; published?: string }
interface Repo { description?: string | null; archived?: boolean; owner?: string; latest?: Release; tags?: Release[] }

/** A fake GitHub: topic search, repos, releases, asset downloads, plus raw and OSV for the checks. */
function github(world: { topic?: string[]; repos: Record<string, Repo> }) {
	const requests: { url: string; authorization: string | null }[] = [];
	const repo = (name: string) => Object.entries(world.repos).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
	const shape = (full_name: string, value: Repo) => ({ full_name, description: value.description ?? null, archived: !!value.archived, owner: { login: value.owner ?? full_name.split("/")[0] } });
	const release = (value: Release) => ({ tag_name: value.tag, published_at: value.published ?? "2026-11-20T10:00:00Z", assets: value.assets.map(({ name, bytes, digest }) => ({ name, digest: digest === undefined ? (bytes ? `sha256:${sha(bytes)}` : null) : digest })) });
	const fetcher: typeof fetch = async (input, init) => {
		const url = String(input);
		requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
		if (url.startsWith(`${GITHUB_API}/search/repositories?`)) {
			const items = (world.topic ?? []).map(name => shape(name, repo(name)!));
			return Response.json({ items });
		}
		let match = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)(\/releases\/(?:latest|tags\/(.+)))?$/.exec(url);
		if (match) {
			const value = repo(match[1]!);
			if (!value) return new Response("", { status: 404 });
			if (!match[2]) return Response.json(shape(match[1]!, value));
			const found = match[3] ? [...value.tags ?? [], ...value.latest ? [value.latest] : []].find(entry => entry.tag === decodeURIComponent(match![3]!)) : value.latest;
			return found ? Response.json(release(found)) : new Response("", { status: 404 });
		}
		match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(url);
		if (match) {
			const value = repo(match[1]!);
			const bytes = [...value?.tags ?? [], ...value?.latest ? [value.latest] : []].find(entry => entry.tag === match![2])?.assets.find(asset => asset.name === match![3])?.bytes;
			return bytes ? new Response(Uint8Array.from(bytes)) : new Response("", { status: 404 });
		}
		if (url.startsWith("https://raw.githubusercontent.com/")) return new Response("", { status: 404 });
		if (url === OSV_BATCH_URL) return Response.json({ results: [] });
		throw new Error(`unexpected request ${url}`);
	};
	return { fetcher, requests };
}

test("manifest ids are read from the root or the wrapped <id>/dist/ layout", () => {
	assert.deepEqual(communityZipManifestIds(plugin("root-one", "1.0.0")), [""]);
	assert.deepEqual(communityZipManifestIds(plugin("wrapped-one", "1.0.0", { wrapped: true })), ["wrapped-one"]);
	assert.deepEqual(communityZipManifestIds(zip([["a/dist/manifest.json", "{}"], ["manifest.json", "{}"], ["a/docs/manifest.json", "{}"]])), ["a", ""]);
});

test("discovery lists new topic repos and appends new releases without touching listings", async () => {
	const fresh = plugin("fresh", "0.2.0", { wrapped: true, manifest: { description: "  From the manifest. " } });
	const fallback = plugin("fallback", "1.0.0");
	const update = plugin("kept", "2.0.0");
	const { fetcher, requests } = github({
		topic: ["New/fresh-plugin", "Other/fallback-plugin", "owner/kept-plugin"],
		repos: {
			"New/fresh-plugin": { latest: { tag: "v0.2.0", assets: [{ name: "fresh.zip", bytes: fresh }, { name: "notes.txt" }] } },
			"Other/fallback-plugin": { description: "Repository description", owner: "octo", latest: { tag: "1.0.0", assets: [{ name: "fallback-1.0.0.zip", bytes: fallback }] } },
			"owner/kept-plugin": { latest: { tag: "v2.0.0", assets: [{ name: "kept-2.0.0.zip", bytes: update }] }, tags: [{ tag: "v1.0.0", assets: [{ name: "kept.zip", digest: null }] }] },
			"owner/current": { latest: { tag: "v1.0.0", assets: [{ name: "current.zip", digest: null }] } },
		},
	});
	const feed = { schemaVersion: 1, plugins: [listed("current", "owner/current", [{}]), listed("kept", "owner/kept-plugin", [{ asset: "kept.zip" }])] };
	const result = await discoverCommunityPlugins({ feed, exceptions: noExceptions, fetch: fetcher, token: "secret-token" });

	assert.deepEqual(result.feed.plugins.map(listing => listing.id), ["current", "fallback", "fresh", "kept"]);
	const [current, fallbackListing, freshListing, kept] = result.feed.plugins;
	assert.deepEqual(current, feed.plugins[0], "an up-to-date listing is unchanged");
	assert.deepEqual({ ...kept, releases: undefined }, { ...feed.plugins[1], releases: undefined }, "listing metadata is never rewritten");
	assert.deepEqual(kept!.releases.map(release => [release.version, release.asset]), [["2.0.0", "kept-2.0.0.zip"], ["1.0.0", "kept.zip"]]);
	assert.deepEqual(freshListing, { id: "fresh", name: "Plugin fresh", author: "New", description: "From the manifest.", repository: "New/fresh-plugin", releases: [
		{ version: "0.2.0", apiVersion: 1, minAppVersion: "0.7.0", publishedAt: "2026-11-20T10:00:00Z", tag: "v0.2.0", asset: "fresh.zip", sha256: sha(fresh) },
	] });
	assert.deepEqual([fallbackListing!.author, fallbackListing!.description, fallbackListing!.releases[0]!.tag], ["octo", "Repository description", "1.0.0"]);
	assert.deepEqual(result.report.added.map(entry => `${entry.id}@${entry.version} ${entry.newListing}`), ["kept@2.0.0 false", "fresh@0.2.0 true", "fallback@1.0.0 true"]);
	assert.deepEqual([result.report.failed, result.report.skipped, result.report.attention], [[], [], []]);
	assert.equal(result.report.checked, 4);

	assert.ok(requests.some(request => request.url.startsWith(GITHUB_API)));
	for (const request of requests) assert.equal(request.authorization, request.url.startsWith(`${GITHUB_API}/`) ? "Bearer secret-token" : null, request.url);
	assert.deepEqual(parseCommunityFeed(JSON.parse(serializeCommunityFeed(result.feed))), result.feed);
});

test("releases that cannot be listed are skipped with a reason", async () => {
	const ok = (id: string) => plugin(id, "1.0.0");
	const { fetcher } = github({
		topic: ["a/no-zip", "a/two-zips", "a/bad-tag", "a/bad-digest", "a/core", "a/taken", "a/twin-one", "a/twin-two", "a/no-description", "a/no-release", "a/two-manifests"],
		repos: {
			"a/no-zip": { description: "d", latest: { tag: "v1.0.0", assets: [{ name: "source.tar.gz" }] } },
			"a/two-zips": { description: "d", latest: { tag: "v1.0.0", assets: [{ name: "x.zip", bytes: ok("x") }, { name: "y.ZIP", bytes: ok("y") }] } },
			"a/bad-tag": { description: "d", latest: { tag: "release-1", assets: [{ name: "bad-tag.zip", bytes: ok("bad-tag") }] } },
			"a/bad-digest": { description: "d", latest: { tag: "v1.0.0", assets: [{ name: "bad-digest.zip", bytes: ok("bad-digest"), digest: `sha256:${"1".repeat(64)}` }] } },
			"a/core": { description: "d", latest: { tag: "v1.0.0", assets: [{ name: "core.zip", bytes: ok("flashcards") }] } },
			"a/taken": { description: "d", latest: { tag: "v1.0.0", assets: [{ name: "taken.zip", bytes: ok("listed-one") }] } },
			"a/twin-one": { description: "d", latest: { tag: "v1.0.0", assets: [{ name: "twin.zip", bytes: ok("twin") }] } },
			"a/twin-two": { description: "d", latest: { tag: "v1.0.0", assets: [{ name: "twin.zip", bytes: ok("twin") }] } },
			"a/no-description": { latest: { tag: "v1.0.0", assets: [{ name: "plain.zip", bytes: ok("plain") }] } },
			"a/no-release": {},
			"a/two-manifests": { description: "d", latest: { tag: "v1.0.0", assets: [{ name: "two.zip", bytes: zip([["manifest.json", "{}"], ["two/dist/manifest.json", "{}"]]) }] } },
			"owner/listed-one": { latest: { tag: "v1.0.0", assets: [{ name: "listed-one.zip", digest: null }] } },
		},
	});
	const feed = { schemaVersion: 1, plugins: [listed("listed-one", "owner/listed-one", [{}])] };
	const result = await discoverCommunityPlugins({ feed, exceptions: noExceptions, fetch: fetcher });
	assert.deepEqual(result.feed, parseCommunityFeed(feed), "nothing is listed");
	assert.deepEqual(result.report.skipped.map(entry => `${entry.repository}: ${entry.reason}`).sort(), [
		"a/bad-digest: release v1.0.0: downloaded bad-digest.zip does not match GitHub's digest",
		"a/bad-tag: release release-1: tag release-1 does not match manifest version 1.0.0",
		"a/core: id flashcards is reserved by a Core plugin",
		"a/no-description: no description in manifest.json or the GitHub repository",
		"a/no-release: no stable GitHub release",
		"a/no-zip: release v1.0.0 has 0 uploaded .zip assets; expected exactly one",
		"a/taken: id listed-one is already listed for owner/listed-one",
		"a/twin-one: id twin is claimed by more than one new repository (a/twin-one, a/twin-two); a maintainer decides",
		"a/twin-two: id twin is claimed by more than one new repository (a/twin-one, a/twin-two); a maintainer decides",
		"a/two-manifests: release v1.0.0: expected one built manifest at the ZIP root or <id>/dist/",
		"a/two-zips: release v1.0.0 has 2 uploaded .zip assets; expected exactly one",
	]);
});

test("a release that fails the static checks is reported, unless a maintainer excused it", async () => {
	const sneaky = plugin("sneaky", "1.0.0", { manifest: { description: "d" }, main: "export function activate() { eval(atob('YQ==')); }" });
	const world = { topic: ["a/sneaky"], repos: { "a/sneaky": { latest: { tag: "v1.0.0", assets: [{ name: "sneaky.zip", bytes: sneaky }] } } } };
	const failed = await discoverCommunityPlugins({ feed: { schemaVersion: 1, plugins: [] }, exceptions: noExceptions, fetch: github(world).fetcher });
	assert.deepEqual(failed.feed.plugins, []);
	assert.deepEqual(failed.report.failed.map(entry => [entry.id, entry.version, entry.findings.map(finding => finding.replace(/ at offset .*/, ""))]), [["sneaky", "1.0.0", ["obfuscation main.js: eval("]]]);

	const exceptions = { schemaVersion: 1, exceptions: [{ id: "sneaky", version: "1.0.0", rule: "obfuscation", file: "main.js", reason: "Reviewed: decodes a constant." }] };
	const excused = await discoverCommunityPlugins({ feed: { schemaVersion: 1, plugins: [] }, exceptions, fetch: github(world).fetcher });
	assert.deepEqual(excused.feed.plugins.map(listing => listing.id), ["sneaky"]);
	assert.deepEqual(excused.report.added[0]!.excused, ["obfuscation main.js"]);
});

test("missing repos and releases are reported but never removed", async () => {
	const { fetcher } = github({
		repos: {
			"owner/archived": { archived: true },
			"owner/changed": { latest: { tag: "v1.0.0", assets: [{ name: "changed.zip", digest: `sha256:${"2".repeat(64)}` }] } },
			"owner/deleted-release": { tags: [] },
		},
	});
	const feed = { schemaVersion: 1, plugins: [listed("archived", "owner/archived", [{}]), listed("changed", "owner/changed", [{}]), listed("deleted-release", "owner/deleted-release", [{}]), listed("gone", "owner/gone", [{}])] };
	const result = await discoverCommunityPlugins({ feed, exceptions: noExceptions, fetch: fetcher });
	assert.deepEqual(result.feed, parseCommunityFeed(feed));
	assert.deepEqual(result.report.attention.map(entry => `${entry.repository}: ${entry.reason}`), [
		"owner/archived: repository is archived",
		"owner/changed: listed release v1.0.0 asset changed.zip changed (GitHub digest no longer matches the catalog sha256)",
		"owner/deleted-release: listed release v1.0.0 not found",
		"owner/deleted-release: no stable GitHub release",
		"owner/gone: repository not found",
	]);
});

test("a listing keeps at most 24 releases by dropping the lowest version", async () => {
	const releases = Array.from({ length: 24 }, (_, i) => ({ version: `1.${i}.0`, tag: `v1.${i}.0`, asset: `capped-1.${i}.0.zip` }));
	const next = plugin("capped", "2.0.0");
	const { fetcher } = github({ repos: { "owner/capped": { latest: { tag: "v2.0.0", assets: [{ name: "capped.zip", bytes: next }] }, tags: releases.map(release => ({ tag: release.tag, assets: [{ name: release.asset, digest: null }] })) } } });
	const result = await discoverCommunityPlugins({ feed: { schemaVersion: 1, plugins: [listed("capped", "owner/capped", releases)] }, exceptions: noExceptions, fetch: fetcher });
	const versions = result.feed.plugins[0]!.releases.map(release => release.version);
	assert.equal(versions.length, 24);
	assert.equal(versions[0], "2.0.0");
	assert.ok(!versions.includes("1.0.0") && versions.includes("1.1.0"));

	const older = plugin("capped", "0.9.0");
	const backport = github({ repos: { "owner/capped": { latest: { tag: "v0.9.0", assets: [{ name: "capped-0.9.0.zip", bytes: older }] }, tags: releases.map(release => ({ tag: release.tag, assets: [{ name: release.asset, digest: null }] })) } } });
	const full = await discoverCommunityPlugins({ feed: { schemaVersion: 1, plugins: [listed("capped", "owner/capped", releases)] }, exceptions: noExceptions, fetch: backport.fetcher });
	assert.equal(full.feed.plugins[0]!.releases.length, 24);
	assert.deepEqual([full.report.added, full.report.skipped.map(entry => entry.reason)], [[], ["release v0.9.0: version 0.9.0 is lower than all 24 listed releases"]]);
});

test("a version already listed under its other tag spelling is skipped", async () => {
	const again = plugin("respelled", "1.0.0");
	const { fetcher } = github({ repos: { "owner/respelled": { latest: { tag: "v1.0.0", assets: [{ name: "respelled.zip", bytes: again }] }, tags: [{ tag: "1.0.0", assets: [{ name: "respelled.zip", digest: null }] }] } } });
	const feed = { schemaVersion: 1, plugins: [listed("respelled", "owner/respelled", [{ tag: "1.0.0", asset: "respelled.zip" }])] };
	const result = await discoverCommunityPlugins({ feed, exceptions: noExceptions, fetch: fetcher });
	assert.deepEqual(result.feed, parseCommunityFeed(feed));
	assert.deepEqual(result.report.skipped.map(entry => entry.reason), ["release v1.0.0: version 1.0.0 is already listed as tag 1.0.0"]);
});

test("the report shows untrusted text as inert code", () => {
	assert.equal(code("plain"), "` plain `");
	assert.equal(code("a `tick` and ``two``\nline"), "``` a `tick` and ``two`` line ```");
	const report = renderDiscoveryReport({ checked: 1, added: [], failed: [], attention: [], skipped: [{ repository: "a/b", reason: "@maintainer see [here](https://evil.example) <img src=x>" }] });
	assert.match(report, /^- \[a\/b\]\(https:\/\/github\.com\/a\/b\): ` @maintainer see \[here\]\(https:\/\/evil\.example\) <img src=x> `$/m);
});
