/**
 * GET /api/stt/files/<model id>/<repo path> — a downloaded dictation
 * model's files, for the in-app engine (transformers.js localModelPath).
 * 404 for anything not downloaded or outside the model's folder. Honors a
 * single `Range: bytes=a-b` (transformers.js probes files with
 * bytes=0-0 — without this the probe would stream the whole file).
 */
import fs from "node:fs";
import { Readable } from "node:stream";
import { contentTypeFor, modelFilePath } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
	const { path: segments } = await ctx.params;
	const file = modelFilePath(segments);
	if (!file) return new Response("Not found", { status: 404 });
	const size = fs.statSync(file).size;
	const headers = { "Content-Type": contentTypeFor(file), "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
	const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
	if (range) {
		const start = Number(range[1]);
		const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
		if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
		return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream, {
			status: 206,
			headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
		});
	}
	return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
		headers: { ...headers, "Content-Length": String(size) },
	});
}
