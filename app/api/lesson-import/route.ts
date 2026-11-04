import { PATHS } from "@/config";
import type { ImportChoices } from "@/src/core";
import { emit } from "@/src/core";
import { previewImport, installImport, readImportPackage, isTurnRunning, compactionInFlight, extractionStatuses, stores } from "@/src/server";

export const runtime = "nodejs";
const LIMIT = 32 * 1024 * 1024;
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function foreign(request: Request) {
	const origin = request.headers.get("origin");
	return (origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site";
}
export async function POST(request: Request): Promise<Response> {
	if (foreign(request)) return Response.json({ error: "Use the LearnHarness window to import lessons" }, { status: 403, headers });
	if (!request.headers.get("content-type")?.startsWith("multipart/form-data;")) return Response.json({ error: "Choose a ZIP or JSON file" }, { status: 415, headers });
	try {
		const reader = request.body?.getReader(); if (!reader) throw new Error("Missing file");
		const chunks: Uint8Array[] = []; let length = 0;
		try {
			for (;;) {
				const { value, done } = await reader.read(); if (done) break;
				if ((length += value.length) > LIMIT + 65_536) { await reader.cancel(); throw new Error("Request limit"); }
				chunks.push(value);
			}
		} finally { reader.releaseLock(); }
		const form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": request.headers.get("content-type")! } }).formData();
		if ([...form.keys()].some(k => !["file", "action", "revision", "choices"].includes(k)) || [...new Set(form.keys())].some(k => form.getAll(k).length !== 1)) throw new Error("Invalid fields");
		const file = form.get("file"), action = form.get("action");
		if (!(file instanceof File) || file.size > LIMIT || !["preview", "install"].includes(action as string)) throw new Error("Invalid import");
		const bytes = new Uint8Array(await file.arrayBuffer());
		const pack = readImportPackage(bytes);
		if (extractionStatuses().length || pack.chats.some(c => isTurnRunning(c.record.id) || compactionInFlight(c.record.id) || stores.jobStore.listJobs(c.record.id).some(j => j.status === "running")))
			return Response.json({ error: "Wait for graph extraction and the selected lessons' generation, compaction and jobs to finish" }, { status: 409, headers });
		// No awaits inside the revision check + install; in-process writers cannot interleave.
		if (action === "preview") return Response.json(previewImport(PATHS.data, bytes), { headers });
		const revision = form.get("revision"), rawChoices = form.get("choices");
		if (typeof revision !== "string" || typeof rawChoices !== "string" || rawChoices.length > 65_536) throw new Error("Missing approval");
		const choices: unknown = JSON.parse(rawChoices);
		if (!choices || typeof choices !== "object" || Array.isArray(choices) || Object.values(choices).some(v => !["local", "incoming"].includes(v as string))) throw new Error("Invalid conflict choices");
		const result = installImport(PATHS.data, bytes, { revision, choices: choices as ImportChoices });
		emit("chats-changed", {});
		for (const chatId of result.installed) emit("record-changed", { chatId });
		emit("activity-changed", {});
		return Response.json(result, { headers });
	} catch {
		return Response.json({ error: "Could not import. Try the file again: the library may have changed, a conflict may be unresolved, or the lesson or graph format may be unsupported. ZIPs with external files cannot be imported. No partial import was saved." }, { status: 400, headers });
	}
}
