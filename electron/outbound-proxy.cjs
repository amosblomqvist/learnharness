"use strict";

/**
 * Node's fetch ignores HTTP_PROXY / HTTPS_PROXY unless the process was
 * started with NODE_USE_ENV_PROXY=1. That is too late for the Electron
 * main process, so Grok device-code login, ChatGPT token exchange, and
 * Copilot sign-in would otherwise dial the provider directly and fail on
 * a proxy-only network. Chromium's session.fetch already follows the OS
 * proxy. The server child is a new Node process, so the startup flag
 * works there.
 */

function proxyFromEnv(env) {
	return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || "";
}

/** Extra env for a fresh Node process. Does not override an explicit 0 or 1. */
function serverProxyEnv(env) {
	if (!proxyFromEnv(env)) return {};
	if (env.NODE_USE_ENV_PROXY === "0" || env.NODE_USE_ENV_PROXY === "1") return {};
	return { NODE_USE_ENV_PROXY: "1" };
}

/** First HTTP proxy in a Chromium resolveProxy result. SOCKS is left out. */
function proxyUrlFromResolution(resolved) {
	if (typeof resolved !== "string") return "";
	const match = resolved.match(/(?:^|[;\s])(?:PROXY|HTTPS)\s+([^\s;]+)/i);
	if (!match) return "";
	return match[1].includes("://") ? match[1] : `http://${match[1]}`;
}

function loopback(input) {
	const raw = typeof input === "string" ? input
		: input instanceof URL ? input.href
		: input && typeof input.url === "string" ? input.url
		: "";
	if (!raw) return true;
	try {
		const host = new URL(raw).hostname.replace(/^\[|\]$/g, "").toLowerCase();
		return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
	} catch {
		return true;
	}
}

function bypassRules(env) {
	const extra = String(env.NO_PROXY || env.no_proxy || "")
		.split(/[,;]/)
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => (part.startsWith(".") ? `*${part}` : part));
	return ["<local>", ...extra].join(";");
}

/** When the OS has a proxy and the environment does not, hand that URL to the child. */
function childEnvForSystemProxy(env, resolved) {
	if (proxyFromEnv(env) || env.NODE_USE_ENV_PROXY === "0") return {};
	const proxy = proxyUrlFromResolution(resolved);
	if (!proxy) return {};
	const out = { HTTP_PROXY: proxy, HTTPS_PROXY: proxy };
	if (env.NODE_USE_ENV_PROXY !== "1") out.NODE_USE_ENV_PROXY = "1";
	if (!env.NO_PROXY && !env.no_proxy) out.NO_PROXY = "localhost,127.0.0.1,::1";
	return out;
}

/**
 * Route the main process's non-loopback fetch through Chromium so it uses
 * the OS proxy. If Chromium is direct but HTTP(S)_PROXY is set, point the
 * session at that proxy first (loopback stays bypassed). Returns env to
 * merge into the server child when the proxy exists only in the OS.
 */
async function prepareOutboundProxy(session, env = process.env) {
	let resolved = "";
	try {
		resolved = await session.resolveProxy("https://auth.x.ai/");
	} catch {
		resolved = "";
	}
	const systemProxy = proxyUrlFromResolution(resolved);
	const envProxy = proxyFromEnv(env);
	if (envProxy && !systemProxy && typeof session.setProxy === "function") {
		try {
			await session.setProxy({ proxyRules: envProxy, proxyBypassRules: bypassRules(env) });
		} catch {
			/* Sign-in still uses the session stack below. */
		}
	}
	if ((envProxy || systemProxy) && !globalThis.__lhDesktopProxyFetch) {
		const base = globalThis.fetch.bind(globalThis);
		const viaSession = session.fetch.bind(session);
		globalThis.fetch = (input, init) => {
			if (loopback(input)) return base(input, init);
			return viaSession(input, init == null ? { credentials: "omit" } : { ...init, credentials: "omit" });
		};
		globalThis.__lhDesktopProxyFetch = true;
	}
	return childEnvForSystemProxy(env, resolved);
}

module.exports = {
	proxyFromEnv,
	serverProxyEnv,
	proxyUrlFromResolution,
	childEnvForSystemProxy,
	prepareOutboundProxy,
};
