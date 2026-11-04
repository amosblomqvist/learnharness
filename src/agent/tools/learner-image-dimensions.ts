/** Header-only source geometry checks. Never allocate a decoded pixel buffer. */
export const MAX_LEARNER_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_LEARNER_IMAGE_PIXELS = 16_000_000;
export const MAX_LEARNER_IMAGE_SIDE = 8192;

function bounded(width: number, height: number): { width: number; height: number } {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("Invalid image dimensions");
	if (width > MAX_LEARNER_IMAGE_SIDE || height > MAX_LEARNER_IMAGE_SIDE || width * height > MAX_LEARNER_IMAGE_PIXELS) {
		throw new Error("Image exceeds 16 megapixels or 8192 pixels per side; provide a smaller image");
	}
	return { width, height };
}

export function checkImageDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } {
	const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	try {
		if (mime === "image/png") return bounded(b.readUInt32BE(16), b.readUInt32BE(20));
		if (mime === "image/bmp") {
			const dib = b.readUInt32LE(14);
			return dib === 12 ? bounded(b.readUInt16LE(18), b.readUInt16LE(20)) : bounded(b.readInt32LE(18), Math.abs(b.readInt32LE(22)));
		}
		if (mime === "image/jpeg") {
			let at = 2;
			while (at < b.length) {
				if (b[at++] !== 0xff) break;
				while (b[at] === 0xff) at++;
				const marker = b[at++]!;
				if (marker === 0xda || marker === 0xd9) break;
				const length = b.readUInt16BE(at);
				if (length < 2 || at + length > b.length) break;
				if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
					if (length < 8) break;
					return bounded(b.readUInt16BE(at + 5), b.readUInt16BE(at + 3));
				}
				at += length;
			}
		}
		if (mime === "image/gif") {
			const geometry = bounded(b.readUInt16LE(6), b.readUInt16LE(8));
			let at = 13 + ((b[10]! & 0x80) ? 3 * (1 << ((b[10]! & 7) + 1)) : 0);
			const skipBlocks = () => {
				while (at < b.length) { const n = b[at++]!; if (!n) return; at += n; }
				throw new Error("Incomplete GIF");
			};
			while (at < b.length) {
				const tag = b[at++];
				if (tag === 0x3b) return geometry;
				if (tag === 0x21) { at++; skipBlocks(); continue; }
				if (tag !== 0x2c) break;
				const frame = bounded(b.readUInt16LE(at + 4), b.readUInt16LE(at + 6));
				if (b.readUInt16LE(at) + frame.width > geometry.width || b.readUInt16LE(at + 2) + frame.height > geometry.height) break;
				const packed = b[at + 8]!;
				at += 9 + ((packed & 0x80) ? 3 * (1 << ((packed & 7) + 1)) : 0);
				at++; // LZW minimum code size
				skipBlocks();
			}
		}
		if (mime === "image/webp") {
			const end = b.readUInt32LE(4) + 8;
			if (end > b.length) throw new Error("Incomplete WebP");
			let geometry: { width: number; height: number } | undefined;
			const scan = (from: number, to: number, frame = false) => {
				for (let at = from; at + 8 <= to;) {
					const kind = b.toString("ascii", at, at + 4);
					const size = b.readUInt32LE(at + 4);
					const start = at + 8;
					if (start + size > to) throw new Error("Incomplete WebP chunk");
					if (kind === "VP8X" && size >= 10) geometry = bounded(1 + b.readUIntLE(start + 4, 3), 1 + b.readUIntLE(start + 7, 3));
					if (kind === "VP8 " && size >= 10) {
						const dimensions = bounded(b.readUInt16LE(start + 6) & 0x3fff, b.readUInt16LE(start + 8) & 0x3fff);
						geometry ??= dimensions;
					}
					if (kind === "VP8L" && size >= 5 && b[start] === 0x2f) {
						const bits = b.readUInt32LE(start + 1);
						const dimensions = bounded((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
						geometry ??= dimensions;
					}
					if (kind === "ANMF") {
						if (frame || size < 16) throw new Error("Invalid WebP animation frame");
						bounded(1 + b.readUIntLE(start + 6, 3), 1 + b.readUIntLE(start + 9, 3));
						scan(start + 16, start + size, true);
					}
					at = start + size + (size % 2);
				}
			};
			scan(12, end);
			if (geometry) return geometry;
		}
	} catch (error) {
		if (error instanceof RangeError) throw new Error("Incomplete image header");
		throw error;
	}
	throw new Error("Could not read valid image dimensions");
}
