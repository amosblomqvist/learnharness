import { PLUGIN_ID_PATTERN } from "./plugins.ts";
import coreIds from "../../core-plugins.json";

export interface CatalogPlugin {
	id: string;
	name: string;
	summary: string;
	features: string[];
	version: string;
	minAppVersion: string;
	sourceUrl: string;
	releaseUrl: string;
	sha256: string;
	issueNumber: number;
}
export interface PluginCatalog { schemaVersion: 1; plugins: CatalogPlugin[] }

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const text = (value: unknown, max: number) => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;
const githubRepo = (value: string) => {
	let url: URL;
	try { url = new URL(value); } catch { return false; }
	return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.search && !url.hash && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname);
};
const githubRelease = (value: string) => {
	let url: URL;
	try { url = new URL(value); } catch { return false; }
	return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.search && !url.hash && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[^/]+\/[^/]+\.zip$/i.test(url.pathname);
};

export function comparePluginVersions(a: string, b: string): number {
	if (!versionPattern.test(a) || !versionPattern.test(b)) throw Error("Invalid plugin version");
	const left = a.split(".").map(BigInt), right = b.split(".").map(BigInt);
	for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]! ? 1 : -1;
	return 0;
}

export function parsePluginCatalog(value: unknown): PluginCatalog {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid plugin catalog");
	const raw = value as Record<string, unknown>;
	if (raw.schemaVersion !== 1 || !Array.isArray(raw.plugins) || raw.plugins.length > 500) throw Error("Unsupported plugin catalog");
	const seen = new Set<string>();
	const plugins = raw.plugins.map((entry): CatalogPlugin => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw Error("Invalid catalog entry");
		const p = entry as Record<string, unknown>;
		if (typeof p.id !== "string" || !PLUGIN_ID_PATTERN.test(p.id) || seen.has(p.id) || coreIds.includes(p.id)) throw Error("Invalid, reserved or duplicate catalog ID");
		seen.add(p.id);
		if (!text(p.name, 100) || !text(p.summary, 500)) throw Error(`Invalid catalog text: ${p.id}`);
		if (!Array.isArray(p.features) || p.features.length > 20 || p.features.some(f => !text(f, 60))) throw Error(`Invalid features: ${p.id}`);
		if (typeof p.version !== "string" || !versionPattern.test(p.version) || typeof p.minAppVersion !== "string" || !versionPattern.test(p.minAppVersion)) throw Error(`Invalid versions: ${p.id}`);
		if (typeof p.sourceUrl !== "string" || !githubRepo(p.sourceUrl) || typeof p.releaseUrl !== "string" || !githubRelease(p.releaseUrl)) throw Error(`Invalid GitHub URLs: ${p.id}`);
		if (new URL(p.releaseUrl).pathname.split("/").slice(0, 3).join("/").toLowerCase() !== new URL(p.sourceUrl).pathname.replace(/\/$/, "").toLowerCase()) throw Error(`Release must belong to source repository: ${p.id}`);
		if (typeof p.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(p.sha256)) throw Error(`Invalid SHA-256: ${p.id}`);
		if (!Number.isSafeInteger(p.issueNumber) || (p.issueNumber as number) < 1) throw Error(`Invalid issue number: ${p.id}`);
		return { id: p.id, name: p.name as string, summary: p.summary as string, features: p.features as string[], version: p.version, minAppVersion: p.minAppVersion, sourceUrl: p.sourceUrl, releaseUrl: p.releaseUrl, sha256: p.sha256, issueNumber: p.issueNumber as number };
	});
	return { schemaVersion: 1, plugins };
}
