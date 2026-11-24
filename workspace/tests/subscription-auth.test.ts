import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createModels, type OAuthCredential, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import type { NativeSubscriptionScope } from "../src/core/contracts/subscriptions.ts";
const require = createRequire(import.meta.url);
const { createSubscriptions, loadSubscriptionSDK, validEndpoint, publicError } = require("../electron/subscriptions.cjs");
const { fileStore, validateState } = require("../electron/subscription-store.cjs");
const { subscriptionControl } = require("../electron/subscription-ipc.cjs");
const ids = ["github-copilot", "xai"] as const;
const credential = (id: string, expires = Date.now() + 3600000): OAuthCredential => ({ type: "oauth", access: id === "xai" ? "fixture-xai-access" : "tid=fixture;proxy-ep=proxy.individual.githubcopilot.com;", refresh: "fixture-refresh", expires, ...(id === "github-copilot" ? { availableModelIds: [githubCopilotProvider().getModels()[0]!.id] } : {}) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
async function fixture(options: { login?: (id: string, interaction: ProviderAuthInteraction) => Promise<OAuthCredential>; refresh?: (id: string, value: OAuthCredential, signal: AbortSignal) => Promise<OAuthCredential>; stores?: Record<string, unknown> } = {}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-subscription-auth-"));
	let refreshes = 0;
	const factory = (id: string) => {
		const native = id === "xai" ? xaiProvider() : githubCopilotProvider();
		return { ...native, auth: { ...native.auth, oauth: { ...native.auth.oauth!, login: (interaction: ProviderAuthInteraction) => options.login?.(id, interaction) ?? Promise.resolve(credential(id)), refresh: async (value: OAuthCredential, signal: AbortSignal) => { refreshes++; return options.refresh?.(id, value, signal) ?? { ...credential(id), refresh: "fixture-rotated" }; } } } };
	};
	const sdk = { createModels, githubCopilotProvider: () => factory("github-copilot"), xaiProvider: () => factory("xai") };
	const updates: any[] = [], opened: string[] = [];
	const controller = createSubscriptions({ directory, sdk, stores: options.stores, openExternal: async (url: string) => { opened.push(url); }, onChange: (snapshot: unknown) => updates.push(snapshot) });
	await controller.ready;
	const scope = async (id: string): Promise<NativeSubscriptionScope> => {
		const snapshot = await controller.snapshot(), status = snapshot.statuses.find((s: any) => s.providerId === id), model = snapshot.models[id][0];
		return { providerId: id as NativeSubscriptionScope["providerId"], connectionId: status.connectionId, epoch: status.epoch, authorityRevision: status.authorityRevision, selectedModelId: model.id };
	};
	return { controller, directory, sdk, opened, updates, scope, get refreshes() { return refreshes; }, async cleanup() { controller.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}
test("main loader resolves Pi's import-only PUBLIC package exports and native OAuth without a CLI or network", async () => {
	const sdk = await loadSubscriptionSDK(path.resolve(import.meta.dirname, ".."));
	assert.equal(typeof sdk.createModels, "function");
	for (const [id, factory] of [["github-copilot", sdk.githubCopilotProvider], ["xai", sdk.xaiProvider]] as const) {
		const provider = factory(), store = new sdk.InMemoryCredentialStore(); await store.modify(id, () => credential(id));
		const models = sdk.createModels({ credentials: store }); models.setProvider({ ...provider, auth: { oauth: provider.auth.oauth } });
		const resolved = await models.getAuth(provider.getModels()[0]); assert.equal(resolved.auth.apiKey, credential(id).access);
	}
});
for (const id of ids) test(`${id}: independent default-ON file, restart, explicit OAuth lease and local disconnect`, async () => {
	const f = await fixture();
	try {
		assert((await f.controller.status()).every((s: any) => s.available && !s.connected && s.allowBackgroundUse));
		await f.controller.login(id, false);
		const saved = JSON.parse(await fs.readFile(path.join(f.directory, `${id}-credentials.json`), "utf8"));
		assert.equal(saved.version, 1); assert.equal(saved.credential.type, "oauth"); assert.equal(saved.allowBackgroundUse, false);
		assert.equal((await fs.stat(path.join(f.directory, `${id}-credentials.json`))).mode & 0o777, 0o600);
		const publicState = JSON.stringify(await f.controller.snapshot());
		assert(!publicState.includes(saved.credential.access)); assert(!publicState.includes(saved.credential.refresh));
		const scope = await f.scope(id), result = await f.controller.lease(scope, false);
		assert.equal(result.auth.apiKey, saved.credential.access);
		if (id === "github-copilot") assert.equal(result.auth.baseUrl, "https://api.individual.githubcopilot.com");
		await assert.rejects(f.controller.lease(scope, true), (error: any) => error.code === "background");
		const reloaded = createSubscriptions({ directory: f.directory, sdk: f.sdk, openExternal: async () => {} }); await reloaded.ready;
		assert.equal((await reloaded.status()).find((s: any) => s.providerId === id).connectionId, saved.connectionId); reloaded.close();
		await f.controller.disconnect(id); await assert.rejects(f.controller.lease(scope, false));
		const removed = JSON.parse(await fs.readFile(path.join(f.directory, `${id}-credentials.json`), "utf8"));
		assert.deepEqual(removed, { version: 1, allowBackgroundUse: false });
		assert.equal((await f.controller.status()).find((s: any) => s.providerId !== id).connected, false);
	} finally { await f.cleanup(); }
});
test("parallel expired-token requests refresh once, preserve native extension metadata and durable rotation", async () => {
	const release = deferred<OAuthCredential>();
	const f = await fixture({ login: async (id) => credential(id, 0), refresh: () => release.promise });
	try {
		await f.controller.login("github-copilot", true); const scope = await f.scope("github-copilot");
		const first = f.controller.lease(scope, false), second = f.controller.lease(scope, false);
		await new Promise((resolve) => setImmediate(resolve));
		const next = { ...credential("github-copilot"), refresh: "rotated-single-writer", extraNativeField: "retained" }; release.resolve(next);
		const results = await Promise.all([first, second]); assert.equal(f.refreshes, 1); assert.equal(results[0].auth.apiKey, next.access);
		const saved = JSON.parse(await fs.readFile(path.join(f.directory, "github-copilot-credentials.json"), "utf8"));
		assert.equal(saved.credential.refresh, "rotated-single-writer"); assert.equal(saved.credential.extraNativeField, "retained");
	} finally { await f.cleanup(); }
});
test("background changes retain foreground scope; replacement and disconnect invalidate old leases", async () => {
	const f = await fixture();
	try {
		await f.controller.login("xai", true); const scope = await f.scope("xai");
		await f.controller.consent("xai", false); await f.controller.lease(scope, false); await assert.rejects(f.controller.lease(scope, true));
		await f.controller.login("xai", false); assert.notEqual((await f.scope("xai")).connectionId, scope.connectionId); await assert.rejects(f.controller.lease(scope, false));
	} finally { await f.cleanup(); }
});
test("device interaction exposes only public code and opaque browser action; cancellation cannot commit late success", async () => {
	const done = deferred<OAuthCredential>();
	const f = await fixture({ login: async (_id, interaction) => { interaction.notify({ type: "device_code", userCode: "PUBLIC-CODE", verificationUri: "https://auth.x.ai/device?user_code=PUBLIC-CODE" }); return done.promise; } });
	try {
		const pending = f.controller.login("xai", true); await new Promise((resolve) => setImmediate(resolve));
		const status = (await f.controller.status()).find((s: any) => s.providerId === "xai"), interaction = status.interaction;
		assert.equal(interaction.userCode, "PUBLIC-CODE"); assert(!JSON.stringify(status).includes("device_code"));
		await f.controller.open("xai", interaction.attemptId, interaction.browser.id); assert.equal(f.opened.length, 1);
		await assert.rejects(f.controller.open("xai", "old", interaction.browser.id));
		f.controller.cancel("xai"); done.resolve(credential("xai")); await pending;
		assert.equal((await f.controller.status()).find((s: any) => s.providerId === "xai").connected, false);
		await assert.rejects(fs.readFile(path.join(f.directory, "xai-credentials.json")), (error: any) => error.code === "ENOENT");
	} finally { await f.cleanup(); }
});
test("cancelled replacement retains old credentials; late old completion cannot overwrite a newer login", async () => {
	let count = 0; const old = deferred<OAuthCredential>();
	const f = await fixture({ login: async (id) => ++count === 2 ? old.promise : credential(id) });
	try {
		await f.controller.login("xai", true); const first = await f.scope("xai");
		const pending = f.controller.login("xai", true); await new Promise((resolve) => setImmediate(resolve)); f.controller.cancel("xai");
		assert.equal((await f.scope("xai")).connectionId, first.connectionId);
		await f.controller.login("xai", true); const replacement = await f.scope("xai");
		old.resolve(credential("xai")); await pending;
		assert.equal((await f.scope("xai")).connectionId, replacement.connectionId);
	} finally { await f.cleanup(); }
});
for (const id of ids) test(`${id}: cancelled sign-in discards draft consent, and failed replacement retains the working connection`, async () => {
	let count = 0; const late = deferred<OAuthCredential>();
	const f = await fixture({ login: async (provider) => { count++; if (count === 1) return late.promise; if (count === 3) throw new Error("private-provider-login-error"); return credential(provider); } });
	try {
		const pending = f.controller.login(id, false); await new Promise((resolve) => setImmediate(resolve)); f.controller.cancel(id); late.resolve(credential(id)); await pending;
		assert.equal((await f.controller.status()).find((s: any) => s.providerId === id).allowBackgroundUse, true);
		await assert.rejects(fs.readFile(path.join(f.directory, `${id}-credentials.json`)), (error: any) => error.code === "ENOENT");
		await f.controller.login(id); const scope = await f.scope(id); const original = await fs.readFile(path.join(f.directory, `${id}-credentials.json`), "utf8");
		await assert.rejects(f.controller.login(id, false));
		assert.equal(await fs.readFile(path.join(f.directory, `${id}-credentials.json`), "utf8"), original);
		const status = (await f.controller.status()).find((s: any) => s.providerId === id); assert(status.connected); assert(status.allowBackgroundUse); assert(!JSON.stringify(status).includes("private-provider-login-error"));
		await f.controller.lease(scope, false);
	} finally { await f.cleanup(); }
});
test("Copilot native enterprise prompt is answered only through the current opaque prompt action", async () => {
	const f = await fixture({ login: async (id, interaction) => { const domain = await interaction.prompt({ type: "text", message: "GitHub domain", placeholder: "github.com" }); return { ...credential(id), enterpriseUrl: domain }; } });
	try {
		const pending = f.controller.login("github-copilot", false); await new Promise((resolve) => setImmediate(resolve));
		const status = (await f.controller.status()).find((s: any) => s.providerId === "github-copilot"), { attemptId, prompt } = status.interaction;
		assert.equal(prompt.type, "text"); assert.equal(prompt.message, "GitHub domain");
		await assert.rejects(f.controller.respond("github-copilot", "stale", prompt.id, "company.ghe.com"));
		await f.controller.respond("github-copilot", attemptId, prompt.id, "company.ghe.com"); await pending;
		const saved = JSON.parse(await fs.readFile(path.join(f.directory, "github-copilot-credentials.json"), "utf8")); assert.equal(saved.credential.enterpriseUrl, "company.ghe.com"); assert.equal(saved.allowBackgroundUse, false);
		assert(!(await f.controller.status()).find((s: any) => s.providerId === "github-copilot").interaction);
	} finally { await f.cleanup(); }
});
test("account endpoint rotation invalidates older scopes without losing the durable refreshed credential", async () => {
	const next = { ...credential("github-copilot"), access: "tid=fixture;proxy-ep=proxy.business.githubcopilot.com;" };
	const f = await fixture({ login: async (id) => credential(id, 0), refresh: async () => next });
	try {
		await f.controller.login("github-copilot"); const old = await f.scope("github-copilot"); await assert.rejects(f.controller.lease(old, false));
		const scope = await f.scope("github-copilot"); assert(scope.authorityRevision > old.authorityRevision); assert.equal(scope.connectionId, old.connectionId);
		assert.equal((await f.controller.lease(scope, false)).auth.baseUrl, "https://api.business.githubcopilot.com"); assert.equal(f.refreshes, 1);
		assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, "github-copilot-credentials.json"), "utf8")).credential.access, next.access);
	} finally { await f.cleanup(); }
});
test("a malformed returned rotation fails closed and cannot retry with the pre-rotation credential", async () => {
	const f = await fixture({ login: async (id) => credential(id, 0), refresh: async (id) => ({ ...credential(id), refresh: "rotated-but-malformed", expires: NaN }) });
	try {
		await f.controller.login("xai"); const scope = await f.scope("xai"); await assert.rejects(f.controller.lease(scope, false));
		await assert.rejects(f.controller.lease(scope, false)); await assert.rejects(f.controller.retry("xai")); assert.equal(f.refreshes, 1);
		assert(!(await f.controller.status()).find((s: any) => s.providerId === "xai").available);
	} finally { await f.cleanup(); }
});
test("renderer controls cannot obtain a request lease or internal snapshot", async () => {
	const f = await fixture();
	try { for (const op of ["lease", "snapshot", "read", "getAuth"]) await assert.rejects(subscriptionControl({ op }, f.controller)); }
	finally { await f.cleanup(); }
});
test("corrupt files isolate providers and are preserved; malformed Copilot model metadata never grants all models", async () => {
	const f = await fixture();
	try {
		const file = path.join(f.directory, "github-copilot-credentials.json"); await fs.writeFile(file, "{broken", { mode: 0o600 });
		const reloaded = createSubscriptions({ directory: f.directory, sdk: f.sdk, openExternal: async () => {} }); await reloaded.ready;
		const statuses = await reloaded.status(); assert(!statuses.find((s: any) => s.providerId === "github-copilot").available); assert(statuses.find((s: any) => s.providerId === "xai").available);
		await assert.rejects(reloaded.login("github-copilot", true)); assert.equal(await fs.readFile(file, "utf8"), "{broken"); reloaded.close();
		assert.throws(() => validateState("github-copilot", { version: 1, allowBackgroundUse: true, connectionId: "b5ac22b7-dfe3-4e52-ae0a-6da2990d4aef", credential: { ...credential("github-copilot"), availableModelIds: [123] } }));
	} finally { await f.cleanup(); }
});
test("failed rotation persistence blocks subsequent requests instead of using old tokens", async () => {
	let state: any = { version: 1, allowBackgroundUse: true }, fail = false;
	const stores = { xai: { read: async () => state, write: async (next: any) => { if (fail) throw new Error("private-disk-detail"); state = structuredClone(next); } } };
	const f = await fixture({ stores, login: async (id) => credential(id, 0) });
	try {
		await f.controller.login("xai", true); const scope = await f.scope("xai"); fail = true;
		await assert.rejects(f.controller.lease(scope, false)); assert.equal(f.refreshes, 1);
		await assert.rejects(f.controller.lease(scope, false)); assert.equal(f.refreshes, 1);
		const status = (await f.controller.status()).find((s: any) => s.providerId === "xai"); assert(!status.available); assert(!JSON.stringify(status).includes("private-disk-detail"));
	} finally { await f.cleanup(); }
});
test("disconnect during refresh cannot resurrect credentials or replace disconnect status with a stale error", async () => {
	const rotation = deferred<OAuthCredential>(); const f = await fixture({ login: async (id) => credential(id, 0), refresh: () => rotation.promise });
	try {
		await f.controller.login("xai", true); const scope = await f.scope("xai");
		const lease = f.controller.lease(scope, false).then(() => false, () => true);
		await new Promise((resolve) => setImmediate(resolve)); const disconnect = f.controller.disconnect("xai"); rotation.resolve({ ...credential("xai"), refresh: "do-not-resurrect" });
		await disconnect; assert(await lease);
		const status = (await f.controller.status()).find((s: any) => s.providerId === "xai"); assert.equal(status.connectionId, null); assert.equal(status.error, undefined);
		assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, "xai-credentials.json"), "utf8")), { version: 1, allowBackgroundUse: true });
	} finally { await f.cleanup(); }
});
test("pause during refresh saves returned rotation but refuses the request; resume uses durable refreshed state", async () => {
	const rotation = deferred<OAuthCredential>(); const f = await fixture({ login: async (id) => credential(id, 0), refresh: () => rotation.promise });
	try {
		await f.controller.login("xai", true); const scope = await f.scope("xai"); const lease = f.controller.lease(scope, false).then(() => false, () => true);
		await new Promise((resolve) => setImmediate(resolve)); f.controller.pause(); rotation.resolve({ ...credential("xai"), refresh: "rotation-survives-pause" }); assert(await lease);
		const saved = JSON.parse(await fs.readFile(path.join(f.directory, "xai-credentials.json"), "utf8")); assert.equal(saved.credential.refresh, "rotation-survives-pause");
		f.controller.resume(); await f.controller.lease(await f.scope("xai"), false); assert.equal(f.refreshes, 1);
	} finally { await f.cleanup(); }
});
test("enterprise domains are preserved; derived endpoints and control errors are guarded", async () => {
	const value = { ...credential("github-copilot"), enterpriseUrl: "company.ghe.com" };
	validateState("github-copilot", { version: 1, allowBackgroundUse: true, connectionId: "b5ac22b7-dfe3-4e52-ae0a-6da2990d4aef", credential: value });
	assert(validEndpoint("github-copilot", { apiKey: "fixture", baseUrl: "https://copilot-api.company.ghe.com" }, value));
	for (const baseUrl of ["http://api.individual.githubcopilot.com", "https://attacker.example/", "https://user:pass@api.individual.githubcopilot.com", "https://api.individual.githubcopilot.com/path"]) assert(!validEndpoint("github-copilot", { apiKey: "fixture", baseUrl }, value));
	await assert.rejects(subscriptionControl({ op: "status" }, { status: async () => { throw new Error("private-token-response"); } }), (error: Error) => !error.message.includes("private-token-response"));
	assert(!publicError(new Error("private-token-response")).includes("private-token-response"));
});
test("atomic store failed rename preserves original and leaves no temporary files", async () => {
	const f = await fixture();
	try {
		const file = path.join(f.directory, "scratch.json"), state = { version: 1, allowBackgroundUse: false };
		await fileStore(file, "xai").write(state);
		const io = { ...fs, rename: async () => { throw new Error("fixture-rename-failure"); } };
		await assert.rejects(fileStore(file, "xai", io).write({ version: 1, allowBackgroundUse: true }));
		assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), state);
		assert.deepEqual((await fs.readdir(f.directory)).filter((name) => name.endsWith(".tmp")), []);
	} finally { await f.cleanup(); }
});
