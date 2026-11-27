import { communityPluginCatalog } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return communityPluginCatalog.list(request); }
