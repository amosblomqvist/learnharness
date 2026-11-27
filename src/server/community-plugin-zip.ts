import { crc32, inflateRawSync } from "node:zlib";
import { COMMUNITY_ZIP_LIMIT } from "../core/community-catalog.ts";

const FILE_LIMIT = 16 * 1024 * 1024;
const EXPANDED_LIMIT = 48 * 1024 * 1024;
const MAX_ENTRIES = 768;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const reserved = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const bad = (why: string): never => { throw new Error(`Invalid plugin ZIP: ${why}`); };

/** Strict single-volume, non-ZIP64 stored/deflated ZIP subset. Central records
 * bind each local record before data is read. No platform/archive extraction. */
export function readCommunityPluginZip(zip: Buffer, id: string): Map<string, Buffer> {
	const u16 = (at: number) => zip.readUInt16LE(at);
	const u32 = (at: number) => zip.readUInt32LE(at);
	if (zip.length < 22 || zip.length > COMMUNITY_ZIP_LIMIT) bad("archive size");
	let end = zip.length - 22;
	for (; end >= Math.max(0, zip.length - 65557); end--) {
		if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === zip.length) break;
	}
	if (end < Math.max(0, zip.length - 65557)) bad("missing directory");
	const total = u16(end + 10), start = u32(end + 16);
	if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== total || !total || total > MAX_ENTRIES || start + u32(end + 12) !== end) bad("unsupported directory");
	const entries: { name: string; dir: boolean; from: number; compressed: number; size: number; method: number; crc: number; offset: number; limit: number }[] = [];
	const paths = new Map<string, { name: string; dir: boolean; explicit: boolean }>();
	const rawNames = new Set<string>();
	let cursor = start, expanded = 0;
	for (let i = 0; i < total; i++) {
		if (cursor + 46 > end || u32(cursor) !== 0x02014b50) bad("invalid directory record");
		const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16), compressed = u32(cursor + 20), size = u32(cursor + 24);
		const length = u16(cursor + 28), next = cursor + 46 + length + u16(cursor + 30) + u16(cursor + 32);
		if (!length || next > end || u16(cursor + 34) || (flags & ~0x080e) || (method !== 0 && method !== 8)) bad("unsupported member");
		const raw = zip.subarray(cursor + 46, cursor + 46 + length);
		const full = utf8.decode(raw), dir = full.endsWith("/"), name = dir ? full.slice(0, -1) : full;
		const parts = name.split("/");
		if (name.length > 240 || parts.length > 16 || parts.some(part => !segment.test(part) || part.endsWith(".") || reserved.test(part))) bad("unsafe member name");
		if (rawNames.has(name)) bad("duplicate member");
		rawNames.add(name);
		for (let n = 1; n <= parts.length; n++) {
			const spelling = parts.slice(0, n).join("/"), folded = spelling.toLowerCase(), explicit = n === parts.length;
			const folder = !explicit || dir, existing = paths.get(folded);
			if (existing && (existing.name !== spelling || existing.dir !== folder || (explicit && existing.explicit))) bad("conflicting member paths");
			if (!existing || explicit) paths.set(folded, { name: spelling, dir: folder, explicit });
		}
		const attrs = u32(cursor + 38), kind = (attrs >>> 16) & 0xf000;
		if ((attrs & 0x400) || (kind && kind !== (dir ? 0x4000 : 0x8000)) || (!dir && (attrs & 0x10))) bad("non-regular member");
		if ((dir && size !== 0) || (method === 0 && size !== compressed) || size > FILE_LIMIT || (expanded += size) > EXPANDED_LIMIT) bad("expanded size");
		const offset = u32(cursor + 42);
		if (offset + 30 > start || u32(offset) !== 0x04034b50 || u16(offset + 6) !== flags || u16(offset + 8) !== method || u16(offset + 26) !== length) bad("inconsistent local header");
		const from = offset + 30 + length + u16(offset + 28);
		let limit = from + compressed;
		if (limit > start || !raw.equals(zip.subarray(offset + 30, offset + 30 + length))) bad("inconsistent local member");
		if (flags & 8) {
			// Data descriptors may be signed or unsigned; the CRC itself can equal the signature.
			const matches = (at: number) => at + 12 <= start && u32(at) === crc && u32(at + 4) === compressed && u32(at + 8) === size;
			if (limit + 16 <= start && u32(limit) === 0x08074b50 && matches(limit + 4)) limit += 16;
			else if (matches(limit)) limit += 12;
			else bad("inconsistent data descriptor");
		} else if (u32(offset + 14) !== crc || u32(offset + 18) !== compressed || u32(offset + 22) !== size) bad("inconsistent member size");
		entries.push({ name, dir, from, compressed, size, method, crc, offset, limit });
		cursor = next;
	}
	if (cursor !== end) bad("trailing directory data");
	let expectedOffset = 0;
	for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
		if (entry.offset !== expectedOffset) bad("overlapping or unexpected archive data");
		expectedOffset = entry.limit;
	}
	if (expectedOffset !== start) bad("unexpected archive data");
	const wrapped = `${id}/dist/`;
	const prefixes = ["", wrapped].filter(prefix => entries.some(entry => !entry.dir && entry.name === `${prefix}manifest.json`));
	if (prefixes.length !== 1) bad("expected one built manifest at the root or <id>/dist/");
	const files = new Map<string, Buffer>(), prefix = prefixes[0]!;
	for (const entry of entries) {
		if (entry.dir || !entry.name.startsWith(prefix)) continue;
		const name = entry.name.slice(prefix.length);
		if (name.split("/").some(part => part.toLowerCase() === "data")) bad("package contains plugin data");
		// The host reads root files and assets only. Do not write screenshots or
		// other documentation trees into the runtime root.
		if (name.includes("/") && !name.startsWith("assets/")) continue;
		const bytes = zip.subarray(entry.from, entry.from + entry.compressed);
		const contents = entry.method === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: Math.max(1, entry.size) });
		if (contents.length !== entry.size || crc32(contents) !== entry.crc) bad("corrupt member");
		files.set(name, contents);
	}
	return files;
}
