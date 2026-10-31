/**
 * Password hashing for local accounts (mobile-web, 2026-10-29).
 *
 * scrypt from node:crypto — no new dependency, no network. Parameters follow
 * current OWASP guidance for scrypt (N=2^15, r=8, p=1). The stored string
 * carries its own parameters so a future bump verifies old hashes and
 * re-hashes on the next successful login without a migration step.
 *
 * Format: `scrypt$N$r$p$<salt base64url>$<hash base64url>`
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
	password: string | Buffer,
	salt: Buffer,
	keylen: number,
	options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
/** scrypt needs ~128·N·r bytes; give the allocator headroom. */
const MAXMEM = 128 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 10;

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const hash = await scryptAsync(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
	return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") return false;
	const nRaw = parts[1];
	const rRaw = parts[2];
	const pRaw = parts[3];
	const saltRaw = parts[4];
	const hashRaw = parts[5];
	if (nRaw === undefined || rRaw === undefined || pRaw === undefined || saltRaw === undefined || hashRaw === undefined) return false;
	const n = Number(nRaw);
	const r = Number(rRaw);
	const p = Number(pRaw);
	if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
	if (n < 2 ** 14 || n > 2 ** 20 || r < 1 || r > 16 || p < 1 || p > 4) return false;
	let salt: Buffer;
	let expected: Buffer;
	try {
		salt = Buffer.from(saltRaw, "base64url");
		expected = Buffer.from(hashRaw, "base64url");
	} catch {
		return false;
	}
	if (salt.length < 8 || expected.length < 16) return false;
	const actual = await scryptAsync(password.normalize("NFKC"), salt, expected.length, {
		N: n,
		r,
		p,
		maxmem: MAXMEM,
	});
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True when `stored` was produced with older parameters than the current ones. */
export function needsRehash(stored: string): boolean {
	const parts = stored.split("$");
	return parts.length !== 6 || parts[0] !== "scrypt" || parts[1] !== String(N) || parts[2] !== String(R) || parts[3] !== String(P);
}
