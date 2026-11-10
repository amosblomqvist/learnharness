/** Test-side reader/writer for auth.enc.json, written from the documented format
 * (AES-256-GCM, fresh 12-byte IV, entry name as AAD) rather than the store's own
 * code, so fixtures that seed or inspect the file pin that format too. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";

/** A fixed throwaway master key for suites that share a store across processes. */
export const TEST_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");

export function writeEncAuth(file: string, map: Record<string, unknown>, masterKey = TEST_MASTER_KEY): void {
	const key = Buffer.from(masterKey, "base64");
	const entries: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(map)) {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		cipher.setAAD(Buffer.from(name));
		const text = typeof value === "string" ? value : JSON.stringify(value);
		const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
		entries[name] = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64"), ...(typeof value === "string" ? {} : { json: true }) };
	}
	fs.writeFileSync(file, JSON.stringify({ version: 1, alg: "aes-256-gcm", entries }), { mode: 0o600 });
}

export function readEncAuth(file: string, masterKey = TEST_MASTER_KEY): Record<string, any> {
	const key = Buffer.from(masterKey, "base64");
	const { entries } = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: Record<string, { iv: string; tag: string; ct: string; json?: true }> };
	const map: Record<string, unknown> = {};
	for (const [name, entry] of Object.entries(entries)) {
		const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"));
		decipher.setAAD(Buffer.from(name));
		decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
		const text = Buffer.concat([decipher.update(Buffer.from(entry.ct, "base64")), decipher.final()]).toString("utf8");
		map[name] = entry.json ? JSON.parse(text) : text;
	}
	return map;
}
