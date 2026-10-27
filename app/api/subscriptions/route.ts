import { subscriptionControlsResponse, withUser } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withUser(subscriptionControlsResponse);
export const POST = withUser(subscriptionControlsResponse);
