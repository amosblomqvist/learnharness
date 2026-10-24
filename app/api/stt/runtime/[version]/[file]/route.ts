/**
 * GET /api/stt/runtime/<onnxruntime-web version>/<file> — the ONNX
 * runtime the in-app dictation engine runs on. Fetched from jsdelivr the
 * first time and kept in the data dir, so local dictation works offline
 * from then on (and the desktop bundle doesn't carry ~27 MB of wasm).
 */
import fs from "node:fs";
import { Readable } from "node:stream";
import { contentTypeFor, runtimeFilePath } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ version: string; file: string }> }) {
	const { version, file } = await ctx.params;
	const full = await runtimeFilePath(version, file).catch(() => null);
	if (!full) return new Response("Not found", { status: 404 });
	return new Response(Readable.toWeb(fs.createReadStream(full)) as ReadableStream, {
		headers: {
			"Content-Type": contentTypeFor(full),
			"Content-Length": String(fs.statSync(full).size),
			"Cache-Control": "no-store",
		},
	});
}
