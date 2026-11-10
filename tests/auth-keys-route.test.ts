/**
 * PUT/DELETE /api/keys/:id when the encrypted store cannot do its job
 * (auth-encryption change): no master-key source, or an undecryptable
 * auth.enc.json — a readable 500 {error}, never a silent plaintext
 * fallback and never a crash. LH_AUTH_FILE is redirected to a tmp dir BEFORE
 * the imports (module-load-bound seam); the keyring is a fake that fails —
 * the suite never touches the real OS credential store.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-auth-route-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
delete process.env.LH_AUTH_MASTER_KEY;
delete process.env.DEEPGRAM_API_KEY;

const { authStoreTesting } = await import("../src/store/auth.ts");
const { AUTH_ENC_FILE, AUTH_FILE } = await import("../config.ts");
const { PUT, DELETE } = await import("../app/api/keys/[id]/route.ts");

authStoreTesting.reset(() => {
	throw new Error("no secret service");
});

after(() => {
	delete process.env.LH_AUTH_MASTER_KEY;
	delete process.env.DEEPGRAM_API_KEY;
	fs.rmSync(TMP, { recursive: true, force: true });
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const put = (id: string, value: string) =>
	PUT(new Request(`http://localhost/api/keys/${id}`, { method: "PUT", body: JSON.stringify({ value }) }), ctx(id));
const KEY = "d".repeat(40); // throwaway, ≥ the Deepgram shape floor

describe("keys API under a failing store", () => {
	it("PUT with no key source → 500 with a readable message; nothing stored or reflected", async () => {
		const res = await put("DEEPGRAM_API_KEY", KEY);
		assert.equal(res.status, 500);
		const body = (await res.json()) as { error: string };
		assert.match(body.error, /Cannot store API keys securely/);
		assert.match(body.error, /LH_AUTH_MASTER_KEY/);
		assert.ok(!fs.existsSync(AUTH_ENC_FILE) && !fs.existsSync(AUTH_FILE), "no file of any kind written");
		assert.equal(process.env.DEEPGRAM_API_KEY, undefined, "env reflection only follows a successful store");
	});

	it("shape errors stay 400s (the shape gate runs before the store)", async () => {
		const res = await put("DEEPGRAM_API_KEY", "short");
		assert.equal(res.status, 400);
	});

	it("PUT onto an undecryptable file → 500 telling the user to delete auth.enc.json; file untouched", async () => {
		process.env.LH_AUTH_MASTER_KEY = crypto.randomBytes(32).toString("base64");
		authStoreTesting.reset(() => {
			throw new Error("the keyring must not be touched");
		});
		assert.equal((await put("DEEPGRAM_API_KEY", KEY)).status, 200);
		const before = fs.readFileSync(AUTH_ENC_FILE);
		process.env.LH_AUTH_MASTER_KEY = crypto.randomBytes(32).toString("base64"); // a different key
		const res = await put("DEEPGRAM_API_KEY", "e".repeat(40));
		assert.equal(res.status, 500);
		assert.match(((await res.json()) as { error: string }).error, /delete auth\.enc\.json/);
		const del = await DELETE(new Request("http://localhost/api/keys/DEEPGRAM_API_KEY", { method: "DELETE" }), ctx("DEEPGRAM_API_KEY"));
		assert.equal(del.status, 500);
		assert.ok(before.equals(fs.readFileSync(AUTH_ENC_FILE)), "file bytes untouched");
	});
});
