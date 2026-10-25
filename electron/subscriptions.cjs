"use strict";
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { createRequire, registerHooks } = require("node:module");
const { pathToFileURL } = require("node:url");
const { PROVIDERS, fileStore, validateCredential, safeHttps, failure } = require("./subscription-store.cjs");

const LABELS = { "github-copilot": "GitHub Copilot", xai: "Grok" };
const APIS = new Set(["openai-responses", "openai-completions", "anthropic-messages"]);
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const MESSAGES = {
	storage: "The saved connection could not be read or written safely. Reopen the app or reconnect after resolving the credential-file problem.",
	login: "Sign-in did not complete. Try connecting again.",
	refresh: "The connection could not be refreshed. Retry or reconnect in Providers.",
	cancel: "Sign-in cancelled.",
	unavailable: "This subscription connection is unavailable. Reconnect or explicitly choose another connection.",
	background: "Background use is off for this connection. Automatic follow-up remains deferred in its queue.",
	stale: "The connection or model catalog changed. Select an available model and retry.",
	interaction: "This sign-in action is no longer available.",
};
function publicError(error) { return MESSAGES[error?.code] ?? MESSAGES.unavailable; }
/** Resolve the SAME SDK installation as the standalone server, through public exports. */
async function loadSubscriptionSDK(baseDirectory) {
	const resolve = createRequire(path.join(baseDirectory, "package.json"));
	const load = (id) => {
		// Pi exports are import-only. Resolve the public export with ESM
		// conditions, then remove this synchronous, exact-specifier hook
		// BEFORE evaluation; no private package path or global hook remains.
		const hook = registerHooks({ resolve(specifier, context, next) {
			return next(specifier, specifier === id ? { ...context, conditions: [...context.conditions, "import"] } : context);
		} });
		let file;
		try { file = resolve.resolve(id); } finally { hook.deregister(); }
		return import(pathToFileURL(file).href);
	};
	const [sdk, copilot, xai] = await Promise.all([load("@earendil-works/pi-ai"), load("@earendil-works/pi-ai/providers/github-copilot"), load("@earendil-works/pi-ai/providers/xai")]);
	return { ...sdk, ...copilot, ...xai };
}
function validEndpoint(providerId, auth, credential) {
	if (!auth || (!(typeof auth.apiKey === "string" && auth.apiKey.length > 0) && !Object.entries(auth.headers ?? {}).some(([key, value]) => ["authorization", "x-api-key", "api-key"].includes(key.toLowerCase()) && typeof value === "string" && value.trim().length > 0))) return false;
	const value = auth.baseUrl ?? (providerId === "xai" ? "https://api.x.ai/v1" : "https://api.individual.githubcopilot.com");
	if (!safeHttps(value)) return false;
	const url = new URL(value);
	if (providerId === "xai") return url.origin === "https://api.x.ai" && url.pathname.replace(/\/$/, "") === "/v1" && !url.search && !url.hash;
	const domain = credential?.enterpriseUrl;
	return !url.search && !url.hash && url.pathname === "/" && (!url.port || url.port === "443") && (url.hostname.endsWith(".githubcopilot.com") || (domain && (url.hostname === domain || url.hostname.endsWith(`.${domain}`))));
}
/** Main owns durable credentials and refresh. Everything returned by status/snapshot is explicitly projected. */
function createSubscriptions(options) {
	let sdk;
	let closed = false, paused = false;
	const entries = new Map(PROVIDERS.map((providerId) => [providerId, {
		providerId, state: { version: 1, allowBackgroundUse: true }, disk: options.stores?.[providerId] ?? fileStore(path.join(options.directory, `${providerId}-credentials.json`), providerId),
		epoch: 0, authorityRevision: 0, revision: 0, tail: Promise.resolve(), fatal: false, blocked: false, ready: false, error: undefined, authFailed: false, attempt: null, catalog: [], endpoint: null,
	}]));
	const entryFor = (id) => { const entry = entries.get(id); if (!entry) throw failure("unavailable"); return entry; };
	function serialized(entry, fn) { const result = entry.tail.then(fn); entry.tail = result.catch(() => {}); return result; }
	function statusOf(entry) {
		const available = entry.ready && !closed && !paused && !entry.fatal;
		const attempt = entry.attempt;
		return {
			providerId: entry.providerId, available, connected: !!(available && entry.state.credential && !entry.blocked && !entry.authFailed), pending: !!attempt, committing: attempt?.committing === true,
			allowBackgroundUse: entry.state.allowBackgroundUse, connectionId: entry.state.connectionId ?? null,
			epoch: entry.epoch, authorityRevision: entry.authorityRevision, revision: entry.revision,
			...(entry.error ? { error: entry.error } : {}),
			...(attempt ? { interaction: clone(attempt.public) } : {}),
		};
	}
	function snapshotNow() {
		return { statuses: [...entries.values()].map(statusOf), models: Object.fromEntries([...entries.values()].map((entry) => [entry.providerId, statusOf(entry).connected ? clone(entry.catalog) : []])) };
	}
	function changed(entry) { entry.revision++; try { options.onChange?.(snapshotNow()); } catch { /* observer cannot break credential writes */ } }
	function catalog(entry) {
		let models = entry.provider?.getModels().filter((model) => APIS.has(model.api)) ?? [];
		if (!entry.state.credential) models = [];
		else if (entry.providerId === "github-copilot" && !Array.isArray(entry.state.credential.availableModelIds)) models = [];
		else if (entry.provider?.filterModels) models = [...entry.provider.filterModels(models, entry.state.credential)];
		if (JSON.stringify(models) !== JSON.stringify(entry.catalog)) { entry.catalog = models; entry.authorityRevision++; }
	}
	async function updateEndpoint(entry) {
		let endpoint = null;
		if (entry.state.credential) {
			const auth = await entry.provider.auth.oauth.toAuth(entry.state.credential);
			if (!validEndpoint(entry.providerId, auth, entry.state.credential)) throw failure("storage");
			endpoint = auth.baseUrl ?? (entry.providerId === "xai" ? "https://api.x.ai/v1" : "https://api.individual.githubcopilot.com");
		}
		if (entry.endpoint !== endpoint) { entry.endpoint = endpoint; entry.authorityRevision++; }
	}
	function storageFailed(entry) { entry.fatal = true; entry.blocked = true; entry.epoch++; entry.error = MESSAGES.storage; changed(entry); }
	async function save(entry, state) {
		try { await entry.disk.write(state); } catch { storageFailed(entry); throw failure("storage"); }
		entry.state = clone(state);
		try { await updateEndpoint(entry); catalog(entry); } catch { storageFailed(entry); throw failure("storage"); }
		changed(entry);
	}
	const ready = (async () => {
		try { sdk = options.sdk ?? await options.loadSDK(); }
		catch { for (const entry of entries.values()) { entry.error = MESSAGES.unavailable; entry.fatal = true; changed(entry); } return; }
		await Promise.all([...entries.values()].map(async (entry) => {
			try {
				entry.state = clone(await entry.disk.read());
				const native = entry.providerId === "github-copilot" ? sdk.githubCopilotProvider() : sdk.xaiProvider();
				// No API-key auth method exists in this collection: ambient keys cannot become a fallback.
				entry.provider = { ...native, auth: { oauth: native.auth.oauth } };
				const store = {
					read: async (id) => id === entry.providerId ? clone(entry.state.credential) : undefined,
					list: async () => entry.state.credential ? [{ providerId: entry.providerId, type: "oauth" }] : [],
					modify: (id, fn, operation) => serialized(entry, async () => {
						if (id !== entry.providerId || entry.fatal || closed || paused || operation?.signal?.aborted) throw failure("unavailable");
						const next = await fn(clone(entry.state.credential));
						// A returned rotation must be saved even if the app paused while
						// refresh was in flight. Admission is rechecked after resolution;
						// queued logout deletes only after this serialized durable write.
						if (next !== undefined && JSON.stringify(next) !== JSON.stringify(entry.state.credential)) {
							try { validateCredential(id, next); } catch { storageFailed(entry); throw failure("storage"); }
							await save(entry, { ...entry.state, credential: next });
						}
						return clone(entry.state.credential);
					}),
					delete: (id) => serialized(entry, async () => {
						if (id !== entry.providerId || entry.fatal) throw failure("storage");
						await save(entry, { version: 1, allowBackgroundUse: entry.state.allowBackgroundUse });
					}),
				};
				entry.models = sdk.createModels({ credentials: store }); entry.models.setProvider(entry.provider);
				await updateEndpoint(entry); entry.ready = true; catalog(entry); changed(entry);
			} catch { entry.fatal = true; entry.error = MESSAGES.storage; changed(entry); }
		}));
	})();
	function current(entry, scope) {
		return statusOf(entry).connected && scope?.providerId === entry.providerId && scope.connectionId === entry.state.connectionId && scope.epoch === entry.epoch && scope.authorityRevision === entry.authorityRevision && entry.catalog.some((m) => m.id === scope.selectedModelId);
	}
	async function consent(providerId, enabled) {
		await ready; const entry = entryFor(providerId);
		if (typeof enabled !== "boolean" || entry.fatal || closed || paused) throw failure("unavailable");
		await serialized(entry, async () => { if (entry.state.allowBackgroundUse !== enabled) await save(entry, { ...entry.state, allowBackgroundUse: enabled }); });
	}
	async function login(providerId, enabled) {
		await ready; const entry = entryFor(providerId);
		if ((enabled !== undefined && typeof enabled !== "boolean") || entry.fatal || closed || paused || !entry.ready) throw failure("unavailable");
		if ([...entries.values()].some((e) => e.attempt)) throw failure("interaction");
		const abort = new AbortController();
		const attempt = { id: randomUUID(), abort, committing: false, actions: new Map(), prompt: null, public: {} };
		attempt.public = { attemptId: attempt.id }; entry.attempt = attempt; entry.error = undefined; changed(entry);
		const active = () => entry.attempt === attempt && !abort.signal.aborted && !closed && !paused;
		const addBrowser = (value) => {
			if (!safeHttps(value)) throw failure("interaction");
			const id = randomUUID(); attempt.actions.set(id, value);
			const url = new URL(value); attempt.public.browser = { id, url: `${url.origin}${url.pathname}` };
		};
		try {
			const staging = sdk.createModels(); staging.setProvider(entry.provider);
			const credential = await staging.login(providerId, "oauth", {
				signal: abort.signal,
				notify: (event) => {
					if (!active()) return;
					if (event.type === "auth_url") addBrowser(event.url);
					if (event.type === "device_code") { addBrowser(event.verificationUri); attempt.public.userCode = event.userCode; }
					// Native provider diagnostics are never forwarded. Public prompt wording comes from SDK-owned prompts.
					attempt.public.progress = event.type === "device_code" || event.type === "auth_url" ? "Complete sign-in in your browser." : "Waiting for the provider…";
					changed(entry);
				},
				prompt: (prompt) => new Promise((resolve, reject) => {
					if (!active() || prompt.signal?.aborted) { reject(failure("cancel")); return; }
					const id = randomUUID();
					const stop = () => { cleanup(); reject(failure("cancel")); };
					const cleanup = () => { abort.signal.removeEventListener("abort", stop); prompt.signal?.removeEventListener("abort", stop); if (attempt.prompt?.id === id) { attempt.prompt = null; delete attempt.public.prompt; } };
					attempt.prompt = { id, resolve: (value) => { cleanup(); resolve(value); }, reject: stop };
					attempt.public.prompt = { id, type: prompt.type, message: prompt.message, ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}), ...(prompt.type === "select" ? { options: clone(prompt.options) } : {}) };
					abort.signal.addEventListener("abort", stop, { once: true }); prompt.signal?.addEventListener("abort", stop, { once: true }); changed(entry);
				}),
			}, { agentName: "LearnHarness" });
			if (!active()) throw failure("cancel"); validateCredential(providerId, credential);
			const auth = await entry.provider.auth.oauth.toAuth(credential);
			if (!validEndpoint(providerId, auth, credential) || !active()) throw failure("login");
			await serialized(entry, async () => {
				if (!active() || entry.fatal) throw failure("cancel");
				attempt.committing = true; entry.blocked = true; entry.epoch++; changed(entry);
				await save(entry, { version: 1, allowBackgroundUse: enabled ?? entry.state.allowBackgroundUse, connectionId: randomUUID(), credential });
				entry.blocked = false; entry.authFailed = false; entry.error = undefined;
			});
		} catch (error) {
			if (active() && !entry.fatal) entry.error = error?.code === "cancel" ? undefined : MESSAGES.login;
			if (!abort.signal.aborted) throw failure(entry.fatal ? "storage" : "login");
		} finally { attempt.prompt?.reject(); if (entry.attempt === attempt) { entry.attempt = null; changed(entry); } }
	}
	function cancel(providerId) { const entry = entryFor(providerId); if (entry.attempt && !entry.attempt.committing) { entry.attempt.abort.abort(); entry.attempt = null; if (entry.authFailed && !entry.error) entry.error = MESSAGES.refresh; changed(entry); } }
	async function resolveAuth(entry, modelId) {
		if (entry.fatal || closed || paused || !entry.state.credential) throw failure("unavailable");
		const connectionId = entry.state.connectionId, epoch = entry.epoch;
		const unchanged = () => connectionId === entry.state.connectionId && epoch === entry.epoch && !entry.blocked && !closed && !paused;
		try {
			const model = entry.provider.getModels().find((m) => m.id === modelId);
			if (!model) throw failure("stale");
			const resolved = await entry.models.getAuth(model);
			if (!unchanged()) throw failure("stale");
			if (!validEndpoint(entry.providerId, resolved?.auth, entry.state.credential)) throw failure("unavailable");
			return {
				...(typeof resolved.auth.apiKey === "string" ? { apiKey: resolved.auth.apiKey } : {}),
				...(resolved.auth.headers ? { headers: Object.fromEntries(Object.entries(resolved.auth.headers).filter(([, value]) => value === null || typeof value === "string")) } : {}),
				...(typeof resolved.auth.baseUrl === "string" ? { baseUrl: resolved.auth.baseUrl } : {}),
			};
		} catch (error) {
			if (!entry.fatal && unchanged()) { entry.authFailed = true; entry.error = MESSAGES.refresh; entry.epoch++; changed(entry); }
			throw failure(entry.fatal ? "storage" : error?.code === "stale" ? "stale" : "refresh");
		}
	}
	return {
		ready,
		async snapshot() { await ready; return snapshotNow(); },
		async status() { await ready; return snapshotNow().statuses; },
		login, consent, cancel,
		async respond(providerId, attemptId, promptId, value) {
			const entry = entryFor(providerId), attempt = entry.attempt;
			if (!attempt || attempt.id !== attemptId || attempt.prompt?.id !== promptId || typeof value !== "string" || value.length > 4096) throw failure("interaction");
			const prompt = attempt.public.prompt;
			if (prompt.type === "select" && !prompt.options.some((option) => option.id === value)) throw failure("interaction");
			attempt.prompt.resolve(value); changed(entry);
		},
		async open(providerId, attemptId, actionId) {
			const attempt = entryFor(providerId).attempt;
			const target = attempt?.id === attemptId ? attempt.actions.get(actionId) : undefined;
			if (!target || !safeHttps(target)) throw failure("interaction");
			try { await options.openExternal(target); } catch { throw failure("interaction"); }
		},
		async lease(scope, background) {
			await ready; const entry = entryFor(scope?.providerId);
			if (!current(entry, scope)) throw failure("stale");
			if (background && !entry.state.allowBackgroundUse) throw failure("background");
			const auth = await resolveAuth(entry, scope.selectedModelId);
			if (!current(entry, scope)) throw failure("stale");
			if (background && !entry.state.allowBackgroundUse) throw failure("background");
			return { scope: clone(scope), auth: clone(auth) };
		},
		async retry(providerId) {
			await ready; const entry = entryFor(providerId);
			const model = entry.catalog[0]; if (!model || entry.fatal || entry.blocked) throw failure("unavailable");
			await resolveAuth(entry, model.id); entry.authFailed = false; entry.error = undefined; changed(entry);
		},
		async disconnect(providerId) {
			await ready; const entry = entryFor(providerId); cancel(providerId);
			if (entry.fatal) throw failure("storage");
			entry.blocked = true; entry.epoch++; changed(entry);
			await entry.models.logout(providerId); entry.blocked = false; entry.authFailed = false; entry.error = undefined; changed(entry);
		},
		pause() { paused = true; for (const entry of entries.values()) { cancel(entry.providerId); entry.epoch++; changed(entry); } },
		resume() { if (closed) return; paused = false; for (const entry of entries.values()) changed(entry); },
		close() { closed = true; for (const entry of entries.values()) { cancel(entry.providerId); entry.epoch++; changed(entry); } },
	};
}
module.exports = { createSubscriptions, loadSubscriptionSDK, publicError, validEndpoint, LABELS };
