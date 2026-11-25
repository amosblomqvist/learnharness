/**
 * GET /api/graph/status — the in-flight background extraction runs
 * (vision §1: the pipeline status must be visible on the home graph).
 * Thin transport over the pipeline's module-level registry: phase
 * (queued / extracting / waiting / auditing / merging) per job, oldest
 * first — a multi-chunk source shows one row PER CHUNK ("· i/N" suffix,
 * per-chunk jobs, owner 2026-09-28). Titles joined from the chat store;
 * a missing chat record still reports the run.
 */
import { chatStore, extractionStatuses } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const runs = extractionStatuses().map((run) => ({
		// Unique row id (the registry job key: source id, or "src#i" for
		// chunk jobs) — one source's rows share chatId, and React keys on
		// it would collide. chatId stays the SOURCE id: reveal/cost
		// tracking in the view is source-scoped by design.
		id: run.part ? `${run.chatId}#${run.part.i}` : run.chatId,
		chatId: run.chatId,
		// The run's own label (the file path for notes imports) wins; chat
		// runs fall back to the chat store's title. Chunk jobs append their
		// part ("· 2/5") — one row per chunk of the fan-out.
		title:
			(run.label ?? chatStore.getChat(run.chatId)?.title ?? run.chatId) +
			(run.part ? ` · ${run.part.i}/${run.part.n}` : ""),
		phase: run.phase,
		startedAt: run.startedAt,
		// Live per-stage usage (the money channel): model + per-step CallUsage,
		// accumulated as steps bill. Cost and context-window folds are the
		// consumer's (core/prices.ts helpers — nothing stores dollars).
		usage: run.usage,
	}));
	return Response.json({ runs });
}
