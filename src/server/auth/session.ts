/**
 * Session cookies (mobile-web, 2026-10-29).
 *
 * Stateless HS256 JWT in an httpOnly cookie, verified by `proxy.ts` on every
 * request and by `withUser()` in every API route. No server-side session
 * table: the account registry is the source of truth and `ver` (the account's
 * sessionVersion) revokes a user's cookies when a password is reset or the
 * account is disabled.
 *
 * The signing secret lives at config.SESSION_KEY_FILE (0600), generated on
 * first use. Rotating it (delete the file, restart) logs everyone out.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { SESSION_KEY_FILE } from "../../../config.ts";
import type { UserRole } from "../scope.ts";

export const SESSION_COOKIE = "lh_session";
const ISSUER = "learnharness";
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export type SessionClaims = {
	sub: string;
	email: string;
	role: UserRole;
	ver: number;
};

let cachedSecret: Uint8Array | null = null;

function secret(): Uint8Array {
	if (cachedSecret) return cachedSecret;
	try {
		const raw = fs.readFileSync(SESSION_KEY_FILE, "utf-8").trim();
		if (raw) {
			cachedSecret = new Uint8Array(Buffer.from(raw, "base64url"));
			return cachedSecret;
		}
	} catch {
		/* absent — create below */
	}
	const dir = path.dirname(SESSION_KEY_FILE);
	fs.mkdirSync(dir, { recursive: true });
	const bytes = randomBytes(32);
	const tmp = path.join(dir, `.session.key.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${bytes.toString("base64url")}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	try {
		fs.renameSync(tmp, SESSION_KEY_FILE);
	} catch {
		/* a racing process won — read theirs */
		fs.rmSync(tmp, { force: true });
		return secret();
	}
	cachedSecret = new Uint8Array(bytes);
	return cachedSecret;
}

export async function signSession(claims: SessionClaims): Promise<string> {
	return new SignJWT({ email: claims.email, role: claims.role, ver: claims.ver })
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setSubject(claims.sub)
		.setIssuer(ISSUER)
		.setIssuedAt()
		.setExpirationTime(`${MAX_AGE_SECONDS}s`)
		.sign(secret());
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
	try {
		const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, algorithms: ["HS256"] });
		if (typeof payload.sub !== "string") return null;
		if (payload.role !== "admin" && payload.role !== "user") return null;
		return {
			sub: payload.sub,
			email: typeof payload.email === "string" ? payload.email : "",
			role: payload.role,
			ver: typeof payload.ver === "number" ? payload.ver : 0,
		};
	} catch {
		return null;
	}
}

export function readCookie(header: string | null | undefined, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() !== name) continue;
		const raw = part.slice(eq + 1).trim();
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}
	return null;
}

export function sessionCookie(token: string, secure: boolean): string {
	return [
		`${SESSION_COOKIE}=${encodeURIComponent(token)}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${MAX_AGE_SECONDS}`,
		...(secure ? ["Secure"] : []),
	].join("; ");
}

export function clearSessionCookie(secure: boolean): string {
	return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", ...(secure ? ["Secure"] : [])].join("; ");
}

/**
 * `Secure` only when the request really is https: the supported transport is
 * an `ssh -L` forward to http://localhost, where a Secure cookie would be
 * silently dropped by the browser.
 */
export function isSecureRequest(request?: Request): boolean {
	if (!request) return false;
	try {
		const url = new URL(request.url);
		if (url.protocol === "https:") return true;
		const forwarded = (request.headers.get("x-forwarded-proto") ?? "").split(",")[0] ?? "";
		return forwarded.trim() === "https";
	} catch {
		return false;
	}
}
