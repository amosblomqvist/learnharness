"use strict";

// LearnHarness-owned public-client OAuth. Never import pi's bundled login.
// This module is main-process-only; dependencies are injectable for scratch tests.
const crypto = require("node:crypto");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const REVOCATION_WARNING = "Account disconnected locally. Remote revocation could not be confirmed.";
const random = () => crypto.randomBytes(32).toString("base64url");
const fail = (code) => Object.assign(new Error(code), { code });
const TRANSIENT_TRANSPORT_CODES = new Set([
	"ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "EPIPE",
	"ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
]);
const publicError = (err) => ({
	cancelled: "ChatGPT sign-in cancelled.",
	timeout: "ChatGPT sign-in timed out. Try again.",
	storage: "ChatGPT credentials could not be read or saved. Check local file access, then reconnect before making requests.",
	identity: "ChatGPT sign-in could not be verified. Select the intended saved account and try again.",
	scope: "ChatGPT plan permission is missing. Reconnect and authorize ChatGPT plan use.",
	disconnected: "This ChatGPT connection is disconnected. Reconnect in Providers.",
	background: "ChatGPT background use is off in this app. Enable Allow background use for all ChatGPT accounts in Providers, or explicitly select an API-key model for that workload.",
	catalog: "The ChatGPT account model catalog is unavailable. Retry the connection; no API-key fallback was used.",
	expired: "The ChatGPT session expired. Reconnect in Providers.",
	network: "ChatGPT could not be reached. Check your connection and try again.",
	pending: "A ChatGPT sign-in is already pending.",
	unavailable: "ChatGPT sign-in is unavailable in browser-only mode.",
}[err?.code] || "ChatGPT sign-in failed. Try again; no API-key fallback was used.");

const nonempty = (v) => typeof v === "string" && v.length > 0 && !/[\x00-\x20\x7f]/.test(v);
const planScopes = (tokens) => !!tokens?.accessToken && SCOPES.every((scope) => tokens.scopes.includes(scope));
/** Reject the entire credential record when its schema is invalid. */
function validateState(state) {
	if (!state || state.version !== 1 || !nonempty(state.hostId) || !Array.isArray(state.registrations) || !(state.activeId === null || nonempty(state.activeId))) throw fail("storage");
	if (Object.hasOwn(state, "allowBackgroundUse") && typeof state.allowBackgroundUse !== "boolean") throw fail("storage");
	const ids = new Set(); const clients = new Set();
	for (const r of state.registrations) {
		if (!r || !nonempty(r.id) || ids.has(r.id) || !nonempty(r.clientId) || r.clientId === "dynamic_agent_client" || clients.has(r.clientId) || r.issuer !== ISSUER || !nonempty(r.subject) || (Object.hasOwn(r, "background") && typeof r.background !== "boolean") || (r.email !== undefined && typeof r.email !== "string") || (Object.hasOwn(r, "reconnectRequired") && r.reconnectRequired !== true)) throw fail("storage");
		ids.add(r.id); clients.add(r.clientId);
		if (r.tokens !== undefined) {
			const t = r.tokens;
			if (!t || !nonempty(t.idToken) || !Array.isArray(t.scopes) || t.scopes.some((s) => !nonempty(s)) || !Number.isFinite(t.expiresAt) || t.expiresAt < 0 || (t.accessToken !== undefined && (!nonempty(t.accessToken) || t.accessToken.startsWith("sk-"))) || (t.refreshToken !== undefined && !nonempty(t.refreshToken))) throw fail("storage");
		}
	}
	if (state.activeId !== null && !ids.has(state.activeId)) throw fail("storage");
	return state;
}

/** Private, unencrypted JSON outside learning data. No OS credential-store access. */
function fileStore(file) {
	return {
		async read() {
			try {
				return validateState(JSON.parse(await fs.readFile(file, "utf8")));
			} catch (err) {
				if (err.code === "ENOENT") return null;
				throw fail("storage");
			}
		},
		async write(state) {
			validateState(state);
			const temp = `${file}.${crypto.randomUUID()}.tmp`;
			let handle;
			try {
				await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
				handle = await fs.open(temp, "wx", 0o600);
				await handle.writeFile(`${JSON.stringify(state)}\n`);
				await handle.sync();
				await handle.close();
				handle = null;
				await fs.rename(temp, file);
				// Directory fsync is supported on Unix; the file fsync above is mandatory.
				if (process.platform !== "win32") {
					const dir = await fs.open(path.dirname(file), "r");
					try { await dir.sync(); } finally { await dir.close(); }
				}
			} catch {
				throw fail("storage");
			} finally {
				await handle?.close().catch(() => {});
				await fs.unlink(temp).catch(() => {});
			}
		},
	};
}

function allowedAuthEndpoint(value) {
	try {
		const url = new URL(value);
		return url.origin === ISSUER && !url.username && !url.password && !url.search && !url.hash;
	} catch { return false; }
}

function createChatGPT({ store, openExternal, fetch: request = globalThis.fetch, onChange = () => {}, timeoutMs = 180000 }) {
	let state;
	let init;
	let queue = Promise.resolve();
	let epoch = 0;
	let revision = 0;
	let authorityRevision = 0;
	let catalogSequence = 0;
	let storageDenied = false;
	const stamp = () => ({ epoch, authorityRevision, revision });
	let backgroundIntent;
	let pending;
	let catalog = [];
	let catalogError = null;
	let lastError = null;
	let closed = false;
	let paused = false;
	let suspended = false;
	let retryRegistration;
	let transportAbort = new AbortController();
	let backgroundAbort = new AbortController();
	const serial = (fn) => {
		const next = queue.then(fn, fn);
		queue = next.catch(() => {});
		return next;
	};
	const active = () => !storageDenied && !suspended && !closed && !paused ? state?.registrations.find((r) => r.id === state.activeId && r.tokens && !r.reconnectRequired) : undefined;
	// These fields are validated/verified before storage. Email is never identity.
	const sameAccount = (a, b) => a.issuer === b.issuer && a.subject === b.subject;
	function accountGroups() {
		const groups = [];
		for (const record of state?.registrations || []) {
			const group = groups.find((members) => sameAccount(members[0], record));
			if (group) group.push(record); else groups.push([record]);
		}
		return groups;
	}
	const backgroundAllowed = () => state?.allowBackgroundUse !== false && backgroundIntent?.enabled !== false;
	const notify = (invalidate = "none") => { revision++; onChange({ channel: "lh:chatgpt", kind: "state", stamp: stamp(), status: snapshot(), invalidate }); };
	function stop(backgroundOnly = false) {
		if (backgroundOnly) {
			backgroundAbort.abort();
			backgroundAbort = new AbortController();
			notify("background");
			return;
		}
		suspended = true;
		epoch++;
		authorityRevision++;
		catalogSequence++;
		transportAbort.abort();
		transportAbort = new AbortController();
		catalog = [];
		catalogError = null;
		notify("all");
	}
	async function ready() {
		if (closed) throw fail("disconnected");
		if (!init) init = (async () => {
			const loaded = await store.read();
			state = loaded ? validateState(loaded) : null;
			if (!state) {
				const first = { version: 1, hostId: `urn:uuid:${crypto.randomUUID()}`, activeId: null, registrations: [] };
				await store.write(first);
				state = first;
			}
		})();
		try { await init; } catch (err) { denyStorage(err); throw err; }
	}
	function denyStorage(err) {
		if (!storageDenied) { storageDenied = true; lastError = publicError(err); stop(); }
	}
	async function save(next) {
		try { validateState(next); await store.write(next); } catch (err) {
			// A rotated token may already have invalidated its predecessor. Fail closed.
			denyStorage(err);
			lastError = publicError(err);
			notify();
			throw err;
		}
		state = next;
	}
	function snapshot() {
		return {
			available: !!state && !closed && !paused,
			pending: !!pending,
			allowBackgroundUse: backgroundAllowed(),
			activeId: state?.activeId ?? null,
			accounts: accountGroups().map((members) => {
				// Preserve the actual active registration ID at the private transport
				// boundary; inactive groups prefer a usable registration, then a
				// remembered one. No credential/client records are merged or deleted.
				const r = members.find((r) => r.id === state.activeId) ?? members.find((r) => !r.reconnectRequired && planScopes(r.tokens)) ?? members[0];
				return {
					id: r.id,
					email: r.email || "ChatGPT account",
					registration: r.clientId,
					connected: !storageDenied && !closed && !paused && !suspended && !r.reconnectRequired && planScopes(r.tokens),
					planEnabled: !storageDenied && !r.reconnectRequired && planScopes(r.tokens),
					// Recovery is authorization-only, not a response to storage failure
					// or temporary transport suspension. Never infer it from error copy.
					canSignInAgain: !storageDenied && !closed && !paused && (r.reconnectRequired === true || !planScopes(r.tokens)),
				};
			}),
			error: lastError,
			catalogError,
		};
	}
	async function status() {
		try { await ready(); } catch (err) { return { ...snapshot(), available: false, error: publicError(err) }; }
		return snapshot();
	}
	async function json(url, options = {}) {
		try {
			const response = await request(url, { ...options, redirect: "error", signal: options.signal ?? AbortSignal.timeout(15000) });
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				const oauthCode = typeof body.error === "string" ? body.error : body.error?.code;
				throw Object.assign(fail(oauthCode === "invalid_grant" || response.status === 401 || response.status === 403 ? "expired" : "network"), { oauthCode, retryable: response.status >= 500 });
			}
			return await response.json();
		} catch (err) {
			if (err?.code) {
				if (!options.signal?.aborted && TRANSIENT_TRANSPORT_CODES.has(err.code)) err.retryable = true;
				throw err;
			}
			const transportFailure = err instanceof TypeError && (!err.cause?.code || TRANSIENT_TRANSPORT_CODES.has(err.cause.code));
			throw Object.assign(fail("network"), { retryable: !options.signal?.aborted && transportFailure });
		}
	}
	async function identity(idToken, clientId, nonce, expectedSubject) {
		try {
			const { jwtVerify, createLocalJWKSet } = await import("jose");
			// Fixed, documented JWKS origin; never follow a discovery-supplied URL.
			const keys = await json(JWKS);
			const { payload } = await jwtVerify(idToken, createLocalJWKSet(keys), {
				issuer: ISSUER, audience: clientId, algorithms: ["RS256"],
				requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5,
			});
			if (typeof payload.sub !== "string" || !payload.sub || (nonce !== undefined && payload.nonce !== nonce) || (expectedSubject && payload.sub !== expectedSubject)) throw fail("identity");
			if ((payload.azp !== undefined && payload.azp !== clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw fail("identity");
			return { subject: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined };
		} catch { throw fail("identity"); }
	}
	function tokenSet(body, previous) {
		const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/) : previous?.scopes;
		if (!scopes || SCOPES.some((scope) => !scopes.includes(scope))) {
			// Lack of entitlement is not lack of revocable material.
			return { idToken: body.id_token ?? previous?.idToken, scopes: scopes ?? [], expiresAt: 0,
				...(nonempty(body.refresh_token) ? { refreshToken: body.refresh_token } : previous?.refreshToken ? { refreshToken: previous.refreshToken } : {}) };
		}
		if (typeof body.access_token !== "string" || !body.access_token || body.access_token.startsWith("sk-") || body.token_type?.toLowerCase() !== "bearer" || !Number.isFinite(body.expires_in) || body.expires_in <= 0) throw fail("identity");
		const refreshToken = body.refresh_token ?? previous?.refreshToken;
		if (!nonempty(refreshToken)) throw fail("identity");
		return { accessToken: body.access_token, refreshToken, idToken: body.id_token ?? previous?.idToken, scopes, expiresAt: Date.now() + body.expires_in * 1000 };
	}
	async function grant(fields, signal) {
		return json(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ ...fields, resource: RESOURCE }), signal });
	}

	async function login(accountId) {
		await ready();
		if (pending) throw fail("pending");
		if (paused) throw fail("disconnected");
		const selected = accountId ? state.registrations.find((r) => r.id === accountId) : retryRegistration;
		if (accountId && !selected) throw fail("identity");
		const attemptEpoch = epoch;
		const verifier = random();
		const nonce = random();
		const expectedState = random();
		const abort = new AbortController();
		let finish;
		const completion = new Promise((resolve) => { finish = resolve; });
		const listener = http.createServer();
		let timer;
		let consumed = false;
		const cleanup = () => { clearTimeout(timer); listener.close(); listener.closeAllConnections(); };
		const cancel = (code = "cancelled") => {
			abort.abort();
			cleanup();
			if (pending?.abort === abort) pending = null;
			lastError = publicError(fail(code));
			finish();
			notify();
		};
		pending = { abort, cancel };
		lastError = null;
		notify();
		try {
			await new Promise((resolve, reject) => {
				listener.once("error", reject);
				listener.listen(0, "127.0.0.1", resolve);
			});
			const redirectUri = `http://127.0.0.1:${listener.address().port}/auth/callback`;
			listener.on("request", async (req, res) => {
				let callback;
				try { callback = new URL(req.url || "/", redirectUri); }
				catch { res.writeHead(400).end(); return; }
				res.setHeader("Cache-Control", "no-store");
				res.setHeader("Content-Security-Policy", "default-src 'none'");
				res.setHeader("Referrer-Policy", "no-referrer");
				if (req.method !== "GET" || callback.origin !== new URL(redirectUri).origin || callback.pathname !== "/auth/callback" || req.headers.host !== new URL(redirectUri).host || consumed) { res.writeHead(404).end(); return; }
				const params = callback.searchParams;
				// Reject duplicate parameters and unsolicited callbacks without consuming a valid pending attempt.
				if (["state", "code", "client_id", "error"].some((key) => params.getAll(key).length > 1) || params.get("state") !== expectedState) { res.writeHead(400).end("Sign-in could not be verified."); return; }
				consumed = true;
				res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Return to LearnHarness to view the sign-in result. You may close this tab.");
				cleanup();
				try {
					if (params.has("error")) throw fail(params.get("error") === "access_denied" ? "cancelled" : "identity");
					const clientId = params.get("client_id") || selected?.clientId;
					if (!clientId || clientId === "dynamic_agent_client" || clientId.length > 512 || /[\s\x00-\x1f]/.test(clientId) || (selected && clientId !== selected.clientId) || !params.get("code")) throw fail("identity");
					let body;
					try { body = await grant({ grant_type: "authorization_code", client_id: clientId, code: params.get("code"), code_verifier: verifier, redirect_uri: redirectUri }, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])); }
					catch (err) {
						if (err.oauthCode === "invalid_grant" && !selected?.subject) retryRegistration = { clientId };
						throw err;
					}
					if (typeof body.id_token !== "string") throw fail("identity");
					const verified = await identity(body.id_token, clientId, nonce, selected?.subject);
					const tokens = tokenSet(body);
					await serial(async () => {
						if (closed || abort.signal.aborted || epoch !== attemptEpoch) throw fail("cancelled");
						const existing = state.registrations.find((r) => r.clientId === clientId);
						if (existing && existing.subject !== verified.subject) throw fail("identity");
						const record = { id: existing?.id ?? crypto.randomUUID(), clientId, issuer: ISSUER, ...verified, tokens };
						const next = structuredClone(state);
						next.registrations = next.registrations.filter((r) => r.id !== record.id).concat(record);
						next.activeId = record.id;
						const previous = structuredClone(state);
						await save(next); // Active identity changes only AFTER validation and durable persistence.
						if (closed || abort.signal.aborted || epoch !== attemptEpoch) {
							await save(previous);
							throw fail("cancelled");
						}
						stop();
						storageDenied = false;
						suspended = false;
						retryRegistration = undefined;
					});
					lastError = planScopes(tokens) ? null : publicError(fail("scope"));
				} catch (err) { if (!abort.signal.aborted) lastError = publicError(err); }
				finally { if (pending?.abort === abort) pending = null; finish(); notify(); }
			});
			timer = setTimeout(() => cancel("timeout"), timeoutMs);
			const url = new URL(AUTHORIZE);
			url.search = new URLSearchParams({
				client_id: selected?.clientId ?? "dynamic_agent_client",
				...(selected ? {} : { agent_name_hint: "LearnHarness" }),
				ext_agent_host_id: state.hostId,
				...(selected?.tokens?.idToken ? { id_token_hint: selected.tokens.idToken } : {}),
				...(selected?.email ? { login_hint: selected.email } : {}),
				response_type: "code", redirect_uri: redirectUri, scope: SCOPES.join(" "), resource: RESOURCE,
				state: expectedState, nonce, code_challenge_method: "S256",
				code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
			}).toString();
			await openExternal(url.toString()); // Trusted main only. Never return this URL to the renderer.
		} catch (err) { cancel(err.code || "network"); }
		void completion;
		return snapshot();
	}
	function cancelLogin() { pending?.cancel(); return snapshot(); }

	function authorized(background, expected, capturedEpoch) {
		const account = active();
		if (!account || (capturedEpoch !== undefined && capturedEpoch !== epoch)) throw fail("disconnected");
		if (!planScopes(account.tokens)) throw fail("scope");
		if (expected && (expected.expectedAccountId !== account.id || expected.expectedAuthorityRevision !== authorityRevision || !catalog.some((m) => m.id === expected.selectedModelId))) throw fail("catalog");
		if (background && !backgroundAllowed()) throw fail("background");
		return account;
	}
	async function credential(background, expected) {
		await ready();
		return serial(async () => {
			const requestEpoch = epoch;
			const account = authorized(background, expected);
			if (account.tokens.expiresAt <= Date.now() + 60000) {
				const refreshEpoch = epoch;
				const signal = AbortSignal.any([transportAbort.signal, ...(background ? [backgroundAbort.signal] : []), AbortSignal.timeout(15000)]);
				let body;
				try { body = await grant({ grant_type: "refresh_token", client_id: account.clientId, refresh_token: account.tokens.refreshToken }, signal); }
				catch (err) {
					if (err.oauthCode === "invalid_grant") {
						const next = structuredClone(state);
						delete next.registrations.find((r) => r.id === account.id).tokens;
						next.activeId = null;
						await save(next);
						stop();
						notify();
					}
					throw err;
				}
				let tokens;
				try {
					if (body.id_token !== undefined) await identity(body.id_token, account.clientId, undefined, account.subject);
					tokens = tokenSet(body, account.tokens);
				} catch (err) {
					// The fixed token endpoint may have rotated already. Preserve only
					// verified identity and a single likely-latest revocation handle.
					stop();
					const restricted = structuredClone(state);
					const record = restricted.registrations.find((r) => r.id === account.id);
					record.reconnectRequired = true;
					if (nonempty(body.refresh_token)) record.tokens.refreshToken = body.refresh_token;
					await save(restricted);
					lastError = publicError(fail("identity")); notify();
					throw err;
				}
				// A successful remote rotation must be durably retained even when
				// logout, account selection, consent revocation, or pause denies use.
				// Those serialized operations will revoke/clear the LATEST token.
				const next = structuredClone(state);
				next.registrations.find((r) => r.id === account.id).tokens = tokens;
				await save(next);
				if (closed || refreshEpoch !== epoch || signal.aborted) throw fail("disconnected");
			}
			const current = authorized(background, expected, requestEpoch);
			return { accessToken: current.tokens.accessToken, accountId: current.id, ...stamp() };
		});
	}
	async function lease(background, expected) {
		if (typeof background !== "boolean" || !expected || !nonempty(expected.expectedAccountId) || !Number.isSafeInteger(expected.expectedAuthorityRevision) || !nonempty(expected.selectedModelId)) throw fail("catalog");
		return credential(background, expected);
	}
	const modelValue = () => ({ ...stamp(), status: snapshot(), accountId: active()?.id ?? null, models: catalog });
	async function models() {
		const sequence = ++catalogSequence;
		try {
			await ready();
			if (!active()) return modelValue();
			// Discovery is identity/scope authorization, not an invented model lease.
			const token = await credential(false);
			const discover = () => json(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.any([transportAbort.signal, AbortSignal.timeout(15000)]) });
			let body;
			try {
				body = await discover();
			} catch (err) {
				// Retry a transient outage once so it does not empty the catalog and
				// strand the selected model. Never retry entitlement, rate-limit, or
				// authority failures.
				if (!err.retryable) throw err;
				await new Promise((resolve) => setTimeout(resolve, 150));
				authorized(false, undefined, token.epoch);
				if (sequence !== catalogSequence || active()?.id !== token.accountId) throw fail("catalog");
				body = await discover();
			}
			authorized(false, undefined, token.epoch);
			if (sequence !== catalogSequence || active()?.id !== token.accountId || !Array.isArray(body.models)) throw fail("catalog");
			const visible = body.models.filter((m) => m && m.visibility === "list" && nonempty(m.slug) && typeof m.display_name === "string").map((m) => ({ id: m.slug, name: m.display_name }));
			const changed = JSON.stringify(visible) !== JSON.stringify(catalog);
			catalog = visible;
			if (changed) authorityRevision++;
			const hadError = catalogError !== null; catalogError = null;
			if (changed || hadError) notify();
			return modelValue();
		} catch {
			if (sequence === catalogSequence) {
				if (catalog.length) { catalog = []; authorityRevision++; }
				catalogError = publicError(fail("catalog")); notify();
			}
			return modelValue();
		}
	}
	async function select(id) {
		pending?.cancel();
		stop();
		const selectionIntent = epoch;
		await ready();
		return serial(async () => {
			const account = state.registrations.find((r) => r.id === id);
			if (!account?.tokens) throw fail("disconnected");
			await save({ ...state, activeId: id });
			if (epoch !== selectionIntent || closed || paused || storageDenied) throw fail("disconnected");
			suspended = false;
			lastError = null;
			notify();
			return snapshot();
		});
	}
	async function consent(enabled) {
		if (typeof enabled !== "boolean") throw fail("identity");
		// One app-owned intent, independent of account/registration lifetime.
		const intent = { enabled: false };
		backgroundIntent = intent; // ON cannot grant until its durable save.
		if (!enabled) stop(true); // Revoke all ChatGPT background streams only.
		await ready();
		return serial(async () => {
			await save({ ...structuredClone(state), allowBackgroundUse: enabled });
			if (backgroundIntent === intent && enabled) backgroundIntent = undefined;
			notify();
			return snapshot();
		});
	}
	async function revoke(account) {
		let revoked = false;
		try {
			if (account.tokens?.refreshToken) {
				const config = await json(`${ISSUER}/.well-known/openid-configuration`);
				if (config.issuer !== ISSUER || !allowedAuthEndpoint(config.revocation_endpoint)) throw fail("identity");
				for (let attempt = 0; attempt < 2; attempt++) {
					if (attempt) await new Promise((resolve) => setTimeout(resolve, 200));
					try {
						const response = await request(config.revocation_endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: account.tokens.refreshToken, token_type_hint: "refresh_token", client_id: account.clientId }) });
						revoked = response.status === 200;
						if (revoked || response.status < 500) break;
					} catch { /* retry only while the refresh token is still in memory */ }
				}
			}
		} catch { /* local action is mandatory even when revocation is unavailable */ }
		return revoked;
	}
	async function disconnect(id) {
		// Explicit local forgetting: a visible account represents every retained
		// registration with this exact verified issuer/subject, never its email.
		pending?.cancel();
		const initial = state?.registrations.find((r) => r.id === id);
		let stopped = !!initial && state.registrations.some((r) => r.id === state.activeId && sameAccount(r, initial));
		if (stopped) stop();
		await ready();
		return serial(async () => {
			const target = state.registrations.find((r) => r.id === id);
			if (!target) throw fail("identity");
			const members = state.registrations.filter((r) => sameAccount(r, target));
			const activeGroup = members.some((r) => r.id === state.activeId);
			if (activeGroup && !stopped) { stop(); stopped = true; }
			const disconnectEpoch = epoch;
			let revoked = true;
			for (const member of members) { const confirmed = await revoke(member); revoked = confirmed && revoked; }
			const next = structuredClone(state);
			next.registrations = next.registrations.filter((r) => !sameAccount(r, target));
			if (activeGroup) next.activeId = null; // Never silently select another account.
			await save(next);
			if (members.some((r) => r.clientId === retryRegistration?.clientId)) retryRegistration = undefined;
			if (stopped && !closed && epoch === disconnectEpoch) suspended = false;
			lastError = revoked ? null : REVOCATION_WARNING;
			notify();
			return snapshot();
		});
	}
	async function logout(id) {
		pending?.cancel();
		stop();
		await ready();
		return serial(async () => {
			const account = state.registrations.find((r) => r.id === id);
			if (!account) throw fail("identity");
			const revoked = await revoke(account);
			const next = structuredClone(state);
			delete next.registrations.find((r) => r.id === id).tokens;
			if (next.activeId === id) next.activeId = null;
			const logoutEpoch = epoch;
			await save(next);
			if (!closed && epoch === logoutEpoch) suspended = false;
			lastError = revoked ? null : REVOCATION_WARNING;
			notify();
			return snapshot();
		});
	}
	function close() { closed = true; pending?.cancel(); stop(); }
	function pause() { paused = true; pending?.cancel(); stop(); notify(); }
	function resume() { paused = false; if (!storageDenied) suspended = false; notify(); }
	return { status, login, cancelLogin, lease, models, select, consent, disconnect, logout, close, pause, resume, stamp };
}

module.exports = { createChatGPT, fileStore, publicError, allowedAuthEndpoint, SCOPES, validateState };
