/**
 * Minimal `Buffer` for the phone build (mobile Phase 0). Covers only what
 * the bundled server code uses: from / alloc / byteLength / concat / isBuffer
 * and toString with utf-8, hex, base64 and base64url.
 */

type Encoding = "utf8" | "utf-8" | "hex" | "base64" | "base64url" | "latin1" | "binary";

function toBase64(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}

function fromBase64(text: string): Uint8Array {
	const clean = text.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "");
	const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Typed as a plain constructor so Buffer's own static `from` (with an
 *  encoding argument, like Node's) need not match Uint8Array.from. */
const Bytes = Uint8Array as unknown as new (...args: [number] | [ArrayBuffer, number?, number?]) => Uint8Array;

export class Buffer extends Bytes {
	static from(value: string | ArrayLike<number> | ArrayBuffer, encoding: Encoding = "utf8"): Buffer {
		if (typeof value === "string") {
			switch (encoding) {
				case "hex": {
					const out = new Buffer(value.length >> 1);
					for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
					return out;
				}
				case "base64":
				case "base64url":
					return Buffer.wrap(fromBase64(value));
				case "latin1":
				case "binary": {
					const out = new Buffer(value.length);
					for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
					return out;
				}
				default:
					return Buffer.wrap(new TextEncoder().encode(value));
			}
		}
		if (value instanceof ArrayBuffer) return Buffer.wrap(new Uint8Array(value));
		return Buffer.wrap(Uint8Array.from(value as ArrayLike<number>));
	}

	static wrap(bytes: Uint8Array): Buffer {
		return new Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
	}

	static alloc(size: number): Buffer {
		return new Buffer(size);
	}

	static byteLength(value: string | Uint8Array, _encoding?: Encoding): number {
		return typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength;
	}

	static isBuffer(value: unknown): value is Buffer {
		return value instanceof Buffer;
	}

	static concat(list: Uint8Array[]): Buffer {
		const out = new Buffer(list.reduce((n, b) => n + b.byteLength, 0));
		let at = 0;
		for (const b of list) {
			out.set(b, at);
			at += b.byteLength;
		}
		return out;
	}

	override toString(encoding: Encoding = "utf8"): string {
		switch (encoding) {
			case "hex":
				return Array.from(this, (b) => b.toString(16).padStart(2, "0")).join("");
			case "base64":
				return toBase64(this);
			case "base64url":
				return toBase64(this).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
			case "latin1":
			case "binary":
				return Array.from(this, (b) => String.fromCharCode(b)).join("");
			default:
				return new TextDecoder().decode(this);
		}
	}

	equals(other: Uint8Array): boolean {
		return this.length === other.length && this.every((b, i) => b === other[i]);
	}
}
