/**
 * The installable web app (narrow-viewport series, 2026-11-14).
 *
 * Pins the manifest's install-critical contract and that every icon it
 * names actually exists in public/. A manifest pointing at a missing icon
 * fails silently in the browser, so the failure belongs here.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import manifest from "../app/manifest.ts";

const publicFile = (src: string) => fileURLToPath(new URL(`../public${src}`, import.meta.url));

describe("web app manifest", () => {
	const m = manifest();

	it("installs as a standalone app at the root", () => {
		assert.equal(m.start_url, "/");
		assert.equal(m.display, "standalone");
	});

	it("names the app the same way the window does", () => {
		assert.equal(m.name, "Learning Harness");
		assert.ok(m.short_name && m.short_name.length <= 12, "home-screen labels truncate early");
	});

	it("carries the two sizes Android requires", () => {
		const icons = m.icons ?? [];
		const sizes = icons.map((icon) => icon.sizes);
		assert.ok(sizes.includes("192x192"), "192x192 icon");
		assert.ok(sizes.includes("512x512"), "512x512 icon");
		assert.ok(icons.some((icon) => icon.purpose === "maskable"), "one maskable icon for adaptive launchers");
	});

	it("names only icons that exist in public/", () => {
		for (const icon of m.icons ?? []) assert.ok(existsSync(publicFile(String(icon.src))), `missing ${icon.src}`);
	});
});
