"use strict";
const fs = require("node:fs/promises");
const { protectedStore } = require("./protected-store.cjs");

const PROVIDERS = ["github-copilot", "xai"];
const failure = (code) => Object.assign(new Error(code), { code });
const nonempty = (value) => typeof value === "string" && value.length > 0 && !/[\x00-\x20\x7f]/.test(value);
function validateCredential(providerId, credential) {
	if (!credential || credential.type !== "oauth" || !nonempty(credential.access) || !nonempty(credential.refresh) || !Number.isFinite(credential.expires) || credential.expires < 0) throw failure("storage");
	if (providerId === "github-copilot") {
		if (credential.enterpriseUrl !== undefined && !safeDomain(credential.enterpriseUrl)) throw failure("storage");
		if (credential.availableModelIds !== undefined && (!Array.isArray(credential.availableModelIds) || !credential.availableModelIds.every(nonempty))) throw failure("storage");
	}
	return credential;
}
function safeDomain(value) {
	if (typeof value !== "string" || !value || /[\s/:@?#\\]/.test(value)) return false;
	try { return new URL(`https://${value}`).hostname === value; } catch { return false; }
}
function safeHttps(value) {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password;
	} catch { return false; }
}
function validateState(providerId, state) {
	if (!PROVIDERS.includes(providerId) || !state || state.version !== 1 || typeof state.allowBackgroundUse !== "boolean") throw failure("storage");
	const hasId = Object.hasOwn(state, "connectionId");
	if (hasId !== Object.hasOwn(state, "credential") || (hasId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(state.connectionId))) throw failure("storage");
	if (hasId) validateCredential(providerId, state.credential);
	return state;
}
/** Main-process OS-protected state, independently bound to each provider. */
function fileStore(file, providerId, io = fs, safeStorage) {
	return protectedStore(file, {
		safeStorage, io, validate: (state) => validateState(providerId, state),
		kind: providerId, missing: () => ({ version: 1, allowBackgroundUse: true }),
	});
}

module.exports = { PROVIDERS, failure, validateCredential, validateState, safeDomain, safeHttps, fileStore };
