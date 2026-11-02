/**
 * `node:crypto` for the phone build: randomUUID, randomBytes, and the
 * synchronous sha256 createHash/createHmac the graph code uses (Web Crypto's
 * digest is async, so hashing goes through ./sha256.ts).
 */
import { Buffer } from "./buffer.ts";
import { hmacSha256, sha256 } from "./sha256.ts";

export function randomUUID(): string {
	return globalThis.crypto.randomUUID();
}

export function randomBytes(size: number): Buffer {
	const out = Buffer.alloc(size);
	globalThis.crypto.getRandomValues(out);
	return out;
}

type Digestible = { update(data: string | Uint8Array): Digestible; digest(encoding?: string): string | Buffer };

function digester(alg: string, run: (data: Uint8Array) => Uint8Array): Digestible {
	if (alg !== "sha256") throw new Error(`crypto: only sha256 is available in the phone build (asked for ${alg})`);
	const chunks: Uint8Array[] = [];
	const api: Digestible = {
		update(data) {
			chunks.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
			return api;
		},
		digest(encoding) {
			const out = Buffer.wrap(run(Buffer.concat(chunks)));
			return encoding ? out.toString(encoding as "hex") : out;
		},
	};
	return api;
}

export function createHash(alg: string): Digestible {
	return digester(alg, (data) => sha256(data));
}

export function createHmac(alg: string, key: string | Uint8Array): Digestible {
	const k = typeof key === "string" ? new TextEncoder().encode(key) : key;
	return digester(alg, (data) => hmacSha256(k, data));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) throw new RangeError("Input buffers must have the same byte length");
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

export const webcrypto = globalThis.crypto;

export default { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual, webcrypto };
