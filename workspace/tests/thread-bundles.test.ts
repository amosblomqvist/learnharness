import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { accountKey, selectThreadProfile, threadProfileRoot } from "../src/store/thread-profile.ts";
import { bundleDigest, readThreadBundle, validateThreadBundle, writeThreadBundle, type ThreadBundle } from "../src/store/thread-bundles.ts";
import { markThreadModified, threadModifiedAt } from "../src/store/thread-times.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cloud-bundles-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const sample = (): ThreadBundle => ({ version: 1, chat: { id: "chat_test", title: "Test", messages: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" }, jobs: [], files: {} });
describe("account caches and portable thread snapshots", () => {
	it("separates signed-out data, accounts, and deployments", () => {
		const a = accountKey("https://one.convex.cloud", "alice"), b = accountKey("https://one.convex.cloud", "bob");
		assert.notEqual(a, b); assert.notEqual(a, accountKey("https://two.convex.cloud", "alice"));
		assert.equal(threadProfileRoot(root), root);
		selectThreadProfile(root, a); const alice = threadProfileRoot(root); writeThreadBundle(alice, sample());
		selectThreadProfile(root, b); assert.equal(readThreadBundle(threadProfileRoot(root), "chat_test"), null);
		selectThreadProfile(root, null); assert.equal(readThreadBundle(threadProfileRoot(root), "chat_test"), null);
		selectThreadProfile(root, a); assert.equal(readThreadBundle(threadProfileRoot(root), "chat_test")?.chat.title, "Test");
	});
	it("fails closed for malformed account selectors", () => {
		assert.throws(() => selectThreadProfile(root, "../../other"));
		fs.writeFileSync(path.join(root, "cloud-profile.json"), "bad");
		assert.throws(() => threadProfileRoot(root)); selectThreadProfile(root, null);
	});
	it("round-trips binary attachments and saved results across different computer paths", () => {
		const a = path.join(root, "computer-a"), b = path.join(root, "computer-b");
		const bundle = sample(); const relative = "12345678-1234-1234-1234-123456789abc/1-file.png";
		bundle.files[relative] = Buffer.from([0, 128, 255, 3]).toString("base64");
		bundle.chat.title = `A file at lh-attachment://${relative}`;
		bundle.jobs = [{ id: "job_test", chatId: bundle.chat.id, kind: "research", toolCallId: "call1", status: "done", activity: "Done", createdAt: "2026-01-01", updatedAt: "2026-01-01", result: { text: "Saved research" } }];
		writeThreadBundle(a, bundle); const portable = readThreadBundle(a, "chat_test")!;
		assert.deepEqual(portable, bundle); writeThreadBundle(b, portable);
		assert.deepEqual(fs.readFileSync(path.join(b, "attachments", ...relative.split("/"))), Buffer.from([0, 128, 255, 3]));
		assert.equal(bundleDigest(readThreadBundle(b, "chat_test")!), bundleDigest(portable));
	});
	it("rejects traversal, unfinished work, and future schemas before import", () => {
		const traversal = sample(); traversal.files["../../secret"] = "AA==";
		assert.throws(() => validateThreadBundle(traversal, "chat_test"), /attachment/);
		const future = sample(); future.chat.version = 999; assert.throws(() => validateThreadBundle(future, "chat_test"), /Unsupported/);
		const running = sample(); running.jobs = [{ id: "job", chatId: "chat_test", status: "running" } as never];
		assert.throws(() => validateThreadBundle(running, "chat_test"), /unfinished/);
	});
	it("tracks renames, deletions, and imported timestamps independently of activity time", () => {
		const cache = path.join(root, "timestamps");
		markThreadModified(cache, "chat_test", 123); assert.equal(threadModifiedAt(cache, "chat_test"), 123);
		markThreadModified(cache, "chat_test"); assert(threadModifiedAt(cache, "chat_test") > 123);
		markThreadModified(cache, "chat_test", Date.now() + 10000);
		const previous = threadModifiedAt(cache, "chat_test"); markThreadModified(cache, "chat_test");
		assert(threadModifiedAt(cache, "chat_test") > previous);
	});
});
