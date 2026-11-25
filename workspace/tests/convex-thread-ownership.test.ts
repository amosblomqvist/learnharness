import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commit, download, list, uploadUrl } from "../convex/threads.ts";

// Exercise the registered handlers with indexed storage and session lookups.
// The live Convex runtime/OAuth deployment is checked separately during setup.
type Row = { _id: string; owner: string; threadId: string; revision: string; digest: string | null; storageId: string | null; updatedAt: number };
function database() {
	const rows: Row[] = [];
	return {
		rows,
		query: () => ({ withIndex: (_name: string, filter: (q: unknown) => unknown) => {
			const matches: [string, unknown][] = [];
			const q = { eq(key: string, value: unknown) { matches.push([key, value]); return q; } };
			filter(q);
			const found = () => rows.filter(row => matches.every(([key, value]) => row[key as keyof Row] === value));
			return { unique: async () => found()[0] ?? null, paginate: async () => ({ page: found(), isDone: true, continueCursor: "" }) };
		} }),
		insert: async (_table: string, row: Omit<Row, "_id">) => { rows.push({ ...row, _id: String(rows.length + 1) }); },
		replace: async (_table: string, id: string, row: Omit<Row, "_id">) => { rows.splice(rows.findIndex(item => item._id === id), 1, { ...row, _id: id }); },
		system: { get: async () => ({ size: 100 }) },
	};
}
const invoke = async <T>(registered: unknown, context: unknown, args: unknown): Promise<T> => (registered as { _handler(ctx: unknown, args: unknown): Promise<T> })._handler(context, args);
describe("Convex thread ownership", () => {
	it("scopes every read and write to the verified session owner", async () => {
		const db = database();
		const context = (owner: string | null, revoked = false) => ({
			db, auth: { getUserIdentity: async () => owner ? { subject: `session-${owner}` } : null },
			runQuery: async () => revoked ? null : { userId: owner },
			storage: { generateUploadUrl: async () => "https://upload.example", getUrl: async (id: string) => `https://files.example/${id}` },
		});
		const args = { threadId: "same_thread_id", expected: null, revision: "alice-v1", digest: "a".repeat(64), storageId: "alice-file", updatedAt: 100 };
		await invoke(commit, context("alice"), args);
		assert.equal(await invoke(download, context("bob"), { threadId: args.threadId }), null);
		const bobPage = await invoke<{ page: Row[] }>(list, context("bob"), { paginationOpts: { numItems: 100, cursor: null } });
		assert.deepEqual(bobPage.page, []);
		await invoke(commit, context("bob"), { ...args, revision: "bob-v1", storageId: "bob-file" });
		assert.equal(db.rows.length, 2);
		const alicePage = await invoke<{ page: Row[] }>(list, context("alice"), { paginationOpts: { numItems: 100, cursor: null } });
		assert.equal(alicePage.page.length, 1); assert.equal(alicePage.page[0]?.storageId, "alice-file");
		assert.equal(await invoke(commit, context("alice"), { ...args, expected: "stale", revision: "alice-v2", digest: "b".repeat(64) }), null);
		for (const caller of [context(null), context("alice", true)]) {
			await assert.rejects(invoke(list, caller, { paginationOpts: { numItems: 10, cursor: null } }), /Sign in/);
			await assert.rejects(invoke(download, caller, { threadId: args.threadId }), /Sign in/);
			await assert.rejects(invoke(uploadUrl, caller, {}), /Sign in/);
			await assert.rejects(invoke(commit, caller, args), /Sign in/);
		}
	});
});
