declare module "unzipper" {
	import type { Readable } from "node:stream";
	interface ZipEntry {
		path: string;
		type: "File" | "Directory";
		uncompressedSize: number;
		externalFileAttributes: number;
		stream(): Readable;
	}
	export const Open: { buffer(data: Buffer): Promise<{ files: ZipEntry[] }> };
}
