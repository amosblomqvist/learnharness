/** POST /api/subscription/attempts/:id/input — deliver one manual prompt reply. */
import { createSubscriptionHttpHandlersFromEnvironment, subscriptionService, type SubscriptionHttpHandlers } from "@/src/server";

export const dynamic = "force-dynamic";

let handlers: SubscriptionHttpHandlers | undefined;
function current(): SubscriptionHttpHandlers {
	return (handlers ??= createSubscriptionHttpHandlersFromEnvironment(subscriptionService()));
}

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<Response> {
	const { id } = await params;
	return current().reply(request, id);
}
