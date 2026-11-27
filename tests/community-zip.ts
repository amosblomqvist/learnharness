import { crc32, deflateRawSync } from "node:zlib";

/** Build a ZIP in memory for community catalog fixtures: [name, contents, unix mode]. */
export function zip(entries: [string, string | Buffer, number?][], descriptors = false) {
	const [locals, records] = [[], []] as Buffer[][];
	let offset = 0;
	for (const [name, value, mode = 0x81a4] of entries) {
		const filename = Buffer.from(name), payload = Buffer.from(value), checksum = crc32(payload);
		const compressed = deflateRawSync(payload), flags = descriptors ? 8 : 0;
		const local = Buffer.alloc(30), central = Buffer.alloc(46), descriptor = Buffer.alloc(descriptors ? 16 : 0);
		local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(filename.length, 26);
		if (descriptors) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(payload.length, 12); }
		else { local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(payload.length, 22); }
		central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(8, 10);
		central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(payload.length, 24);
		central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(mode * 65536, 38); central.writeUInt32LE(offset, 42);
		locals!.push(local, filename, compressed, descriptor); records!.push(central, filename); offset += local.length + filename.length + compressed.length + descriptor.length;
	}
	const central = Buffer.concat(records!), end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals!, central, end]);
}
