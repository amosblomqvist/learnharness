/** The native-provider registry pins (reviewer issue #1, 2026-10-27): ONE
 *  list of Pi-backed subscription providers feeds both loaders, the
 *  credential store, the browser-safe contract, the smoke scripts and the
 *  test fakes — these pins make a second, drifting list impossible. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { NATIVE_SUBSCRIPTIONS } from "../src/core/contracts/subscriptions.ts";

const require = createRequire(import.meta.url);
const registry = require("../electron/native-providers.cjs");
const { PROVIDERS } = require("../electron/subscription-store.cjs");
const { LABELS } = require("../electron/subscriptions.cjs");
const { WEB_NATIVE_SDK_IMPORTS } = await import("../src/server/web-subscriptions.ts");

test("the browser-safe contract list is exactly the registry's projection", () => {
	assert.deepEqual(
		NATIVE_SUBSCRIPTIONS.map((p) => ({ providerId: p.providerId, logicalId: p.logicalId, label: p.label })),
		registry.NATIVE_PROVIDERS.map((p: { providerId: string; logicalId: string; label: string }) => ({ providerId: p.providerId, logicalId: p.logicalId, label: p.label })),
	);
	assert.deepEqual(PROVIDERS, registry.NATIVE_PROVIDER_IDS);
	assert.deepEqual(LABELS, Object.fromEntries(registry.NATIVE_PROVIDERS.map((p: { providerId: string; label: string }) => [p.providerId, p.label])));
});

test("the web loader's static import table covers every registry module and nothing else", () => {
	assert.deepEqual(Object.keys(WEB_NATIVE_SDK_IMPORTS).sort(), [...registry.NATIVE_SDK_SPECIFIERS].sort());
});

test("every registry module exports its factory, and a missing factory is reported as unavailable with its cause", async () => {
	const sdk = await registry.loadNativeProviderSDK((specifier: string) => import(specifier));
	assert.equal(typeof sdk.createModels, "function");
	for (const descriptor of registry.NATIVE_PROVIDERS) {
		const provider = registry.createNativeProvider(sdk, descriptor.providerId);
		assert.equal(provider.id, descriptor.providerId);
		assert.ok(provider.getModels().length > 0, `${descriptor.providerId}: empty catalog`);
	}
	assert.throws(() => registry.createNativeProvider({ createModels: sdk.createModels }, "xai"), (error: Error & { code?: string }) => error.code === "unavailable" && /providers\/xai does not export xaiProvider/.test(error.message));
	assert.throws(() => registry.createNativeProvider(sdk, "anthropic"), (error: Error & { code?: string }) => error.code === "unavailable");
	// The web loader fails loudly on a specifier it has no literal import for.
	const { NATIVE_SDK_SPECIFIERS } = registry;
	const missing = registry.loadNativeProviderSDK((specifier: string) => specifier === NATIVE_SDK_SPECIFIERS[0] ? import(specifier) : Promise.reject(new Error(`no import for ${specifier}`)));
	await assert.rejects(missing, /no import for/);
});
