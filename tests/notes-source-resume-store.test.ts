import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { NotesSource } from "../src/core/contracts.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "lh-notes-resume-store-"));
const previous = Object.fromEntries(["HOME", "USERPROFILE", "LH_AUTH_FILE", "LH_DATA_DIR"].map((key) => [key, process.env[key]]));
Object.assign(process.env, { HOME: root, USERPROFILE: root, LH_AUTH_FILE: path.join(root, "auth.json"), LH_DATA_DIR: path.join(root, "data") });
after(async () => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	await fs.rm(root, { recursive: true, force: true });
});

// Exercise the module-loading boundary: static imports would capture real data paths before isolation.
const { SOURCES_FILE } = await import("../config.ts");
const { graphStore } = await import("../src/store/graph.ts");
const fp = "0123456789abcdef0123456789abcdef";
const source: NotesSource = {
	id: "src_resume_fixture",
	filePath: "/vault/fixture.md",
	importedAt: "2026-11-13T00:00:00.000Z",
	contentFp: "legacy-fingerprint",
	extractions: [{
		startedAt: 1,
		at: "2026-11-13T00:00:00.000Z",
		durationMs: 10,
		stats: { nodes: 1, chains: 0 },
		stages: { extractor: { model: "fixture:extractor", steps: [] }, auditor: { model: "fixture:auditor", steps: [] } },
	}],
};

async function writeSource(resume: unknown): Promise<string> {
	const raw = JSON.stringify({ [source.id]: { ...source, resume } });
	await fs.mkdir(path.dirname(SOURCES_FILE), { recursive: true });
	await fs.writeFile(SOURCES_FILE, raw);
	return raw;
}

describe("notes source resume disk validation", () => {
	for (const done of [1, 3]) {
		it(`keeps a valid checkpoint with ${done} of 3 chunks merged`, async () => {
			const resume = { fp, chunks: 3, done };
			const raw = await writeSource(resume);
			assert.deepEqual(graphStore.readSources(), [{ ...source, resume }]);
			assert.equal(await fs.readFile(SOURCES_FILE, "utf-8"), raw, "reads do not rewrite the source map");
		});
	}

	const invalid: Array<[string, unknown]> = [
		["null", null], ["array", []], ["string", "checkpoint"],
		["uppercase fingerprint", { fp: fp.toUpperCase(), chunks: 3, done: 1 }],
		["nonhex fingerprint", { fp: "g".repeat(32), chunks: 3, done: 1 }],
		["short fingerprint", { fp: fp.slice(1), chunks: 3, done: 1 }],
		["missing fingerprint", { chunks: 3, done: 1 }],
		...[0, -1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1].map((chunks): [string, unknown] => [`chunks ${chunks}`, { fp, chunks, done: 1 }]),
		...[0, -1, 1.5, "1", 4, Number.MAX_SAFE_INTEGER + 1].map((done): [string, unknown] => [`done ${done}`, { fp, chunks: 3, done }]),
	];
	for (const [label, resume] of invalid) {
		it(`drops only the invalid checkpoint (${label}), keeping source metadata and usage`, async () => {
			const raw = await writeSource(resume);
			assert.deepEqual(graphStore.readSources(), [source]);
			assert.equal(await fs.readFile(SOURCES_FILE, "utf-8"), raw, "validation is read-only");
		});
	}

	it("preserves usage when upserting a source whose disk checkpoint was invalid", async () => {
		await writeSource({ fp, chunks: 3, done: 1.5 });
		const importedAt = "2026-11-14T00:00:00.000Z";
		graphStore.upsertSource({ id: source.id, filePath: source.filePath, importedAt });
		assert.deepEqual(graphStore.readSources(), [{ id: source.id, filePath: source.filePath, importedAt, extractions: source.extractions }]);
	});
});
