import * as fs from "node:fs";
import { Readable } from "node:stream";
import { stores } from "@/src/server";

/** GET /api/library/files/[id]/content — the stored original, inline (the
 *  library page's open/preview). ?download=1 forces a save. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const item = stores.libraryStore.getItem(id);
	if (!item?.file) return Response.json({ error: "Not found" }, { status: 404 });
	const filePath = stores.libraryStore.originalPath(id);
	if (!fs.existsSync(filePath)) return Response.json({ error: "Not found" }, { status: 404 });
	const download = new URL(req.url).searchParams.get("download") === "1";
	const stream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>;
	return new Response(stream, {
		headers: {
			"Content-Type": item.file.mime,
			"Content-Length": String(item.file.bytes),
			"Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
