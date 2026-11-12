import { createPluginDocumentRoute, pluginTransport } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This exact route skips Proxy body cloning, NOT desktop authentication.
const handlers = createPluginDocumentRoute(pluginTransport);
export const POST = handlers.POST;
export const OPTIONS = handlers.OPTIONS;
export const GET = handlers.GET;
export const HEAD = handlers.HEAD;
export const PUT = handlers.PUT;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
