import { withUser } from "@/src/server/auth/context.ts";
import { subscriptionControlsResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withUser(subscriptionControlsResponse);
export const POST = withUser(subscriptionControlsResponse);
