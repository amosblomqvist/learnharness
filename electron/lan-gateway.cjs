"use strict";
/**
 * LAN gateway: an HTTP reverse proxy in front of the loopback Next server.
 * Node builtins only; it must NOT require("electron") so it stays testable under tsx.
 *
 * API (used by electron/main.cjs):
 *   const gw = createLanGateway({
 *     targetPort,                 // loopback Next port (dev: the LH_DEV_URL port)
 *     targetHost = "127.0.0.1",
 *     getSecret,                  // optional () => string; injected as x-learnharness-desktop (omit in dev)
 *     getAuth,                    // () => { passwordHash, sessionKey } | null; null = no password.
 *                                 // Called per request, so password/key changes apply with no restart
 *                                 // (lan-config's cfg.getAuth fits as-is).
 *     verifyPassword,             // optional (password, hash) => boolean; defaults to lan-config's
 *     now = Date.now,             // injectable clock (cookie age, lockout)
 *   });
 *   await gw.listen(port, host = "0.0.0.0");  // rejects with the bind error (e.g. EADDRINUSE)
 *   gw.port;                                  // bound port (useful with listen(0)), null when closed
 *   await gw.close();                         // drops open connections (SSE) too
 *
 * Per request, in order: Host allow-list (403) -> CSRF Origin/Sec-Fetch-Site on unsafe methods (403)
 * -> /__lan/login (only when a password exists) -> session cookie check (303 to login for page
 * navigations, 401 JSON otherwise) -> proxy. The client's x-learnharness-desktop header and the
 * gateway's own session cookie never reach the upstream. WebSocket upgrades are not supported.
 */
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const { verifyPassword: defaultVerify } = require("./lan-config.cjs");

const COOKIE = "lh_lan_session";
const LOGIN_PATH = "/__lan/login";
const SECRET_HEADER = "x-learnharness-desktop";
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 60_000;
const MAX_LOGIN_BODY = 4096;
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Same-origin path only: leading "/" but not "//" or "/\" (both are protocol-relative in browsers).
function safeNext(v) {
	return typeof v === "string" && v.startsWith("/") && !v.startsWith("//") && !/[\\\x00-\x1f\x7f]/.test(v) ? v : "/";
}

function loginPage(next, error) {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LearnHarness</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:16px;font:16px/1.4 system-ui,sans-serif;background:Canvas;color:CanvasText}
form{width:100%;max-width:340px;display:grid;gap:12px}
h1{margin:0 0 4px;font-size:20px}
input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid color-mix(in srgb,CanvasText 30%,transparent);width:100%}
button{background:CanvasText;color:Canvas;border:0;cursor:pointer}
.err{color:#c0392b;margin:0}
</style></head><body>
<form method="post" action="${LOGIN_PATH}">
<h1>LearnHarness</h1>
${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ""}
<input type="hidden" name="next" value="${escapeHtml(next)}">
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button>
</form></body></html>`;
}

function parseHost(header) {
	const m = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/i.exec(String(header ?? "").trim());
	if (!m) return null;
	return { name: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : null };
}

function createLanGateway({ targetPort, targetHost = "127.0.0.1", getSecret, getAuth, verifyPassword = defaultVerify, now = Date.now }) {
	const hostname = os.hostname().toLowerCase();
	const allowedNames = new Set(["localhost", hostname, `${hostname}.local`]);
	const failures = new Map(); // ip -> { fails, until }; ponytail: never pruned, bounded by distinct LAN IPs
	let server;

	const sign = (key, issued) => crypto.createHmac("sha256", key).update(String(issued)).digest("base64url");

	function sessionCookie(key) {
		const issued = now();
		return `${COOKIE}=${issued}.${sign(key, issued)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`;
	}

	function authenticated(req, key) {
		const raw = String(req.headers.cookie ?? "")
			.split(";")
			.map((c) => c.trim())
			.find((c) => c.startsWith(`${COOKIE}=`));
		const [issuedStr, sig] = (raw ? raw.slice(COOKIE.length + 1) : "").split(".");
		if (!/^\d{1,16}$/.test(issuedStr ?? "") || !sig) return false;
		const age = now() - Number(issuedStr);
		if (age < 0 || age >= SESSION_MS) return false;
		const a = Buffer.from(sig);
		const b = Buffer.from(sign(key, issuedStr));
		return a.length === b.length && crypto.timingSafeEqual(a, b);
	}

	function hostAllowed(req) {
		const h = parseHost(req.headers.host);
		if (!h) return false;
		if (h.port !== null && h.port !== server.address()?.port) return false;
		if (h.name.startsWith("[")) return net.isIPv6(h.name.slice(1, -1));
		return net.isIPv4(h.name) || allowedNames.has(h.name);
	}

	function csrfOk(req) {
		if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
		const { origin } = req.headers;
		const site = req.headers["sec-fetch-site"];
		if (origin !== undefined && origin.toLowerCase() !== `http://${req.headers.host}`.toLowerCase()) return false;
		return site === undefined || site === "same-origin" || site === "none";
	}

	function send(res, status, body, headers = {}) {
		res.writeHead(status, { "cache-control": "no-store", ...headers });
		res.end(body);
	}

	const html = (res, status, next, error) => send(res, status, loginPage(next, error), { "content-type": "text/html; charset=utf-8" });

	function handleLogin(req, res, auth, url) {
		if (req.method === "GET") return html(res, 200, safeNext(url.searchParams.get("next")));
		if (req.method !== "POST") return send(res, 405, "", { allow: "GET, POST" });
		const ip = req.socket.remoteAddress ?? "";
		const entry = failures.get(ip) ?? { fails: 0, until: 0 };
		if (entry.until > now()) return html(res, 429, "/", "Too many attempts. Try again in a minute.");
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > MAX_LOGIN_BODY) {
				if (!res.headersSent) send(res, 413, "", { connection: "close" });
				req.resume();
			} else chunks.push(c);
		});
		req.on("end", () => {
			if (res.headersSent) return;
			const body = new URLSearchParams(Buffer.concat(chunks).toString());
			const next = safeNext(body.get("next"));
			if (verifyPassword(body.get("password") ?? "", auth.passwordHash)) {
				failures.delete(ip);
				return send(res, 303, "", { location: next, "set-cookie": sessionCookie(auth.sessionKey) });
			}
			entry.fails += 1;
			if (entry.fails >= MAX_FAILS) Object.assign(entry, { fails: 0, until: now() + LOCK_MS });
			failures.set(ip, entry);
			html(res, 401, next, "Incorrect password.");
		});
	}

	function proxy(req, res) {
		const headers = { ...req.headers };
		const listed = String(headers.connection ?? "").split(",").map((t) => t.trim().toLowerCase());
		for (const h of [...HOP_BY_HOP, ...listed, SECRET_HEADER]) delete headers[h];
		const secret = getSecret?.();
		if (secret) headers[SECRET_HEADER] = secret;
		if (req.headers["transfer-encoding"] && !req.headers["content-length"]) headers["transfer-encoding"] = "chunked";
		if (headers.cookie) {
			const kept = headers.cookie.split(";").map((c) => c.trim()).filter((c) => c && !c.startsWith(`${COOKIE}=`));
			if (kept.length) headers.cookie = kept.join("; ");
			else delete headers.cookie;
		}
		const up = http.request({ host: targetHost, port: targetPort, method: req.method, path: req.url, headers, agent: false }, (upRes) => {
			const out = { ...upRes.headers };
			for (const h of [...HOP_BY_HOP, ...String(out.connection ?? "").split(",").map((t) => t.trim().toLowerCase())]) delete out[h];
			res.writeHead(upRes.statusCode, upRes.statusMessage, out);
			res.flushHeaders();
			upRes.on("error", () => res.destroy());
			upRes.on("close", () => {
				if (!upRes.complete) res.destroy();
			});
			upRes.pipe(res);
		});
		up.on("error", () => {
			if (res.destroyed) return;
			if (res.headersSent) res.destroy();
			else send(res, 502, "Bad gateway", { "content-type": "text/plain" });
		});
		res.on("close", () => {
			if (!res.writableFinished) up.destroy();
		});
		req.pipe(up);
	}

	function handle(req, res) {
		if (!hostAllowed(req)) return send(res, 421, "Misdirected request");
		if (!csrfOk(req)) return send(res, 403, "Forbidden");
		const url = new URL(req.url, "http://gateway");
		const auth = getAuth();
		if (auth) {
			if (url.pathname === LOGIN_PATH) return handleLogin(req, res, auth, url);
			if (!authenticated(req, auth.sessionKey)) {
				if (req.method === "GET" && String(req.headers.accept ?? "").includes("text/html")) {
					return send(res, 303, "", { location: `${LOGIN_PATH}?next=${encodeURIComponent(req.url)}` });
				}
				return send(res, 401, JSON.stringify({ error: "unauthorized" }), { "content-type": "application/json" });
			}
		}
		proxy(req, res);
	}

	server = http.createServer(handle);

	return {
		get port() {
			return server.address()?.port ?? null;
		},
		listen: (port, host = "0.0.0.0") =>
			new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					server.off("error", reject);
					resolve();
				});
			}),
		close: () =>
			new Promise((resolve) => {
				failures.clear();
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}

module.exports = { createLanGateway };
