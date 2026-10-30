import { PATHS } from "@/config";
import type { ExportMode } from "@/src/core";
import { previewExport, downloadExport, isTurnRunning, compactionInFlight, extractionStatuses, stores } from "@/src/server";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
export async function POST(request: Request): Promise<Response> {
	const origin = request.headers.get("origin");
	if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site")
		return Response.json({ error: "Use the LearnHarness window to export lessons" }, { status: 403, headers });
	if (!request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "JSON required" }, { status: 415, headers });
	try {
		const reader = request.body?.getReader();
		if (!reader) throw new Error("Missing selection");
		const chunks: Uint8Array[] = []; let length = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if ((length += value.length) > 65_536) { await reader.cancel(); throw new Error("Selection too large"); }
				chunks.push(value);
			}
		} finally { reader.releaseLock(); }
		const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as {
			ids: string[]; mode: ExportMode; preview?: boolean; revision?: string; files?: number[]; allowIncomplete?: boolean;
		};
		if (!Array.isArray(body.ids) || body.ids.length > 100 || body.ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id)))
			throw new Error("Invalid lesson selection");
		const extracting = extractionStatuses();
		if (body.ids.some(id => isTurnRunning(id) || compactionInFlight(id) || extracting.some(e => e.chatId === id) || stores.jobStore.listJobs(id).some(j => j.status === "running")))
			return Response.json({ error: "Wait for selected lessons' generation, compaction and background jobs to finish" }, { status: 409, headers });
		// This synchronous snapshot/download block cannot interleave with in-process writers.
		if (body.preview) return Response.json(previewExport(PATHS.data, body.ids), { headers });
		const file = downloadExport(PATHS.data, body.ids, body.mode, {
			revision: body.revision ?? "", files: body.files ?? [], allowIncomplete: body.allowIncomplete === true,
		});
		return new Response(new Uint8Array(file.bytes), { headers: { ...headers, "Content-Type": file.type, "Content-Disposition": `attachment; filename="${file.name}"` } });
	} catch {
		// No parser diagnostics or local paths in transport errors. The reviewed source list
		// is the only place local paths are intentionally exposed to the trusted window.
		return Response.json({ error: "Export failed. Check the selection and preview again; unsupported, changed or oversized data cannot be exported." }, { status: 400, headers });
	}
}
