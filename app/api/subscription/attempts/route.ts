/** POST /api/subscription/attempts — start one explicit authorization attempt. */
import { createSubscriptionHttpHandlersFromEnvironment, subscriptionService, type SubscriptionHttpHandlers } from "@/src/server";

export const dynamic = "force-dynamic";

let handlers: SubscriptionHttpHandlers | undefined;
function current(): SubscriptionHttpHandlers {
	const service = subscriptionService();
	return (handlers ??= createSubscriptionHttpHandlersFromEnvironment(service, { rateLimitKey: service.store.directory }));
}

export async function POST(request: Request): Promise<Response> {
	return current().start(request);
}
