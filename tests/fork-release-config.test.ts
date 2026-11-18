import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { parseForkVersion } from "../scripts/fork-version";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load(source: string): any };
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

describe("fork release configuration", () => {
	it("provides a Windows-compatible local distribution script", () => {
		const script = JSON.parse(read("package.json")).scripts["desktop:dist:win"];
		assert.equal(typeof script, "string");
		assert.doesNotMatch(script, /rm -rf|\$\{|(^|&&\s*)[A-Z_]+=\S+/);
		assert.match(script, /electron-builder --win --x64 --publish never$/);
	});

	it("uses the fork identity and update feed", () => {
		const config = yaml.load(read("electron-builder.yml"));
		assert.equal(config.appId, "com.reeschan.learnharness");
		assert.equal(config.productName, "LearnHarness Fork");
		assert.deepEqual(config.publish.map(({ provider, owner, repo }: Record<string, unknown>) => ({ provider, owner, repo })), [
			{ provider: "github", owner: "reeschan", repo: "learnharness" },
		]);
	});

	it("uses a valid fork version and a separate application data name", () => {
		const pkg = JSON.parse(read("package.json"));
		assert.deepEqual(parseForkVersion(pkg.version), { upstream: "0.6.1", n: 1 });
		assert.match(read("electron/main.cjs"), /const PRODUCT_NAME = "LearnHarness Fork";/);
	});

	it("keeps the lockfile package identity in sync", () => {
		const pkg = JSON.parse(read("package.json"));
		const lock = JSON.parse(read("package-lock.json"));
		assert.equal(lock.name, pkg.name);
		assert.equal(lock.version, pkg.version);
		assert.equal(lock.packages[""].name, pkg.name);
		assert.equal(lock.packages[""].version, pkg.version);
	});
});
