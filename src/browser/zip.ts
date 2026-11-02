/**
 * Minimal zip reader/writer for phone backups (mobile Phase 1). Writes
 * deflate (via CompressionStream) with a stored fallback; reads stored and
 * deflate entries — enough for our own backups and for a folder zipped by
 * macOS Finder, Windows Explorer or `zip`. No zip64, no encryption.
 */

export type ZipEntry = { path: string; data: Uint8Array };

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

export function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

async function transform(data: Uint8Array, stream: ReadableWritablePair<Uint8Array, Uint8Array> | CompressionStream | DecompressionStream): Promise<Uint8Array> {
	const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream as ReadableWritablePair<Uint8Array, Uint8Array>));
	return new Uint8Array(await out.arrayBuffer());
}

const canDeflate = () => typeof CompressionStream === "function";

export async function writeZip(entries: ZipEntry[]): Promise<Blob> {
	const enc = new TextEncoder();
	const parts: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	const now = new Date();
	const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
	const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

	for (const entry of entries) {
		const name = enc.encode(entry.path);
		const crc = crc32(entry.data);
		let method = 0;
		let body = entry.data;
		if (canDeflate() && entry.data.length > 64) {
			const deflated = await transform(entry.data, new CompressionStream("deflate-raw" as CompressionFormat));
			if (deflated.length < entry.data.length) {
				method = 8;
				body = deflated;
			}
		}
		const local = new Uint8Array(30 + name.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(6, 0x0800, true); // UTF-8 names
		lv.setUint16(8, method, true);
		lv.setUint16(10, dosTime, true);
		lv.setUint16(12, dosDate, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, body.length, true);
		lv.setUint32(22, entry.data.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);

		const cd = new Uint8Array(46 + name.length);
		const cv = new DataView(cd.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, method, true);
		cv.setUint16(12, dosTime, true);
		cv.setUint16(14, dosDate, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, body.length, true);
		cv.setUint32(24, entry.data.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		cd.set(name, 46);

		parts.push(local, body);
		central.push(cd);
		offset += local.length + body.length;
	}
	const cdSize = central.reduce((n, c) => n + c.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, offset, true);
	return new Blob([...parts, ...central, end] as BlobPart[], { type: "application/zip" });
}

export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let eocd = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd === -1) throw new Error("Not a zip file.");
	const count = view.getUint16(eocd + 10, true);
	let at = view.getUint32(eocd + 16, true);
	const utf8 = new TextDecoder();
	const latin1 = new TextDecoder("latin1");
	const out: ZipEntry[] = [];
	for (let i = 0; i < count; i++) {
		if (view.getUint32(at, true) !== 0x02014b50) throw new Error("Corrupt zip directory.");
		const flags = view.getUint16(at + 8, true);
		const method = view.getUint16(at + 10, true);
		const compressed = view.getUint32(at + 20, true);
		const nameLen = view.getUint16(at + 28, true);
		const extraLen = view.getUint16(at + 30, true);
		const commentLen = view.getUint16(at + 32, true);
		const localAt = view.getUint32(at + 42, true);
		const rawName = bytes.subarray(at + 46, at + 46 + nameLen);
		const path = (flags & 0x0800 ? utf8 : latin1).decode(rawName);
		at += 46 + nameLen + extraLen + commentLen;
		if (path.endsWith("/")) continue;
		if (flags & 0x1) throw new Error(`"${path}" is encrypted; zip the folder without a password.`);
		const start = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
		const body = bytes.subarray(start, start + compressed);
		let data: Uint8Array;
		if (method === 0) data = body.slice();
		else if (method === 8) data = await transform(body, new DecompressionStream("deflate-raw" as CompressionFormat));
		else throw new Error(`"${path}" uses an unsupported zip compression (method ${method}).`);
		out.push({ path, data });
	}
	return out;
}
