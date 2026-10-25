/**
 * Request guard for /api/connections/*. These routes carry login flows and
 * credential state, so they are loopback-only and cross-site-proof:
 *
 *  - Host must be a loopback name (localhost, 127.0.0.0/8, ::1), which also
 *    blocks DNS-rebinding hostnames. A forwarded host must match.
 *  - Mutations additionally need `X-LearnHarness-Connections: 1` (forces a
 *    CORS preflight that we never grant), an Origin that exactly equals the
 *    Host, and Sec-Fetch-Site same-origin when the browser sends it.
 *  - Reads reject a cross-site Origin / Sec-Fetch-Site; header-less clients
 *    (curl, the desktop shell) still work on loopback.
 */

export const CONNECTIONS_HEADER = "x-learnharness-connections";

export class ConnectionError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "ConnectionError";
		this.status = status;
	}
}

export function noStoreJson(body: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("Cache-Control", "no-store");
	headers.set("X-Content-Type-Options", "nosniff");
	return Response.json(body, { ...init, headers });
}

export function connectionErrorResponse(err: unknown): Response {
	if (err instanceof ConnectionError) return noStoreJson({ error: err.message }, { status: err.status });
	return noStoreJson({ error: "Request failed." }, { status: 500 });
}

/** Lowercased hostname without port/brackets/trailing dot, or undefined. */
export function hostnameOf(host: string): string | undefined {
	try {
		const h = new URL(`http://${host}`).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
		return h || undefined;
	} catch {
		return undefined;
	}
}

export function isLoopbackHostname(name: string | undefined): boolean {
	if (!name) return false;
	if (name === "localhost" || name === "::1") return true;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

function forbidden(): Response {
	return noStoreJson({ error: "Forbidden." }, { status: 403 });
}

/** The authority the client addressed. Next may normalize request.url to
 *  localhost, so the Host header is authoritative when present. */
function requestHost(request: Request): string | undefined {
	const h = request.headers.get("host");
	if (h) return h.toLowerCase();
	try {
		return new URL(request.url).host.toLowerCase();
	} catch {
		return undefined;
	}
}

/** Scheme + authority of an Origin header. */
function parseOrigin(origin: string): { protocol: string; host: string } | undefined {
	try {
		const u = new URL(origin);
		if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
		return { protocol: u.protocol, host: u.host.toLowerCase() };
	} catch {
		return undefined;
	}
}

function requestProtocol(request: Request): string | undefined {
	try {
		return new URL(request.url).protocol;
	} catch {
		return undefined;
	}
}

/** Origin must equal the addressed Host AND the request scheme. Next may
 *  normalize only the host part of request.url (to localhost); the scheme is
 *  taken from it unchanged. */
function sameOrigin(origin: string, host: string, request: Request): boolean {
	const o = parseOrigin(origin);
	return !!o && o.host === host && o.protocol === requestProtocol(request);
}

/** Same loopback identity: `localhost:3000` and `127.0.0.1:3000` are different origins. */
export function connectionGuard(request: Request, mutation = true): Response | null {
	const host = requestHost(request);
	if (!host || !isLoopbackHostname(hostnameOf(host))) return forbidden();

	const forwarded = request.headers.get("x-forwarded-host");
	if (forwarded && forwarded.toLowerCase() !== host) return forbidden();

	const origin = request.headers.get("origin");
	const fetchSite = request.headers.get("sec-fetch-site");

	if (mutation) {
		if (request.headers.get(CONNECTIONS_HEADER) !== "1") return forbidden();
		if (!origin || origin === "null") return forbidden();
		if (!sameOrigin(origin, host, request)) return forbidden();
		if (fetchSite && fetchSite !== "same-origin") return forbidden();
		return null;
	}

	if (origin && origin !== "null" && !sameOrigin(origin, host, request)) return forbidden();
	if (origin === "null") return forbidden();
	if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return forbidden();
	return null;
}

/** Read a small JSON object body. Throws ConnectionError 400/413/415. */
export async function readJsonBody(request: Request, maxBytes = 32 * 1024): Promise<Record<string, unknown>> {
	const type = request.headers.get("content-type") ?? "";
	if (!/^application\/json\b/i.test(type)) throw new ConnectionError(415, "Body must be JSON.");
	const len = Number(request.headers.get("content-length") ?? 0);
	if (Number.isFinite(len) && len > maxBytes) throw new ConnectionError(413, "Body is too large.");
	// Bounded streaming read: never buffer more than maxBytes, whatever the headers claim.
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = request.body?.getReader();
	if (reader) {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				void reader.cancel().catch(() => {});
				throw new ConnectionError(413, "Body is too large.");
			}
			chunks.push(value);
		}
	}
	const text = new TextDecoder().decode(Buffer.concat(chunks));
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new ConnectionError(400, "Body must be JSON.");
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new ConnectionError(400, "Body must be a JSON object.");
	}
	return body as Record<string, unknown>;
}
