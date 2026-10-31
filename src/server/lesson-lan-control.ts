import { hostname } from "node:os";
import { PATHS } from "../../config.ts";
import { emit } from "../core/index.ts";
import { stores } from "./stores.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { compactionInFlight } from "./compaction.ts";
import { createLessonLan } from "./lesson-lan.ts";

// One listener in the same process as the existing writers, including across Next dev reloads.
const host = globalThis as typeof globalThis & { __lessonLan?: ReturnType<typeof createLessonLan> };
function service() {
	return host.__lessonLan ??= createLessonLan(PATHS.data, {
		name: hostname(),
		lessons: () => stores.chatStore.listChats().map(c => ({ id: c.id, title: c.title })),
		idle(ids, importing) {
			const extracting = extractionStatuses();
			if ((importing && extracting.length) || ids.some(id => isTurnRunning(id) || compactionInFlight(id) || extracting.some(e => e.chatId === id) || stores.jobStore.listJobs(id).some(j => j.status === "running"))) throw new Error("Wait for running work");
		},
		changed(ids) {
			emit("chats-changed", {}); for (const chatId of ids) emit("record-changed", { chatId }); emit("activity-changed", {});
		},
	});
}
export async function lessonLanControl(request: Request): Promise<Response> {
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	const url = new URL(request.url);
	if (request.headers.get("origin") !== url.origin || request.headers.get("sec-fetch-site") === "cross-site" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
		return Response.json({ error: "Use the local LearnHarness window" }, { status: 403, headers });
	try {
		if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("JSON required");
		const reader = request.body?.getReader(); if (!reader) throw new Error("Missing action");
		const chunks: Uint8Array[] = []; let length = 0;
		try { for (;;) { const { value, done } = await reader.read(); if (done) break; if ((length += value.length) > 2048) { await reader.cancel(); throw new Error("Action limit"); } chunks.push(value); } } finally { reader.releaseLock(); }
		const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as { action?: string; id?: string };
		const lan = service();
		if (body.action === "start") await lan.start();
		else if (body.action === "stop") await lan.stop();
		// ponytail: first private IPv4; add route-aware selection if competing adapters prevent pairing.
		else if (body.action === "pair") return Response.json(await lan.pairing(lan.status().addresses[0] ?? ""), { headers });
		else if (body.action === "revoke" && typeof body.id === "string") lan.revoke(body.id);
		else if (body.action !== "status") throw new Error("Unknown action");
		return Response.json(lan.status(), { headers });
	} catch { return Response.json({ error: "Could not connect. Check that both devices are on the same Wi-Fi network." }, { status: 409, headers }); }
}
