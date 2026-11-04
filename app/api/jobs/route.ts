import { isTurnRunning, listJobs, retryDemoJob, JobRetryError } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * Job status endpoint (contracts.ts "THE ASYNC PROTOCOL" §4): the chat
 * view's jobs fetch lands here — once on mount, per jobs-changed
 * announcement (the store emits post-write, debounced client-side), and
 * on channel resync (push-architecture S4, 2026-10-02 — the old interval
 * poll is retired). It drives the dispatch cards, the sub-agents panel,
 * and the re-sync when a job settles. `turnInFlight` rides along for the
 * settle logic's idle check.
 */
export async function GET(req: Request) {
	const chatId = new URL(req.url).searchParams.get("chatId");
	if (!chatId) {
		return Response.json({ error: "chatId query parameter is required" }, { status: 400 });
	}
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) {
		return Response.json({ error: "Invalid chatId" }, { status: 400 });
	}
	return Response.json({ jobs: listJobs(chatId), turnInFlight: isTurnRunning(chatId) });
}


/** Retry the original failed demo request without adding a learner message. */
export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || !("chatId" in body) || !("jobId" in body) ||
		typeof body.chatId !== "string" || typeof body.jobId !== "string") {
		return Response.json({ error: "chatId and jobId are required" }, { status: 400 });
	}
	try {
		return Response.json({ job: retryDemoJob(body.chatId, body.jobId) });
	} catch (error) {
		if (error instanceof JobRetryError) return Response.json({ error: error.message }, { status: error.status });
		console.error("[jobs] demo retry failed", error);
		return Response.json({ error: "Could not retry the demo. Try again." }, { status: 500 });
	}
}
