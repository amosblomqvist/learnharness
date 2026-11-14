import assert from "node:assert/strict";
import { test } from "node:test";
import { forkVersion, parseForkVersion } from "../scripts/fork-version.ts";

test("constructs fork versions and handles sequence boundaries", () => {
	assert.equal(forkVersion("0.6.1", 1), "0.6.101");
	assert.equal(forkVersion("0.5.0", 1), "0.5.1");
	assert.equal(forkVersion("0.6.1", 12), "0.6.112");
	assert.equal(forkVersion("0.6.1", 99), "0.6.199");
});

test("rejects invalid versions and sequence numbers", () => {
	for (const version of ["0.6", "0.6.1-beta", "0.6.1.5", "01.2.3"]) {
		assert.throws(() => forkVersion(version, 1));
	}
	for (const n of [0, 100, 1.5, NaN, Infinity]) {
		assert.throws(() => forkVersion("0.6.1", n));
	}
});

test("parses fork versions and round trips", () => {
	assert.deepEqual(parseForkVersion("0.6.101"), { upstream: "0.6.1", n: 1 });
	for (const upstream of ["0.5.0", "0.6.1", "123.456.9007199254740993"]) {
		for (const n of [1, 12, 99]) {
			assert.deepEqual(parseForkVersion(forkVersion(upstream, n)), { upstream, n });
		}
	}
	assert.throws(() => parseForkVersion("0.6.100"));
	assert.throws(() => parseForkVersion("0.6.1-beta"));
});
