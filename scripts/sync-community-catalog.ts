import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import coreIds from "../core-plugins.json";
import { COMMUNITY_FEED_LIMIT, parseCommunityFeed } from "../src/core/community-catalog.ts";

const args = process.argv.slice(2);
const check = args[0] === "--check";
if (check) args.shift();
if (args.length !== 1) throw new Error("Usage: tsx scripts/sync-community-catalog.ts [--check] <website-checkout>");
const site = resolve(args[0]!);
const config = JSON.parse(readFileSync(resolve(site, "wrangler.jsonc"), "utf8"));
if (config.name !== "learnharness-web") throw new Error("Expected a LearnHarness website checkout");
const bytes = readFileSync(new URL("../plugin-catalog/community-plugins.json", import.meta.url));
if (bytes.length > COMMUNITY_FEED_LIMIT) throw new Error("Catalog exceeds public feed size limit");
parseCommunityFeed(JSON.parse(bytes.toString("utf8")), coreIds);
const destination = resolve(site, "community-plugins.json");
if (check) {
	if (!bytes.equals(readFileSync(destination))) throw new Error("Website mirror differs from app catalog");
} else {
	const temporary = `${destination}.${randomUUID()}.tmp`;
	try { writeFileSync(temporary, bytes, { flag: "wx" }); renameSync(temporary, destination); }
	finally { rmSync(temporary, { force: true }); }
}
console.log(`${check ? "Verified" : "Synced"} ${destination}`);
