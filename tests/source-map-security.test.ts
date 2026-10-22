/**
 * source-map-js 1.2.2 regression for GHSA-68fv-2mgg-jv7q / CVE-2026-93749.
 *
 * The advisory covers indexed source-map section offsets that feed a
 * synchronous line-padding loop. The 1.2.2 release also changes three
 * neighbouring paths: SourceNode stops when the generated code is exhausted,
 * the indexed `sources` getter reads each nested consumer once, and the
 * generator serializes large line gaps with one flat string.
 *
 * Every fixture with an untrusted (or otherwise attacker-shaped) offset runs
 * in its own Node child process. The child gets an allowlisted environment,
 * a 64 MB V8 old-space cap, a 5 s SIGKILL deadline, a bounded output buffer,
 * and a createRequire anchor inside this isolated source tree. That anchor
 * check rejects a resolution that falls back to an ancestor copy.
 *
 * The accepted 1e7 boundary cases inspect eachMapping only. They are never
 * serialized: output size stays proportional to the gap for a flat
 * generator, so this suite deliberately does not re-run the historical
 * stress payload.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, it } from "node:test";

import { SourceMapConsumer, SourceMapGenerator, SourceNode } from "source-map-js";
import type { MappingItem, RawSourceMap } from "source-map-js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const SOURCE_MAP_JS_ENTRY = fs.realpathSync(require.resolve("source-map-js"));
const SOURCE_MAP_JS_ROOT = path.dirname(SOURCE_MAP_JS_ENTRY);
const CHILD_TIMEOUT_MS = 5_000;
const CHILD_MAX_BUFFER = 32 * 1024;

type BasicMap = {
	version: number;
	sources: string[];
	sourcesContent?: string[];
	names: string[];
	mappings: string;
	file?: string;
	sourceRoot?: string;
};

type IndexedMap = {
	version: number;
	sections: Array<{ offset: { line: number; column: number }; map: RawMap }>;
};

type RawMap = BasicMap | IndexedMap;

type MappingRow = Pick<
	MappingItem,
	"source" | "generatedLine" | "generatedColumn" | "originalLine" | "originalColumn"
>;

type ChildResult = {
	outcome: "threw" | "accepted";
	message?: string;
	rows?: Array<{
		source: string | null;
		line: number;
		column: number;
		originalLine: number | null;
		originalColumn: number | null;
	}>;
	innerLines?: number[];
	sources?: string[];
	reads?: number;
	length?: number;
	suffix?: string;
	exact?: boolean;
	children?: number;
	sample?: string;
};

function flat(source = "a.js", content = "a"): BasicMap {
	return {
		version: 3,
		sources: [source],
		sourcesContent: [content],
		names: [],
		mappings: "AAAA",
	};
}

function indexed(line: number, column: number, map: RawMap = flat()): IndexedMap {
	return { version: 3, sections: [{ offset: { line, column }, map }] };
}

function nested(levels: number, line: number, column: number): RawMap {
	let map: RawMap = flat();
	for (let level = 0; level < levels; level += 1) {
		map = indexed(line, column, map);
	}
	return map;
}

function consume(map: RawMap): SourceMapConsumer {
	// The fixture uses numeric `version` and indexed sections; the published
	// typings describe the flat shape only.
	return new SourceMapConsumer(map as unknown as RawSourceMap);
}

function rowsOf(consumer: SourceMapConsumer): MappingRow[] {
	const rows: MappingRow[] = [];
	consumer.eachMapping((mapping) => {
		rows.push({
			source: mapping.source,
			generatedLine: mapping.generatedLine,
			generatedColumn: mapping.generatedColumn,
			originalLine: mapping.originalLine,
			originalColumn: mapping.originalColumn,
		});
	});
	return rows;
}

function packageVersionAt(dir: string): string {
	const parsed = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
		version?: string;
	};
	assert.ok(parsed.version, `${dir} has no package version`);
	return parsed.version;
}

function assertAtLeastFixedVersion(version: string, label: string): void {
	// Stable semver only: optional build metadata is allowed, prereleases and
	// trailing junk are not. This keeps a value such as 1.2.2-alpha from
	// being read as the fixed release.
	const match =
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
			version,
		);
	assert.ok(match, `${label}: source-map-js version ${version} is not a stable semantic version`);
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	assert.ok(
		major > 1 || (major === 1 && (minor > 2 || (minor === 2 && patch >= 2))),
		`${label}: source-map-js ${version} is below the first fixed release 1.2.2`,
	);
}

/**
 * Child worker. It is plain CommonJS because it runs through `node -e`; the
 * require anchor makes this tree the only place package resolution may land.
 */
const CHILD_SCRIPT = String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const anchor = process.argv[1];
const expectedRoot = process.argv[2];
const mode = process.argv[3];
const field = process.argv[4];
const code = process.argv[5];

function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function fatal(message) {
  process.stderr.write(message + "\n");
  process.exit(2);
}

const req = createRequire(anchor);
let resolved;
try {
  resolved = fs.realpathSync(req.resolve("source-map-js"));
} catch (error) {
  fatal("source-map-js did not resolve: " + error.message);
}
let expected;
try {
  expected = fs.realpathSync(path.join(expectedRoot, "node_modules", "source-map-js"));
} catch (error) {
  fatal("isolated source-map-js is missing: " + error.message);
}
if (resolved !== path.join(expected, "source-map.js") && !resolved.startsWith(expected + path.sep)) {
  fatal("source-map-js resolved outside the isolated tree: " + resolved);
}

const { SourceMapConsumer, SourceMapGenerator, SourceNode } = req("source-map-js");

function flat(source, content) {
  return {
    version: 3,
    sources: [source === undefined ? "a.js" : source],
    sourcesContent: [content === undefined ? "a" : content],
    names: [],
    mappings: "AAAA",
  };
}

function indexed(line, column, map) {
  return { version: 3, sections: [{ offset: { line: line, column: column }, map: map === undefined ? flat() : map }] };
}

function nested(levels, line, column) {
  let map = flat();
  for (let level = 0; level < levels; level += 1) {
    map = indexed(line, column, map);
  }
  return map;
}

function rows(consumer) {
  const result = [];
  consumer.eachMapping(function (mapping) {
    result.push({
      source: mapping.source,
      line: mapping.generatedLine,
      column: mapping.generatedColumn,
      originalLine: mapping.originalLine,
      originalColumn: mapping.originalColumn,
    });
  });
  return result;
}

function reject(action) {
  try {
    action();
    emit({ outcome: "accepted" });
  } catch (error) {
    emit({ outcome: "threw", name: error.name, message: String(error.message) });
  }
}

const INVALID = {
  negative: -1,
  fraction: 1.5,
  string: "1",
  null: null,
  undefined: undefined,
  nan: NaN,
  infinity: Infinity,
  "negative-infinity": -Infinity,
  "unsafe-integer": 9007199254740992,
};

if (mode === "reject-invalid") {
  const offset = { line: 0, column: 0 };
  offset[field] = INVALID[code];
  reject(function () {
    new SourceMapConsumer(indexed(offset.line, offset.column));
  });
} else if (mode === "reject-json-infinity") {
  const wire = JSON.parse(
    '{"version":3,"sections":[{"offset":{"line":1e999,"column":0},"map":{"version":3,"sources":["a.js"],"sourcesContent":["a"],"names":[],"mappings":"AAAA"}}]}'
  );
  reject(function () {
    new SourceMapConsumer(wire);
  });
} else if (mode === "reject-above-limit") {
  reject(function () {
    new SourceMapConsumer(indexed(10000001, 0));
  });
} else if (mode === "reject-nested-total") {
  // The two-level nest adds up to exactly 1e7 and must be accepted. The
  // third level pushes the total over the cap, so the rejection has to come
  // from the outer constructor, not from an individual offset.
  const innerMap = nested(2, 5000000, 0);
  const innerRows = rows(new SourceMapConsumer(innerMap));
  try {
    new SourceMapConsumer(indexed(5000000, 0, innerMap));
    emit({ outcome: "accepted", innerLines: innerRows.map(function (row) { return row.line; }) });
  } catch (error) {
    emit({
      outcome: "threw",
      message: String(error.message),
      innerLines: innerRows.map(function (row) { return row.line; })
    });
  }
} else if (mode === "accept-line-limit") {
  emit({ outcome: "accepted", rows: rows(new SourceMapConsumer(indexed(10000000, 0))) });
} else if (mode === "accept-nested-limit") {
  emit({ outcome: "accepted", rows: rows(new SourceMapConsumer(nested(2, 5000000, 0))) });
} else if (mode === "accept-column") {
  emit({ outcome: "accepted", rows: rows(new SourceMapConsumer(indexed(0, 5000000))) });
} else if (mode === "sources-getter-count") {
  const outer = new SourceMapConsumer(nested(4, 0, 0));
  let innermost = outer;
  while (innermost._sections) {
    innermost = innermost._sections[0].consumer;
  }
  const original = innermost.sources;
  let reads = 0;
  Object.defineProperty(innermost, "sources", {
    configurable: true,
    get: function () {
      reads += 1;
      return original.slice();
    }
  });
  emit({ outcome: "accepted", sources: outer.sources, reads: reads });
} else if (mode === "generator-gap") {
  const consumer = new SourceMapConsumer(indexed(4096, 0));
  const generator = new SourceMapGenerator();
  consumer.eachMapping(function (mapping) {
    generator.addMapping({
      generated: { line: mapping.generatedLine, column: mapping.generatedColumn },
      original: { line: mapping.originalLine, column: mapping.originalColumn },
      source: mapping.source
    });
  });
  const mappings = generator.toJSON().mappings;
  emit({
    outcome: "accepted",
    length: mappings.length,
    suffix: mappings.slice(-5),
    exact: mappings === ";".repeat(4096) + "AAAA"
  });
} else if (mode === "source-node-exhausted") {
  const node = SourceNode.fromStringWithSourceMap(
    "var x;\n",
    new SourceMapConsumer(indexed(4096, 0))
  );
  const converted = node.toString();
  emit({
    outcome: "accepted",
    exact: converted === "var x;\n",
    length: converted.length,
    children: node.children.length,
    sample: converted === "var x;\n" ? undefined : converted.slice(0, 40)
  });
} else {
  fatal("unknown child mode: " + mode);
}
`;

function runIsolatedCase(mode: string, field = "", code = ""): ChildResult {
	const result = spawnSync(
		process.execPath,
		[
			"--max-old-space-size=64",
			"-e",
			CHILD_SCRIPT,
			path.join(REPO_ROOT, "package.json"),
			REPO_ROOT,
			mode,
			field,
			code,
		],
		{
			cwd: REPO_ROOT,
			encoding: "utf8",
			timeout: CHILD_TIMEOUT_MS,
			killSignal: "SIGKILL",
			maxBuffer: CHILD_MAX_BUFFER,
			env: {
				NODE_ENV: "test",
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				LANG: "C.UTF-8",
				TZ: "Asia/Shanghai",
			},
		},
	);
	assert.equal(result.error, undefined, `isolated child failed: ${result.error?.message ?? "unknown"}`);
	assert.equal(result.signal, null, `isolated child was killed by ${result.signal}`);
	assert.equal(result.status, 0, `isolated child exited ${result.status}: ${result.stderr}`);
	const lines = result.stdout.trim().split("\n");
	const last = lines[lines.length - 1];
	assert.ok(last, "isolated child produced no result line");
	return JSON.parse(last) as ChildResult;
}

describe("source-map-js 1.2.2 indexed-map regression", () => {
	it("round-trips a normal basic map through consumer, generator, and SourceNode", () => {
		const consumer = consume(flat());
		assert.deepEqual(rowsOf(consumer), [
			{
				source: "a.js",
				generatedLine: 1,
				generatedColumn: 0,
				originalLine: 1,
				originalColumn: 0,
			},
		]);
		assert.equal(SourceMapGenerator.fromSourceMap(consumer).toJSON().mappings, "AAAA");
		assert.equal(SourceNode.fromStringWithSourceMap("a", consumer).toString(), "a");
	});

	it("applies indexed offsets and aggregates multiple and nested sections", () => {
		assert.deepEqual(rowsOf(consume(indexed(3, 0))), [
			{
				source: "a.js",
				generatedLine: 4,
				generatedColumn: 0,
				originalLine: 1,
				originalColumn: 0,
			},
		]);
		assert.deepEqual(rowsOf(consume(indexed(0, 7))), [
			{
				source: "a.js",
				generatedLine: 1,
				generatedColumn: 7,
				originalLine: 1,
				originalColumn: 0,
			},
		]);
		assert.deepEqual(rowsOf(consume(nested(5, 1000, 0))), [
			{
				source: "a.js",
				generatedLine: 5001,
				generatedColumn: 0,
				originalLine: 1,
				originalColumn: 0,
			},
		]);

		const twoSections: RawMap = {
			version: 3,
			sections: [
				{ offset: { line: 0, column: 0 }, map: flat("a.js") },
				{ offset: { line: 3, column: 0 }, map: flat("b.js") },
			],
		};
		const two = consume(twoSections);
		assert.deepEqual(rowsOf(two), [
			{
				source: "a.js",
				generatedLine: 1,
				generatedColumn: 0,
				originalLine: 1,
				originalColumn: 0,
			},
			{
				source: "b.js",
				generatedLine: 4,
				generatedColumn: 0,
				originalLine: 1,
				originalColumn: 0,
			},
		]);
		assert.deepEqual(two.sources, ["a.js", "b.js"]);
	});

	describe("constructor offset validation (isolated processes)", () => {
		const invalidValues: Array<{ code: string; label: string }> = [
			{ code: "negative", label: "-1" },
			{ code: "fraction", label: "1.5" },
			{ code: "string", label: "string 1" },
			{ code: "null", label: "null" },
			{ code: "undefined", label: "undefined" },
			{ code: "nan", label: "NaN" },
			{ code: "infinity", label: "Infinity" },
			{ code: "negative-infinity", label: "-Infinity" },
			{ code: "unsafe-integer", label: "9007199254740992" },
		];

		for (const fieldName of ["line", "column"] as const) {
			for (const value of invalidValues) {
				it(`rejects ${fieldName}=${value.label}`, () => {
					const result = runIsolatedCase("reject-invalid", fieldName, value.code);
					assert.equal(result.outcome, "threw", `${fieldName}=${value.label} was accepted`);
					assert.match(
						result.message ?? "",
						/Section offset line and column must be non-negative integers\./,
					);
				});
			}
		}

		it("rejects Infinity produced by JSON wire parsing", () => {
			const result = runIsolatedCase("reject-json-infinity");
			assert.equal(result.outcome, "threw");
			assert.match(
				result.message ?? "",
				/Section offset line and column must be non-negative integers\./,
			);
		});

		it("rejects a line offset above 1e7", () => {
			const result = runIsolatedCase("reject-above-limit");
			assert.equal(result.outcome, "threw");
			assert.equal(result.message, "Section offset line must not exceed 10000000.");
		});

		it("rejects a nested total above 1e7 at the outer constructor", () => {
			const result = runIsolatedCase("reject-nested-total");
			assert.equal(result.outcome, "threw");
			assert.match(result.message ?? "", /including offsets of nested sections\./);
			assert.deepEqual(result.innerLines, [10000001]);
		});

		it("accepts exactly 1e7 for line and inspects mappings without serializing", () => {
			const result = runIsolatedCase("accept-line-limit");
			assert.equal(result.outcome, "accepted");
			assert.deepEqual(result.rows, [
				{ source: "a.js", line: 10000001, column: 0, originalLine: 1, originalColumn: 0 },
			]);
		});

		it("accepts a nested total of exactly 1e7 without serializing", () => {
			const result = runIsolatedCase("accept-nested-limit");
			assert.equal(result.outcome, "accepted");
			assert.deepEqual(result.rows, [
				{ source: "a.js", line: 10000001, column: 0, originalLine: 1, originalColumn: 0 },
			]);
		});

		it("accepts a column of 5,000,000 without serializing", () => {
			const result = runIsolatedCase("accept-column");
			assert.equal(result.outcome, "accepted");
			assert.deepEqual(result.rows, [
				{ source: "a.js", line: 1, column: 5000000, originalLine: 1, originalColumn: 0 },
			]);
		});

		it("reads a depth-four nested sources getter once", () => {
			const result = runIsolatedCase("sources-getter-count");
			assert.equal(result.outcome, "accepted");
			assert.deepEqual(result.sources, ["a.js"]);
			assert.equal(result.reads, 1);
		});

		it("serializes a 4096-line generator gap with the correct mappings", () => {
			const result = runIsolatedCase("generator-gap");
			assert.equal(result.outcome, "accepted");
			assert.equal(result.length, 4100);
			assert.equal(result.suffix, ";AAAA");
			assert.equal(result.exact, true);
		});

		it("preserves short code when the mapping outruns it", () => {
			const result = runIsolatedCase("source-node-exhausted");
			assert.equal(result.outcome, "accepted");
			assert.equal(
				result.exact,
				true,
				`converted code length ${result.length}, sample ${JSON.stringify(result.sample)}`,
			);
			assert.ok(typeof result.children === "number", "child did not report children");
			assert.ok(result.children < 10, `SourceNode kept ${result.children} children`);
		});
	});

	it("resolves a source-map-js at or above 1.2.2 for every real parent site", () => {
		assertAtLeastFixedVersion(packageVersionAt(SOURCE_MAP_JS_ROOT), "hoisted source-map-js");
		const sites: Array<{ label: string; resolved: string }> = [];

		const rootPostcssPkg = require.resolve("postcss/package.json");
		sites.push({
			label: "root PostCSS",
			resolved: createRequire(rootPostcssPkg).resolve("source-map-js"),
		});

		const nextDir = path.dirname(require.resolve("next/package.json"));
		const nextPostcssPkg = path.join(nextDir, "node_modules", "postcss", "package.json");
		assert.ok(
			fs.existsSync(nextPostcssPkg),
			"expected Next's private PostCSS at next/node_modules/postcss",
		);
		sites.push({
			label: "Next private PostCSS",
			resolved: createRequire(nextPostcssPkg).resolve("source-map-js"),
		});

		const tailwindEntry = require.resolve("@tailwindcss/node");
		sites.push({
			label: "@tailwindcss/node",
			resolved: createRequire(tailwindEntry).resolve("source-map-js"),
		});

		for (const site of sites) {
			const real = fs.realpathSync(site.resolved);
			assert.equal(real, SOURCE_MAP_JS_ENTRY, `${site.label} resolved a different source-map-js copy`);
			assertAtLeastFixedVersion(packageVersionAt(path.dirname(real)), site.label);
		}
	});

	it("keeps one safe lock entry with consistent version, resolved, and integrity fields", () => {
		const lock = JSON.parse(
			fs.readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"),
		) as {
			packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
		};
		const entries = Object.entries(lock.packages).filter(
			([key]) => key === "node_modules/source-map-js" || key.endsWith("/node_modules/source-map-js"),
		);
		assert.equal(entries.length, 1, `expected one source-map-js lock entry, found ${entries.length}`);
		const [key, entry] = entries[0]!;
		assert.equal(key, "node_modules/source-map-js");
		assert.ok(entry.version, "lock entry has no version");
		assertAtLeastFixedVersion(entry.version, "lockfile");
		assert.equal(
			entry.resolved,
			`https://registry.npmjs.org/source-map-js/-/source-map-js-${entry.version}.tgz`,
		);
		assert.match(entry.integrity ?? "", /^sha512-[A-Za-z0-9+/]+={0,2}$/);
		assert.equal(entry.version, packageVersionAt(SOURCE_MAP_JS_ROOT));

		const manifest = JSON.parse(
			fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
		) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
		assert.equal(manifest.dependencies?.["source-map-js"], undefined);
		assert.equal(manifest.devDependencies?.["source-map-js"], undefined);
	});

	it("keeps Next's real private PostCSS map generation and consumption compatible", async () => {
		const nextDir = path.dirname(require.resolve("next/package.json"));
		const nextPostcssPkg = path.join(nextDir, "node_modules", "postcss", "package.json");
		const postcss = createRequire(nextPostcssPkg)("postcss") as (
			plugins?: unknown[],
		) => {
			process(
				css: string,
				options: Record<string, unknown>,
			): Promise<{ map?: { toJSON(): RawSourceMap } }>;
		};

		const result = await postcss().process("a { color: red; }", {
			from: "input.css",
			to: "output.css",
			map: { prev: flat(), inline: false },
		});
		assert.ok(result.map, "PostCSS must return a map");
		const generated = result.map.toJSON();
		assert.equal(Number(generated.version), 3);
		assert.deepEqual(generated.sources, ["a.js"]);

		const position = new SourceMapConsumer(generated).originalPositionFor({ line: 1, column: 4 });
		assert.deepEqual(position, { source: "a.js", line: 1, column: 0, name: null });
	});
});
