/**
 * listChats summary cache: the cached list must equal an uncached read of
 * the same files after every kind of write, including writes the cache
 * did not see (another process editing or replacing a record).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { after, describe, it, mock } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-list-cache-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { PATHS } = await import("../config.ts");

let fresh = 0;
/** A new module instance has an empty cache: the uncached reference. */
async function uncachedList() {
	const mod = await import(`../src/store/chats.ts?fresh=${++fresh}`) as typeof import("../src/store/chats.ts");
	return mod.chatStore.listChats();
}

async function assertParity() {
	assert.deepEqual(chatStore.listChats(), await uncachedList());
}

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("listChats summary cache", () => {
	it("matches an uncached read across store writes", async () => {
		const a = chatStore.createChat("first");
		const b = chatStore.createChat("second", "practice");
		await assertParity();
		chatStore.renameChat(a.id, "first renamed");
		await assertParity();
		chatStore.saveMessages(b.id, [{ id: "m1", role: "user", content: "hello", timestamp: 1 }]);
		await assertParity();
		assert.equal(chatStore.listChats().find((c) => c.id === b.id)?.messageCount, 1);
		chatStore.deleteChat(a.id);
		await assertParity();
		assert.deepEqual(chatStore.listChats().map((c) => c.id), [b.id]);
	});

	it("sees external edits, replacements and removals", async () => {
		const c = chatStore.createChat("external");
		chatStore.listChats();
		const file = path.join(PATHS.chats, `${c.id}.json`);

		// In-place rewrite (same inode), title of a different length.
		const record = JSON.parse(fs.readFileSync(file, "utf-8"));
		fs.writeFileSync(file, JSON.stringify({ ...record, title: "edited elsewhere, longer" }));
		assert.equal(chatStore.listChats().find((x) => x.id === c.id)?.title, "edited elsewhere, longer");
		await assertParity();

		// Same-size replacement through rename (new inode).
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ ...record, title: "edited elsewhere, LONGER" }));
		fs.renameSync(tmp, file);
		assert.equal(chatStore.listChats().find((x) => x.id === c.id)?.title, "edited elsewhere, LONGER");
		await assertParity();

		fs.rmSync(file);
		assert.equal(chatStore.listChats().some((x) => x.id === c.id), false);
		await assertParity();
	});

	it("returns copies, so callers cannot corrupt the cache", () => {
		const d = chatStore.createChat("copy check");
		const first = chatStore.listChats().find((x) => x.id === d.id)!;
		first.title = "mutated by a caller";
		assert.equal(chatStore.listChats().find((x) => x.id === d.id)?.title, "copy check");
	});

	it("sees an in-place rewrite that keeps size and mtime", async () => {
		const e = chatStore.createChat("AAAA");
		const file = path.join(PATHS.chats, `${e.id}.json`);
		fs.utimesSync(file, 1_700_000_000, 1_700_000_000); // whole seconds restore exactly
		chatStore.listChats();
		const before = fs.statSync(file);
		fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace('"AAAA"', '"BBBB"'));
		fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
		const after = fs.statSync(file);
		assert.equal(after.size, before.size);
		assert.equal(after.mtimeMs, before.mtimeMs);
		assert.equal(chatStore.listChats().find((x) => x.id === e.id)?.title, "BBBB");
		await assertParity();
	});

	it("retries a chat whose read failed transiently", () => {
		const f = chatStore.createChat("flaky read");
		const realRead = fs.readFileSync;
		const failing = mock.method(fs, "readFileSync", ((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
			if (String(target).endsWith(`${f.id}.json`)) throw Object.assign(new Error("EMFILE"), { code: "EMFILE" });
			return (realRead as (...args: unknown[]) => unknown)(target, ...rest);
		}) as typeof fs.readFileSync);
		syncBuiltinESMExports();
		try {
			assert.equal(chatStore.listChats().some((x) => x.id === f.id), false);
		} finally {
			failing.mock.restore();
			syncBuiltinESMExports();
		}
		assert.equal(chatStore.listChats().some((x) => x.id === f.id), true);
	});
});
