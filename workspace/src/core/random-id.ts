/**
 * Random id material for code that runs in the browser.
 *
 * Built on crypto.getRandomValues, never crypto.randomUUID: browsers expose
 * randomUUID only in secure contexts, and the phone's direct link is plain
 * HTTP on a LAN/tailnet address, so randomUUID is undefined there and any
 * mint that uses it throws before a message can be sent. ESLint bans
 * crypto.randomUUID in browser-facing code (eslint.config.mjs).
 *
 * Browser-safe: pure logic, no node builtins.
 */

/** `bytes` random bytes as lowercase hex (2 characters per byte). */
export function randomHex(bytes = 16): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
