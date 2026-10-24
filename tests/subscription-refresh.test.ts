/** Real SDK Models.getAuth refresh (fake OAuth, temp store) racing disconnect. No network. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createModels, type OAuthAuth, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import { createProviderCredentialStore } from "../src/store/provider-credentials.ts";
import { createSubscriptionService } from "../src/server/subscriptions.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-subref-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const ID = "subscription-openai-codex";
const expired: OAuthCredential = { type: "oauth", access: "old", refresh: "r", expires: 0 };
const mkStore = (name: string) => createProviderCredentialStore(path.join(TMP, name, "c.json"), { pollMs: 2 });

function fakeProvider(refresh: OAuthAuth["refresh"]): Provider {
	const oauth: OAuthAuth = {
		name: "fake",
		login: async () => expired,
		refresh,
		toAuth: async (c) => ({ apiKey: c.access }),
	};
	return {
		id: ID,
		name: "fake",
		auth: { oauth },
		getModels: () => [],
		stream: (() => {
			throw new Error("unused");
		}) as Provider["stream"],
		streamSimple: (() => {
			throw new Error("unused");
		}) as Provider["streamSimple"],
	};
}

describe("subscription refresh via real Models.getAuth", () => {
	it("concurrent getAuth refreshes once and persists the rotated token", async () => {
		const store = mkStore("a");
		await store.modify(ID, async () => expired);
		let calls = 0;
		const models = createModels({ credentials: store });
		models.setProvider(
			fakeProvider(async () => {
				calls++;
				await new Promise((r) => setTimeout(r, 15));
				return { type: "oauth", access: "new", refresh: "r2", expires: Date.now() + 3_600_000 };
			}),
		);
		const results = await Promise.all(Array.from({ length: 6 }, () => models.getAuth(ID)));
		assert.equal(calls, 1);
		assert.ok(results.every((r) => r?.auth.apiKey === "new"));
		assert.equal((store.peek(ID) as OAuthCredential).access, "new");
		assert.equal((store.peek(ID) as OAuthCredential).refresh, "r2");
	});

	it("disconnect queued behind an in-flight refresh wins; later getAuth does not resurrect", async () => {
		const store = mkStore("b");
		await store.modify(ID, async () => expired);
		const svc = createSubscriptionService({ credentials: store, getOAuth: () => undefined });
		let started!: () => void;
		const inFlight = new Promise<void>((r) => (started = r));
		let calls = 0;
		const models = createModels({ credentials: store });
		models.setProvider(
			fakeProvider(async () => {
				calls++;
				started();
				await new Promise((r) => setTimeout(r, 40));
				return { type: "oauth", access: "refreshed", refresh: "r2", expires: Date.now() + 3_600_000 };
			}),
		);
		const auth = models.getAuth(ID);
		await inFlight;
		const dis = svc.disconnect(ID); // blocks on the store lock until the refresh persists
		await Promise.all([auth, dis]);
		assert.equal(store.has(ID), false);
		assert.equal(await models.getAuth(ID), undefined);
		assert.equal(calls, 1);
		svc.dispose();
	});

	it("status never triggers a refresh", async () => {
		const store = mkStore("c");
		await store.modify(ID, async () => expired);
		const svc = createSubscriptionService({ credentials: store, getOAuth: () => { throw new Error("must not load provider"); } });
		const row = (await svc.statuses()).find((s) => s.id === ID)!;
		assert.equal(row.connected, true);
		assert.equal((store.peek(ID) as OAuthCredential).access, "old");
		svc.dispose();
	});
});
