// POST /api/answer-intent — which option a dictated answer committed to
// (src/core/answer-intent.ts). Called by a submit that has thinking but no
// clicked option, before the answer is graded on the client.
import { parseAnswerIntentRequest } from "@/src/core";
import { AnswerIntentUnavailable, inferAnswerIntent } from "@/src/server";

export async function POST(request: Request): Promise<Response> {
	let input;
	try {
		input = parseAnswerIntentRequest(await request.json());
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Invalid request" }, { status: 400 });
	}
	try {
		return Response.json(await inferAnswerIntent(input, request.signal));
	} catch (err) {
		const message = err instanceof Error ? err.message : "The Cheap model call failed";
		return Response.json({ error: message }, { status: err instanceof AnswerIntentUnavailable ? 503 : 502 });
	}
}
