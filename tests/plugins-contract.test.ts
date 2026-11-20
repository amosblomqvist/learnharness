import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePluginManifest } from "../src/core/plugins.ts";

const manifest = { apiVersion: 1, id: "example-plugin", name: "Example", version: "1.0.0", minAppVersion: "0.3.7", main: "main.js", backend: "backend.cjs", styles: "styles.css" };
describe("plugin package contract", () => {
	it("accepts frontend, backend, or combined packages, dropping unsupported fields", () => {
		assert.deepEqual(parsePluginManifest({ ...manifest, future: true }, "example-plugin", "0.3.7"), manifest);
		assert.equal(parsePluginManifest({ ...manifest, main: undefined, styles: undefined }, "example-plugin", "0.4.0").backend, "backend.cjs");
		assert.equal(parsePluginManifest({ ...manifest, backend: undefined }, "example-plugin", "1.0.0").main, "main.js");
	});
	it("refuses incompatible API/app versions before code executes", () => {
		assert.throws(() => parsePluginManifest({ ...manifest, apiVersion: 2 }, "example-plugin", "0.3.7"), /apiVersion/);
		assert.throws(() => parsePluginManifest(manifest, "example-plugin", "0.3.6"), /Requires/);
		assert.throws(() => parsePluginManifest({ ...manifest, minAppVersion: "0.4.0" }, "example-plugin", "0.3.99"), /Requires/);
		assert.doesNotThrow(() => parsePluginManifest(manifest, "example-plugin", "0.4.0"));
		assert.doesNotThrow(() => parsePluginManifest(manifest, "example-plugin", "1.0.0"));
	});
	it("rejects ambiguous identity, invalid types, and versions", () => {
		for (const bad of [null, [], {}, { ...manifest, id: "different" }, { ...manifest, version: "01.0.0" }, { ...manifest, name: " " }, { ...manifest, description: 4 }, { ...manifest, main: undefined, backend: undefined, styles: undefined }]) {
			assert.throws(() => parsePluginManifest(bad, "example-plugin", "0.3.7"));
		}
		assert.throws(() => parsePluginManifest(manifest, "../example-plugin", "0.3.7"));
	});
	it("keeps package entry files out of data, traversal, and absolute paths", () => {
		for (const main of ["../main.js", "data/main.js", "/main.js", "assets/main.js", "main.cjs", "main.js?x", ".env.js", "main\\x.js"]) {
			assert.throws(() => parsePluginManifest({ ...manifest, main }, "example-plugin", "0.3.7"));
		}
		assert.throws(() => parsePluginManifest({ ...manifest, backend: "backend.js" }, "example-plugin", "0.3.7"));
		assert.throws(() => parsePluginManifest({ ...manifest, main: undefined }, "example-plugin", "0.3.7"), /styles/);
	});
});
