/**
 * GET/DELETE /api/subscription — sanitized subscription status and local
 * disconnect. The transport guard, body rules, and no-store headers live in
 * the shared helper so these handlers stay thin.
 */
import { createSubscriptionHttpHandlersFromEnvironment, subscriptionService, type SubscriptionHttpHandlers } from "@/src/server";

export const dynamic = "force-dynamic";

let handlers: SubscriptionHttpHandlers | undefined;
function current(): SubscriptionHttpHandlers {
	return (handlers ??= createSubscriptionHttpHandlersFromEnvironment(subscriptionService()));
}

export async function GET(request: Request): Promise<Response> {
	return current().getStatus(request);
}

export async function DELETE(request: Request): Promise<Response> {
	return current().disconnect(request);
}
