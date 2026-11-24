/**
 * Cluster presentation-rule tests. Wave 7 killed the semantic detection
 * AND the LLM label matcher (birth-session clusters, session-name labels —
 * core/session-clusters.ts has its own suite); what remains pinned here
 * is the render threshold and the hull-color spread the UI leans on.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MIN_CLUSTER_SIZE } from "../src/core/clusters.ts";
import { clusterHue } from "../components/cluster-geometry.ts";

describe("MIN_CLUSTER_SIZE", () => {
	test("is 3 (the render threshold — below this, no hull)", () => {
		assert.equal(MIN_CLUSTER_SIZE, 3);
	});
});

describe("clusterHue", () => {
	test("is stable per id and spreads", () => {
		// Same id → same hue, always; different ids → usually different hues.
		assert.equal(clusterHue("cluster-a"), clusterHue("cluster-a"));
		const hues = new Set<number>();
		for (let i = 0; i < 40; i++) hues.add(clusterHue(`cluster-${i}`));
		assert.ok(hues.size > 20, `expected spread, got ${hues.size} distinct hues for 40 ids`);
		for (const h of hues) assert.ok(h >= 0 && h < 360);
	});
});