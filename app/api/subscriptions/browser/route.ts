import { withUser } from "@/src/server/auth/context.ts";
import { subscriptionBrowserResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withUser(subscriptionBrowserResponse);
export const POST = withUser(subscriptionBrowserResponse);
