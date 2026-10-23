/**
 * GET /api/connections/login/:id — poll an attempt (LoginAttemptView).
 * POST {promptId, value} — answer the active prompt; returns the view.
 * DELETE — cancel the attempt; returns the view.
 */
import {
	answerSubscriptionLogin,
	cancelSubscriptionLogin,
	connectionErrorResponse,
	connectionGuard,
	getSubscriptionLogin,
	noStoreJson,
	readJsonBody,
} from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
	const denied = connectionGuard(request, false);
	if (denied) return denied;
	try {
		const { id } = await params;
		return noStoreJson(getSubscriptionLogin(id));
	} catch (err) {
		return connectionErrorResponse(err);
	}
}

export async function POST(request: Request, { params }: Params) {
	const denied = connectionGuard(request);
	if (denied) return denied;
	try {
		const { id } = await params;
		const body = await readJsonBody(request);
		return noStoreJson(answerSubscriptionLogin(id, body.promptId, body.value));
	} catch (err) {
		return connectionErrorResponse(err);
	}
}

export async function DELETE(request: Request, { params }: Params) {
	const denied = connectionGuard(request);
	if (denied) return denied;
	try {
		const { id } = await params;
		return noStoreJson(await cancelSubscriptionLogin(id));
	} catch (err) {
		return connectionErrorResponse(err);
	}
}
