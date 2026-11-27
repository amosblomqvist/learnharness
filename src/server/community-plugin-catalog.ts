import { createHash } from "node:crypto";
import { COMMUNITY_DETAIL_LIMIT, COMMUNITY_FEED_LIMIT, COMMUNITY_FEED_URL, COMMUNITY_ZIP_LIMIT, communityDetailUrl, communityReleaseAsset, compatibleCommunityRelease, parseCommunityDetail, parseCommunityFeed, SHA256_PATTERN, type CommunityListing, type CommunityOffer, type CommunityRelease } from "../core/community-catalog.ts";
import { PLUGIN_API_VERSION, PLUGIN_ID_PATTERN, parsePluginManifest } from "../core/plugins.ts";
import { PluginHostError } from "./plugin-host.ts";
import { readCommunityPluginZip } from "./community-plugin-zip.ts";

type Host = ReturnType<typeof import("./plugin-host.ts").createPluginHost>;
const noStore = { "Cache-Control": "no-store" };
const redirectCodes = new Set([301, 302, 303, 307, 308]);
const cdnHosts = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
export async function boundedBytes(fetcher: typeof fetch, url: string, limit: number, signal: AbortSignal, asset = false): Promise<Buffer> {
	let target = new URL(url);
	for (let hops = 0; hops <= 3; hops++) {
		const response = await fetcher(target.href, { cache: "no-store", redirect: "manual", credentials: "omit", signal });
		if (redirectCodes.has(response.status)) {
			void response.body?.cancel().catch(() => {});
			const location = response.headers.get("Location");
			if (!asset || !location) throw new Error("Unexpected redirect");
			target = new URL(location, target);
			if (target.protocol !== "https:" || target.port || target.username || target.password || !cdnHosts.has(target.hostname)) throw new Error("Unexpected release asset host");
			continue;
		}
		if (response.status !== 200 || !response.body || Number(response.headers.get("content-length")) > limit) {
			void response.body?.cancel().catch(() => {});
			throw Object.assign(new Error("Download failed or exceeds the size limit"), { status: response.status });
		}
		const reader = response.body.getReader(), chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				if ((total += next.value.byteLength) > limit) throw new Error("Download exceeds the size limit");
				chunks.push(next.value);
			}
			return Buffer.concat(chunks, total);
		} finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
	}
	throw new Error("Too many release redirects");
}

export class CommunityReleaseError extends Error {
	constructor(readonly stage: "download" | "checksum" | "package", message: string) { super(message); }
}

/** Download, checksum and unpack a catalog release exactly as Install does.
 * Returns the files the host would write. The catalog checks scan this map. */
export async function verifyCommunityRelease(fetcher: typeof fetch, listing: CommunityListing, release: CommunityRelease, appVersion: string, signal: AbortSignal): Promise<Map<string, Buffer>> {
	let zip: Buffer;
	try { zip = await boundedBytes(fetcher, communityReleaseAsset(listing, release), COMMUNITY_ZIP_LIMIT, AbortSignal.any([signal, AbortSignal.timeout(45_000)]), true); }
	catch (error) { throw new CommunityReleaseError("download", error instanceof Error ? error.message : "Download failed"); }
	if (createHash("sha256").update(zip).digest("hex") !== release.sha256) throw new CommunityReleaseError("checksum", "The release ZIP does not match the catalog checksum");
	try {
		const files = readCommunityPluginZip(zip, listing.id);
		const raw = files.get("manifest.json");
		if (!raw || raw.length > 32 * 1024) throw new Error("Missing or oversized manifest");
		const manifest = parsePluginManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)), listing.id, appVersion);
		if (manifest.version !== release.version || manifest.apiVersion !== release.apiVersion || manifest.minAppVersion !== release.minAppVersion) throw new Error("Manifest does not match the catalog release");
		for (const entry of [manifest.main, manifest.backend, manifest.styles]) if (entry && !files.get(entry)?.length) throw new Error(`Missing or empty build file: ${entry}`);
		return files;
	} catch (error) { throw new CommunityReleaseError("package", error instanceof Error ? error.message : "invalid ZIP"); }
}

export function createCommunityPluginCatalog(deps: { fetch?: typeof fetch; getHost(): Promise<Host>; appVersion: string; coreIds: readonly string[] }) {
	const fetcher = deps.fetch ?? fetch;
	async function feed(signal: AbortSignal) {
		try {
			const bytes = await boundedBytes(fetcher, COMMUNITY_FEED_URL, COMMUNITY_FEED_LIMIT, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
			return parseCommunityFeed(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), deps.coreIds);
		} catch { throw new PluginHostError(503, "The community plugin catalog is unavailable. Try again later."); }
	}
	const releaseFor = (listing: CommunityListing) => compatibleCommunityRelease(listing, deps.appVersion, PLUGIN_API_VERSION);
	async function build(listing: CommunityListing, release: CommunityRelease, signal: AbortSignal) {
		try { return await verifyCommunityRelease(fetcher, listing, release, deps.appVersion, signal); }
		catch (error) {
			const stage = error instanceof CommunityReleaseError ? error.stage : "package";
			if (stage === "download") throw new PluginHostError(503, "Could not download the GitHub release ZIP. No plugin files changed.");
			if (stage === "checksum") throw new PluginHostError(409, "The release ZIP does not match the catalog checksum. No plugin files changed.");
			throw new PluginHostError(409, `Cannot install this package: ${error instanceof Error ? error.message : "invalid ZIP"}. No plugin files changed.`);
		}
	}
	const json = (body: unknown, status = 200) => Response.json(body, { status, headers: noStore });
	const handle = async (fn: () => Promise<Response>) => {
		try { return await fn(); }
		catch (error) {
			// Host may come from another Next route bundle.
			if (error && typeof error === "object" && Reflect.get(error, Symbol.for("learnharness.plugin-host-error"))) {
				const expected = error as PluginHostError;
				return json({ error: expected.message }, expected.status);
			}
			return json({ error: "Community plugin request failed." }, 500);
		}
	};
	return {
		list: (request: Request) => handle(async () => {
			const host = await deps.getHost();
			if (!host.communityEnabled()) throw new PluginHostError(409, "Turn on community plugins before browsing.");
			const { plugins } = await feed(request.signal);
			const offers: CommunityOffer[] = plugins.map(listing => {
				const release = releaseFor(listing);
				return { listing, release, action: release ? host.catalogAction(listing, release) : null };
			});
			return json({ offers });
		}),
		detail: (id: string, request: Request) => handle(async () => {
			if (id.length > 80 || !PLUGIN_ID_PATTERN.test(id)) throw new PluginHostError(400, "Invalid plugin ID");
			const host = await deps.getHost();
			if (!host.communityEnabled()) throw new PluginHostError(409, "Turn on community plugins before browsing.");
			const listing = (await feed(request.signal)).plugins.find(plugin => plugin.id === id);
			if (!listing) throw new PluginHostError(404, "This plugin is no longer listed. Refresh Browse.");
			try {
				const bytes = await boundedBytes(fetcher, communityDetailUrl(id), COMMUNITY_DETAIL_LIMIT, AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]));
				return json({ detail: parseCommunityDetail(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), listing) });
			} catch { throw new PluginHostError(503, "Plugin details are unavailable. Try again later."); }
		}),
		install: (id: string, request: Request) => handle(async () => {
			let selection: unknown;
			try { selection = await request.json(); } catch { throw new PluginHostError(400, "Invalid install request"); }
			const sha256 = selection && typeof selection === "object" ? Reflect.get(selection, "sha256") : undefined;
			const action = selection && typeof selection === "object" ? Reflect.get(selection, "action") : undefined;
			if (id.length > 80 || !PLUGIN_ID_PATTERN.test(id) || typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256) || (action !== "Install" && action !== "Update")) throw new PluginHostError(400, "Invalid install request");
			const host = await deps.getHost();
			if (!host.communityEnabled()) throw new PluginHostError(409, "Community plugins are off.");
			const listing = (await feed(request.signal)).plugins.find(plugin => plugin.id === id);
			const release = listing ? releaseFor(listing) : null;
			if (!listing || !release || release.sha256 !== sha256) throw new PluginHostError(409, "This release is no longer available. Refresh Browse and choose again.");
			if (host.catalogAction(listing, release) !== action) throw new PluginHostError(409, "This plugin cannot be installed or updated in its current state. Refresh Browse.");
			const files = await build(listing, release, request.signal);
			if (request.signal.aborted) throw new PluginHostError(409, "Installation was cancelled.");
			await host.installFromCatalog(listing, release, action, files, request.signal);
			return json({ restartRequired: action === "Update" });
		}),
	};
}
