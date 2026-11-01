import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * SERVER MODE (self-hosting): one LearnHarness server, many devices. Setting
 * LH_SERVER_PASSWORD turns it on — every page and API route then requires a
 * signed session cookie (minted by POST /api/auth/login) or, for non-browser
 * clients, `Authorization: Bearer <LH_API_TOKEN>`. Unset, nothing changes:
 * desktop and local dev keep their existing behavior.
 *
 * Sessions are stateless HMAC tokens (`v1.<expiresAtMs>.<sig>`), keyed by
 * LH_SESSION_SECRET, or by the password itself when no secret is set — so
 * changing the password signs every device out.
 */

export const SESSION_COOKIE = "lh_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type Env = Record<string, string | undefined>;

export function serverModeEnabled(env: Env = process.env): boolean {
	return !!env.LH_SERVER_PASSWORD;
}

function signingKey(env: Env): string {
	return env.LH_SESSION_SECRET || `lh-password:${env.LH_SERVER_PASSWORD ?? ""}`;
}

function sign(payload: string, env: Env): string {
	return createHmac("sha256", signingKey(env)).update(payload).digest("base64url");
}

/** Compares digests so neither length nor content leaks through timing. */
function sameSecret(supplied: string, expected: string): boolean {
	const a = createHash("sha256").update(supplied).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

export function passwordMatches(supplied: string, env: Env = process.env): boolean {
	const expected = env.LH_SERVER_PASSWORD;
	return !!expected && sameSecret(supplied, expected);
}

export function mintSessionToken(env: Env = process.env, now = Date.now()): string {
	const payload = `v1.${now + SESSION_TTL_MS}`;
	return `${payload}.${sign(payload, env)}`;
}

export function sessionTokenValid(token: string | undefined, env: Env = process.env, now = Date.now()): boolean {
	if (!token || !serverModeEnabled(env)) return false;
	const [version, expiry, signature, ...rest] = token.split(".");
	if (version !== "v1" || !expiry || !signature || rest.length) return false;
	const expiresAt = Number(expiry);
	if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
	return sameSecret(signature, sign(`${version}.${expiry}`, env));
}

function cookieValue(headers: Headers, name: string): string | undefined {
	for (const pair of (headers.get("cookie") ?? "").split(";")) {
		const eq = pair.indexOf("=");
		if (eq > 0 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
	}
	return undefined;
}

/** True when the request carries the configured API token (scripts, non-browser clients). */
export function bearerAuthorized(headers: Headers, env: Env = process.env): boolean {
	const bearer = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
	return !!bearer && !!env.LH_API_TOKEN && env.LH_API_TOKEN.length >= 32 && sameSecret(bearer, env.LH_API_TOKEN);
}

/** True when server mode is off, or the request carries a valid session or API token. */
export function remoteRequestAuthorized(headers: Headers, env: Env = process.env, now = Date.now()): boolean {
	if (!serverModeEnabled(env)) return true;
	if (sessionTokenValid(cookieValue(headers, SESSION_COOKIE), env, now)) return true;
	return bearerAuthorized(headers, env);
}

// ─── Apps only ────────────────────────────────────────────────────────────
// LH_APPS_ONLY=1 (with server mode on): only the LearnHarness desktop and
// iPhone apps may use the server — they append "LearnHarnessDesktop/<v>" or
// "LearnHarnessiOS/<v>" to every request's User-Agent. This keeps ordinary
// browsers out entirely; it is NOT a secret (a User-Agent can be faked), so
// the password stays the real protection. API-token clients are exempt.

const APP_USER_AGENT = /\bLearnHarness(Desktop|iOS)\/\d/;

export function appsOnlyEnabled(env: Env = process.env): boolean {
	return serverModeEnabled(env) && env.LH_APPS_ONLY === "1";
}

export function fromLearnHarnessApp(headers: Headers): boolean {
	return APP_USER_AGENT.test(headers.get("user-agent") ?? "");
}

/** True when the request may reach the server at all (sign-in still applies after). */
export function appsOnlyAllowed(headers: Headers, env: Env = process.env): boolean {
	return !appsOnlyEnabled(env) || fromLearnHarnessApp(headers) || bearerAuthorized(headers, env);
}

export function appsOnlyRefusal(api: boolean): Response {
	const message = "This LearnHarness server only works in the LearnHarness desktop and iPhone apps.";
	if (api) return Response.json({ error: message }, { status: 403, headers: { "Cache-Control": "no-store" } });
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LearnHarness</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#141414;color:#e5e5e5;font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:16px;text-align:center}</style>
</head><body><p>${message}</p></body></html>`;
	return new Response(html, { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/** Paths reachable without signing in (the login flow itself). */
export function isPublicPath(pathname: string): boolean {
	return pathname === "/login" || pathname.startsWith("/api/auth/");
}

/** Only same-origin relative redirects after login — never an open redirect. */
export function safeNextPath(next: string | null | undefined): string {
	return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

function secureCookies(headers: Headers, env: Env): boolean {
	if (env.LH_COOKIE_SECURE === "0") return false;
	if (env.LH_COOKIE_SECURE === "1") return true;
	return headers.get("x-forwarded-proto") === "https" || (headers.get("origin") ?? "").startsWith("https://");
}

export function sessionCookieHeader(token: string, headers: Headers, env: Env = process.env): string {
	const attrs = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
	if (secureCookies(headers, env)) attrs.push("Secure");
	return attrs.join("; ");
}

export function clearedSessionCookieHeader(): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ─── Login throttling ─────────────────────────────────────────────────────
// In-memory, per client address: 10 failures per 15 minutes, then refuse
// until the window passes. Single-process server, so a Map is the truth.

const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const failures = new Map<string, { count: number; since: number }>();

export function clientAddress(headers: Headers): string {
	return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "local";
}

export function loginThrottled(address: string, now = Date.now()): boolean {
	const entry = failures.get(address);
	if (!entry || now - entry.since > FAIL_WINDOW_MS) return false;
	return entry.count >= MAX_FAILS;
}

export function recordLoginFailure(address: string, now = Date.now()): void {
	const entry = failures.get(address);
	if (!entry || now - entry.since > FAIL_WINDOW_MS) failures.set(address, { count: 1, since: now });
	else entry.count++;
}

export function clearLoginFailures(address: string): void {
	failures.delete(address);
}

// ─── HTTP handlers (the routes stay thin wrappers) ────────────────────────

function redirect(location: string, extra: Record<string, string> = {}): Response {
	return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", ...extra } });
}

export async function loginResponse(request: Request): Promise<Response> {
	if (!serverModeEnabled()) return Response.json({ error: "Server mode is off (LH_SERVER_PASSWORD is not set)." }, { status: 404 });
	const address = clientAddress(request.headers);
	const form = await request.formData().catch(() => null);
	const next = safeNextPath(form?.get("next")?.toString());
	const back = (error: string) => `/login?error=${error}&next=${encodeURIComponent(next)}`;
	if (loginThrottled(address)) return redirect(back("throttled"));
	if (!passwordMatches(form?.get("password")?.toString() ?? "")) {
		recordLoginFailure(address);
		return redirect(back("invalid"));
	}
	clearLoginFailures(address);
	return redirect(next, { "Set-Cookie": sessionCookieHeader(mintSessionToken(), request.headers) });
}

export function logoutResponse(): Response {
	return redirect("/login", { "Set-Cookie": clearedSessionCookieHeader() });
}

const LOGIN_ERRORS: Record<string, string> = {
	invalid: "Wrong password.",
	throttled: "Too many attempts. Try again in 15 minutes.",
};

const escapeHtml = (s: string) =>
	s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A standalone page: the app shell would call APIs that 401 before sign-in. */
export function loginPageResponse(request: Request): Response {
	const url = new URL(request.url);
	if (serverModeEnabled() && remoteRequestAuthorized(request.headers)) return redirect(safeNextPath(url.searchParams.get("next")));
	const next = escapeHtml(safeNextPath(url.searchParams.get("next")));
	const error = LOGIN_ERRORS[url.searchParams.get("error") ?? ""];
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · LearnHarness</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#0b0b0c;color:#e8e8ea;font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:16px}
form{width:100%;max-width:340px;display:grid;gap:12px}
h1{font-size:18px;font-weight:600;margin:0 0 8px}
input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #2c2c31;background:#141417;color:inherit}
button{background:#e8e8ea;color:#0b0b0c;border-color:#e8e8ea;cursor:pointer;font-weight:600}
.err{color:#ff8a80;margin:0}
/* Desktop app window: its hidden title bar needs a drag strip (no-op in browsers). */
.drag{position:fixed;inset:0 0 auto 0;height:40px;-webkit-app-region:drag}
</style></head><body>
<div class="drag"></div>
<form method="post" action="/api/auth/login">
<h1>LearnHarness</h1>
${error ? `<p class="err">${error}</p>` : ""}
<input type="password" name="password" placeholder="Server password" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="${next}">
<button type="submit">Sign in</button>
</form></body></html>`;
	return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
