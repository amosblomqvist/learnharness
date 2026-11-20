"use strict";
/**
 * THE ONE native-provider registry (reviewer issue #1 on the retired
 * Claude OAuth attempt, 2026-10-27): which Pi-backed subscription providers
 * exist and how their SDK modules load. Both loaders — Electron main's
 * `subscriptions.cjs` (createRequire + a one-shot ESM resolve hook) and the
 * web/dev owner in `src/server/web-subscriptions.ts` (static import()
 * table) — hand their own `load(specifier)` to loadNativeProviderSDK and get
 * the SAME merged SDK surface; the credential store, both smoke scripts and
 * the test fakes iterate NATIVE_PROVIDERS instead of carrying their own
 * provider lists. The browser-safe contract list (src/core/contracts/
 * subscriptions.ts NATIVE_SUBSCRIPTIONS) is pinned equal to this
 * registry's projection by tests/native-providers.test.ts.
 *
 * Adding a provider = one entry here + its static import in the web
 * loader (the pin test fails until both exist); a factory the SDK does not
 * export is reported as "unavailable" with its cause, never as a storage
 * failure.
 */
const PI_SDK_SPECIFIER = "@earendil-works/pi-ai";
const NATIVE_PROVIDERS = Object.freeze([
	Object.freeze({
		providerId: "github-copilot",
		logicalId: "github-copilot-subscription",
		label: "GitHub Copilot",
		specifier: "@earendil-works/pi-ai/providers/github-copilot",
		factory: "githubCopilotProvider",
		defaultBaseUrl: "https://api.individual.githubcopilot.com",
	}),
	Object.freeze({
		providerId: "xai",
		logicalId: "xai-subscription",
		label: "Grok",
		specifier: "@earendil-works/pi-ai/providers/xai",
		factory: "xaiProvider",
		defaultBaseUrl: "https://api.x.ai/v1",
	}),
]);
const NATIVE_PROVIDER_IDS = Object.freeze(NATIVE_PROVIDERS.map((provider) => provider.providerId));
/** Every module specifier a loader must be able to load, Pi's root first. */
const NATIVE_SDK_SPECIFIERS = Object.freeze([PI_SDK_SPECIFIER, ...NATIVE_PROVIDERS.map((provider) => provider.specifier)]);

function nativeProvider(providerId) {
	const descriptor = NATIVE_PROVIDERS.find((provider) => provider.providerId === providerId);
	if (!descriptor) throw Object.assign(new Error(`unknown native provider ${providerId}`), { code: "unavailable" });
	return descriptor;
}
/** Merge Pi's root exports with every registered provider module. `load`
 *  is the caller's module loader (import() or a resolve-hooked require). */
async function loadNativeProviderSDK(load) {
	const modules = await Promise.all(NATIVE_SDK_SPECIFIERS.map((specifier) => load(specifier)));
	return Object.assign({}, ...modules);
}
/** Construct one provider from a loaded SDK surface, naming the missing
 *  factory when the SDK and the registry disagree. */
function createNativeProvider(sdk, providerId) {
	const descriptor = nativeProvider(providerId);
	const factory = sdk?.[descriptor.factory];
	if (typeof factory !== "function") throw Object.assign(new Error(`${descriptor.specifier} does not export ${descriptor.factory}`), { code: "unavailable" });
	return factory();
}
module.exports = { PI_SDK_SPECIFIER, NATIVE_PROVIDERS, NATIVE_PROVIDER_IDS, NATIVE_SDK_SPECIFIERS, nativeProvider, loadNativeProviderSDK, createNativeProvider };
