"use strict";

// Native Claude / Grok subscription controller. Main-process only.
// OAuth flows come from the pinned pi-ai SDK via the injected getOAuth(); this
// module never performs network requests, never exposes URLs, codes or tokens
// outside main, and only stores opaque local account ids (no verified identity).
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const PROVIDERS = ["subscription-anthropic", "subscription-xai"];
const CLAUDE_HOSTS = ["claude.ai", "platform.claude.com"];
const REVOCATION_WARNING = "Account disconnected locally. Remote revocation could not be confirmed.";
const LOGOUT_WARNING = "Signed out locally. Remote revocation could not be confirmed.";
const fail = (code) => Object.assign(new Error(code), { code });
const nonempty = (v) => typeof v === "string" && v.length > 0 && !/[\x00-\x20\x7f]/.test(v);

/** User-facing text only. Raw SDK/provider/OS errors are never forwarded. */
function publicError(err, label = "Subscription") {
	return ({
		cancelled: `${label} sign-in cancelled.`,
		timeout: `${label} sign-in timed out and the old sign-in was closed. Start sign-in again.`,
		storage: `${label} credentials could not be read or saved. Fix local file access, restart the app, then reconnect as needed.`,
		disconnected: `This ${label} connection is disconnected. Reconnect in Providers.`,
		background: `${label} background use is off in this app. Enable Allow background use in Providers, or explicitly select an API-key model for that workload.`,
		catalog: `The ${label} model catalog is unavailable. Retry the connection; no API-key fallback was used.`,
		expired: `The ${label} session could not be refreshed. Reconnect in Providers.`,
		pending: `A ${label} sign-in is already pending.`,
		unavailable: `${label} sign-in is unavailable.`,
		browser: `${label} sign-in could not open your browser. Try again.`,
		url: `${label} sign-in returned a link that was not trusted, so it was not opened.`,
		unsupported: `${label} sign-in requested an option this app does not support.`,
		account: `That ${label} account is no longer saved.`,
		request: `Invalid ${label} request.`,
	}[err?.code]) || `${label} sign-in failed. Try again; no API-key fallback was used.`;
}

const hasOnly = (o, keys) => !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k));
function validCredential(c) {
	return hasOnly(c, ["type", "access", "refresh", "expires"]) && c.type === "oauth" && nonempty(c.access) && nonempty(c.refresh) && Number.isFinite(c.expires) && c.expires >= 0;
}
/** Strict schema. Any deviation rejects the whole record (fail closed). */
function validateState(state, provider) {
	if (!PROVIDERS.includes(provider) || !hasOnly(state, ["version", "provider", "activeId", "allowBackgroundUse", "accounts"])) throw fail("storage");
	if (state.version !== 1 || state.provider !== provider || typeof state.allowBackgroundUse !== "boolean" || !Array.isArray(state.accounts)) throw fail("storage");
	if (!(state.activeId === null || nonempty(state.activeId))) throw fail("storage");
	const ids = new Set();
	for (const a of state.accounts) {
		if (!hasOnly(a, ["id", "label", "credential"]) || !nonempty(a.id) || ids.has(a.id) || typeof a.label !== "string" || !a.label.trim() || a.label.length > 100 || /[\x00-\x1f\x7f]/.test(a.label)) throw fail("storage");
		if (a.credential !== undefined && !validCredential(a.credential)) throw fail("storage");
		ids.add(a.id);
	}
	if (state.activeId !== null && !ids.has(state.activeId)) throw fail("storage");
	return state;
}

/** Private, unencrypted JSON (dir 0700, file 0600). No legacy migration, no OS credential store. */
function subscriptionFileStore(file, provider) {
	const posix = process.platform !== "win32";
	const uid = posix && typeof process.getuid === "function" ? process.getuid() : undefined;
	const own = (st) => uid === undefined || st.uid === uid;
	const dirOk = (ds) => !ds.isSymbolicLink() && ds.isDirectory() && own(ds) && !(posix && (ds.mode & 0o022) !== 0);
	return {
		async read() {
			let text;
			try {
				// Parent first: a symlinked, foreign-owned or group/other-writable directory is never trusted.
				const ds = await fs.lstat(path.dirname(file));
				if (!dirOk(ds)) throw fail("storage");
				const st = await fs.lstat(file);
				if (st.isSymbolicLink() || !st.isFile() || !own(st) || (posix && (st.mode & 0o077) !== 0)) throw fail("storage");
				text = await fs.readFile(file, "utf8");
			} catch (err) {
				if (err?.code === "ENOENT") return null;
				throw fail("storage");
			}
			try { return validateState(JSON.parse(text), provider); } catch { throw fail("storage"); }
		},
		async write(state) {
			validateState(state, provider);
			const dir = path.dirname(file);
			const temp = `${file}.${crypto.randomUUID()}.tmp`;
			let handle;
			try {
				await fs.mkdir(dir, { recursive: true, mode: 0o700 });
				const ds = await fs.lstat(dir);
				if (!dirOk(ds)) throw fail("storage");
				const existing = await fs.lstat(file).catch((e) => { if (e?.code === "ENOENT") return null; throw e; });
				if (existing && (existing.isSymbolicLink() || !existing.isFile() || !own(existing))) throw fail("storage");
				handle = await fs.open(temp, "wx", 0o600);
				if (posix) await handle.chmod(0o600);
				await handle.writeFile(`${JSON.stringify(state)}\n`);
				await handle.sync();
				await handle.close();
				handle = null;
				await fs.rename(temp, file);
				if (posix) {
					const d = await fs.open(dir, "r");
					try { await d.sync(); } finally { await d.close(); }
				}
			} catch { throw fail("storage"); }
			finally {
				await handle?.close().catch(() => {});
				await fs.unlink(temp).catch(() => {});
			}
		},
	};
}

function trustedUrl(value, provider) {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return false;
		if (provider === "subscription-anthropic") return CLAUDE_HOSTS.includes(url.hostname);
		const h = url.hostname.toLowerCase();
		return ["x.ai", "grok.com"].some((d) => h === d || h.endsWith(`.${d}`));
	} catch { return false; }
}

function createSubscription({ provider, label, store, getOAuth, getModels, openExternal, showDeviceCode = async () => {}, onChange = () => {}, timeoutMs = 180000 }) {
	if (!PROVIDERS.includes(provider)) throw new Error("Unsupported subscription provider");
	let state;
	let init;
	let queue = Promise.resolve();
	let epoch = 0;
	let revision = 0;
	let authorityRevision = 0;
	let catalogSequence = 0;
	let storageDenied = false;
	let backgroundIntent;
	let pending = null;
	let catalog = [];
	let catalogError = null;
	let lastError = null;
	let closed = false;
	let paused = false;
	let suspended = false;
	let transportAbort = new AbortController();
	let backgroundAbort = new AbortController();
	const stamp = () => ({ epoch, authorityRevision, revision });
	const err = (e) => publicError(e, label);
	const serial = (fn) => {
		const next = queue.then(fn, fn);
		queue = next.catch(() => {});
		return next;
	};
	const clone = (v) => structuredClone(v);
	const active = () => !storageDenied && !suspended && !closed && !paused ? state?.accounts.find((a) => a.id === state.activeId && a.credential) : undefined;
	const backgroundAllowed = () => state?.allowBackgroundUse !== false && backgroundIntent?.enabled !== false;
	const notify = (invalidate = "none") => {
		revision++;
		try { onChange({ channel: "lh:subscription", kind: "state", provider, stamp: stamp(), status: snapshot(), invalidate }); } catch { /* listeners never break state */ }
	};
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
		backgroundAbort.abort();
		transportAbort = new AbortController();
		backgroundAbort = new AbortController();
		catalog = [];
		catalogError = null;
		notify("all");
	}
	async function ready() {
		if (closed) throw fail("disconnected");
		if (!init) init = (async () => {
			const loaded = await store.read();
			if (loaded) state = validateState(loaded, provider);
			else {
				const first = { version: 1, provider, activeId: null, allowBackgroundUse: true, accounts: [] };
				await store.write(first);
				state = first;
			}
		})();
		try { await init; } catch (e) { denyStorage(e); throw fail("storage"); }
	}
	function denyStorage(e) {
		if (!storageDenied) { storageDenied = true; lastError = err(fail("storage")); stop(); }
	}
	async function save(next) {
		try { validateState(next, provider); await store.write(next); } catch (e) {
			denyStorage(e);
			lastError = err(fail("storage"));
			notify();
			throw fail("storage");
		}
		state = next;
	}
	function snapshot() {
		return {
			available: !!state && !closed && !paused && !storageDenied,
			pending: !!pending,
			allowBackgroundUse: backgroundAllowed(),
			activeId: state?.activeId ?? null,
			accounts: (state?.accounts ?? []).map((a) => ({ id: a.id, label: a.label, connected: !storageDenied && !closed && !paused && !!a.credential && (!suspended || a.id !== state.activeId) })),
			error: lastError,
			catalogError,
		};
	}
	async function status() {
		try { await ready(); } catch (e) { return { ...snapshot(), available: false, error: err(e) }; }
		return snapshot();
	}
	const nextLabel = (s) => {
		const n = s.accounts.reduce((max, a) => {
			const m = a.label.startsWith(`${label} account `) ? Number(a.label.slice(label.length + 9)) : 0;
			return Number.isSafeInteger(m) ? Math.max(max, m) : max;
		}, 0);
		return `${label} account ${n + 1}`;
	};

	// ---- login -----------------------------------------------------------------
	async function login(accountId, allowBackgroundUse) {
		await ready();
		if ((accountId !== undefined && typeof accountId !== "string") || (allowBackgroundUse !== undefined && typeof allowBackgroundUse !== "boolean")) throw fail("request");
		if (pending) throw fail("pending");
		if (paused) throw fail("disconnected");
		if (storageDenied) throw fail("storage");
		if (accountId !== undefined && !state.accounts.some((a) => a.id === accountId)) throw fail("account");
		const attemptEpoch = epoch;
		const abort = new AbortController();
		const tracked = [];
		let timer;
		const attempt = { abort, cancel: null };
		const live = () => pending === attempt && !abort.signal.aborted && !closed;
		const cancel = (code = "cancelled") => {
			if (pending !== attempt && abort.signal.aborted) return;
			abort.abort();
			clearTimeout(timer);
			if (pending === attempt) pending = null;
			lastError = err(fail(code));
			notify();
		};
		attempt.cancel = cancel;
		pending = attempt;
		lastError = null;
		notify();
		let oauth;
		try {
			oauth = await getOAuth();
			if (!oauth || typeof oauth.login !== "function") throw fail("unavailable");
		} catch (e) { cancel(e?.code === "unavailable" ? "unavailable" : "unavailable"); return snapshot(); }
		if (!live()) return snapshot();
		timer = setTimeout(() => cancel("timeout"), timeoutMs);
		timer.unref?.();
		const track = (promise) => { tracked.push(Promise.resolve(promise).then(() => null, () => fail("browser"))); };
		const interaction = {
			signal: abort.signal,
			prompt(p) {
				if (!live()) return Promise.reject(fail("cancelled"));
				if (p?.type === "select" && provider === "subscription-anthropic" && Array.isArray(p.options) && p.options.some((o) => o?.id === "browser")) return Promise.resolve("browser");
				if (p?.type === "manual_code") {
					// Never exposed or answered. Waits for the SDK to abort it once the loopback callback wins.
					return new Promise((_, reject) => {
						const done = () => reject(fail("cancelled"));
						for (const s of [p.signal, abort.signal]) {
							if (!s) continue;
							if (s.aborted) return done();
							s.addEventListener("abort", done, { once: true });
						}
					});
				}
				cancel("unsupported");
				return Promise.reject(fail("unsupported"));
			},
			notify(event) {
				if (!live() || !event || typeof event !== "object") return;
				if (event.type === "auth_url") {
					if (!trustedUrl(event.url, provider)) return cancel("url");
					track(Promise.resolve().then(() => openExternal(event.url)));
				} else if (event.type === "device_code") {
					if (provider !== "subscription-xai" || !trustedUrl(event.verificationUri, provider) || !nonempty(event.userCode) || event.userCode.length > 64) return cancel("url");
					const userCode = event.userCode;
					const opened = Promise.resolve().then(() => openExternal(event.verificationUri));
					track(opened);
					// The code dialog is informational: OAuth success never waits on its dismissal.
					opened.then(() => (live() ? showDeviceCode({ provider, label, userCode }) : undefined)).catch(() => {});
				}
				// info / progress are ignored; none of their text reaches status.
			},
		};
		void (async () => {
			try {
				const raw = await oauth.login(interaction);
				if (!live()) throw fail("cancelled");
				const results = await Promise.all(tracked);
				const bad = results.find(Boolean);
				if (bad) throw bad;
				if (!raw || raw.type !== "oauth" || !nonempty(raw.access) || !nonempty(raw.refresh) || !Number.isFinite(raw.expires) || raw.expires < 0) throw fail("expired");
				const credential = { type: "oauth", access: raw.access, refresh: raw.refresh, expires: raw.expires };
				await serial(async () => {
					if (!live() || epoch !== attemptEpoch) throw fail("cancelled");
					const next = clone(state);
					let rec;
					if (accountId !== undefined) {
						rec = next.accounts.find((a) => a.id === accountId);
						if (!rec) throw fail("account");
						rec.credential = credential;
					} else {
						rec = { id: crypto.randomUUID(), label: nextLabel(next), credential };
						next.accounts.push(rec);
					}
					next.activeId = rec.id;
					// Persisted in the same write as the credential, so the first status/lease already obeys the choice.
					if (allowBackgroundUse !== undefined) next.allowBackgroundUse = allowBackgroundUse;
					const previous = clone(state);
					await save(next);
					if (!live() || epoch !== attemptEpoch) {
						await save(previous); // late cancel during persistence: roll back
						throw fail("cancelled");
					}
					clearTimeout(timer);
					pending = null;
					stop();
					storageDenied = false;
					suspended = false;
				});
				lastError = null;
			} catch (e) {
				if (!abort.signal.aborted) { abort.abort(); lastError = err(e); }
			} finally {
				clearTimeout(timer);
				if (pending === attempt) pending = null;
				notify();
			}
		})();
		return snapshot();
	}
	function cancelLogin() { pending?.cancel(); return snapshot(); }

	// ---- leases ----------------------------------------------------------------
	function authorized(background, expected, capturedEpoch) {
		const account = active();
		if (!account || (capturedEpoch !== undefined && capturedEpoch !== epoch)) throw fail("disconnected");
		if (expected && (expected.expectedAccountId !== account.id || expected.expectedAuthorityRevision !== authorityRevision || !catalog.some((m) => m.id === expected.selectedModelId))) throw fail("catalog");
		if (background && !backgroundAllowed()) throw fail("background");
		return account;
	}
	/** Compare-and-swap persist: only into a still-existing account whose refresh handle is the one that was exchanged. */
	async function persistRotation(accountId, oldRefresh, fresh) {
		const target = state?.accounts.find((a) => a.id === accountId);
		if (!target?.credential || target.credential.refresh !== oldRefresh) return false;
		const next = clone(state);
		next.accounts.find((a) => a.id === accountId).credential = fresh;
		await save(next);
		return true;
	}
	function rotated(result, old) {
		if (!result || result.type !== "oauth" || !nonempty(result.access) || !Number.isFinite(result.expires) || result.expires <= Date.now()) throw fail("expired");
		// Providers may omit a refresh token; keep the old valid one. A present-but-invalid one is a failed rotation.
		const refresh = result.refresh === undefined || result.refresh === null || result.refresh === "" ? old.refresh : result.refresh;
		if (!nonempty(refresh)) throw fail("expired");
		return { type: "oauth", access: result.access, refresh, expires: result.expires };
	}
	async function credential(background, expected) {
		await ready();
		return serial(async () => {
			const requestEpoch = epoch;
			const account = authorized(background, expected);
			if (account.credential.expires <= Date.now() + 60000) {
				const old = clone(account.credential);
				const refreshEpoch = epoch;
				// Only account/transport changes and the timeout abort a refresh. Consent off must not: a rotation may already be consumed server-side.
				const signal = AbortSignal.any([transportAbort.signal, AbortSignal.timeout(15000)]);
				const failClosed = () => { if (!closed && refreshEpoch === epoch && !storageDenied) { lastError = err(fail("expired")); stop(); } };
				let oauth;
				let outcome;
				try { oauth = await getOAuth(); } catch { failClosed(); throw fail("expired"); }
				const call = Promise.resolve().then(() => oauth.refresh(clone(old), signal));
				const aborted = new Promise((_, reject) => {
					const done = () => reject(fail("disconnected"));
					if (signal.aborted) return done();
					signal.addEventListener("abort", done, { once: true });
				});
				try { outcome = await Promise.race([call, aborted]); }
				catch (e) {
					// If the SDK ignores abort and later rotates, still retain the newest refresh handle (CAS).
					call.then((late) => serial(() => persistRotation(account.id, old.refresh, rotated(late, old))).catch(() => {}), () => {});
					if (closed || refreshEpoch !== epoch) throw fail("disconnected"); // stopped by an account change
					failClosed(); // refresh failed on its own: suspend until the user reconnects
					throw fail("expired");
				}
				let fresh;
				try { fresh = rotated(outcome, old); }
				catch (e) {
					// Rotation may have consumed the old handle: stop all use and surface a reconnect prompt.
					stop();
					lastError = err(fail("expired")); notify();
					throw e;
				}
				await persistRotation(account.id, old.refresh, fresh); // durable before any lease
				if (closed || refreshEpoch !== epoch || signal.aborted) throw fail("disconnected");
			}
			const current = authorized(background, expected, requestEpoch);
			return { accessToken: current.credential.access, accountId: current.id, ...stamp() };
		});
	}
	async function lease(background, expected) {
		if (typeof background !== "boolean" || !expected || !nonempty(expected.expectedAccountId) || !Number.isSafeInteger(expected.expectedAuthorityRevision) || !nonempty(expected.selectedModelId)) throw fail("catalog");
		return credential(background, expected);
	}

	// ---- catalog ---------------------------------------------------------------
	const modelValue = () => ({ ...stamp(), status: snapshot(), accountId: active()?.id ?? null, models: catalog.map((m) => ({ id: m.id, name: m.name })) });
	async function models() {
		const sequence = ++catalogSequence;
		try {
			await ready();
			const account = active();
			if (!account) return modelValue();
			const list = await getModels();
			if (!Array.isArray(list)) throw fail("catalog");
			const visible = list.map((m) => {
				if (!m || !nonempty(m.id) || typeof m.name !== "string") throw fail("catalog");
				return { id: m.id, name: m.name };
			});
			if (sequence !== catalogSequence || active()?.id !== account.id) throw fail("catalog");
			const changed = JSON.stringify(visible) !== JSON.stringify(catalog);
			catalog = visible;
			if (changed) authorityRevision++;
			const hadError = catalogError !== null; catalogError = null;
			if (changed || hadError) notify();
			return modelValue();
		} catch {
			if (sequence === catalogSequence) {
				if (catalog.length) { catalog = []; authorityRevision++; }
				catalogError = err(fail("catalog")); notify();
			}
			return modelValue();
		}
	}

	// ---- account controls ------------------------------------------------------
	async function select(id) {
		if (typeof id !== "string") throw fail("request");
		pending?.cancel();
		stop();
		const intent = epoch;
		await ready();
		return serial(async () => {
			try {
				const account = state.accounts.find((a) => a.id === id);
				if (!account?.credential) throw fail("disconnected");
				await save({ ...clone(state), activeId: id });
				if (epoch !== intent || closed || paused || storageDenied) throw fail("disconnected");
				suspended = false;
				lastError = null;
				notify();
				return snapshot();
			} catch (e) {
				// A refused selection leaves the prior active account untouched: resume it (no auto-selection, no credential change).
				if (epoch === intent && !closed && !paused && !storageDenied && state?.accounts.some((a) => a.id === state.activeId && a.credential)) { suspended = false; notify(); }
				throw e;
			}
		});
	}
	async function consent(enabled) {
		if (typeof enabled !== "boolean") throw fail("request");
		const intent = { enabled: false };
		backgroundIntent = intent; // ON cannot grant until durably saved; OFF denies at once.
		if (!enabled) stop(true);
		await ready();
		return serial(async () => {
			try { await save({ ...clone(state), allowBackgroundUse: enabled }); }
			catch (e) { throw e; }
			if (backgroundIntent === intent && enabled) backgroundIntent = undefined;
			notify();
			return snapshot();
		});
	}
	async function disconnect(id) {
		if (typeof id !== "string") throw fail("request");
		pending?.cancel();
		let stopped = !!state && state.activeId === id && state.accounts.some((a) => a.id === id);
		if (stopped) stop();
		await ready();
		return serial(async () => {
			const target = state.accounts.find((a) => a.id === id);
			if (!target) { if (stopped && !closed) suspended = false; throw fail("account"); }
			const wasActive = state.activeId === id;
			if (wasActive && !stopped) { stop(); stopped = true; }
			const at = epoch;
			const next = clone(state);
			next.accounts = next.accounts.filter((a) => a.id !== id);
			if (wasActive) next.activeId = null; // never auto-select another account
			await save(next);
			if (stopped && !closed && epoch === at) suspended = false;
			lastError = REVOCATION_WARNING;
			notify();
			return snapshot();
		});
	}
	async function logout(id) {
		if (typeof id !== "string") throw fail("request");
		pending?.cancel();
		const wasActive = !!state && state.activeId === id;
		if (wasActive) stop();
		await ready();
		return serial(async () => {
			const target = state.accounts.find((a) => a.id === id);
			if (!target) { if (wasActive && !closed) suspended = false; throw fail("account"); }
			if (state.activeId === id && !wasActive) stop();
			const at = epoch;
			const next = clone(state);
			delete next.accounts.find((a) => a.id === id).credential;
			if (next.activeId === id) next.activeId = null;
			await save(next);
			if (!closed && epoch === at) suspended = false;
			lastError = LOGOUT_WARNING;
			notify();
			return snapshot();
		});
	}
	function close() { closed = true; pending?.cancel(); stop(); }
	function pause() { paused = true; pending?.cancel(); stop(); notify(); }
	function resume() { paused = false; if (!storageDenied) suspended = false; notify(); }
	return { provider, label, status, login, cancelLogin, select, disconnect, logout, consent, models, lease, pause, resume, close, stamp };
}

module.exports = { createSubscription, subscriptionFileStore, publicError, publicSubscriptionError: publicError, validateState, trustedUrl, PROVIDERS };
