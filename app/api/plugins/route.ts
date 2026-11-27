import { pluginTransport } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() { return pluginTransport.list(); }
export function POST(request: Request) { return pluginTransport.refresh(request); }
export function PUT(request: Request) { return pluginTransport.setCommunityEnabled(request); }
