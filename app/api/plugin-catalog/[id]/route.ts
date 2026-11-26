import { installCatalogPlugin, readPluginCatalog, readPluginConversation } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Context { params: Promise<{ id: string }> }
export async function GET(_request: Request, context: Context) {
	const { id } = await context.params;
	const { catalog } = await readPluginCatalog();
	const entry = catalog.plugins.find(plugin => plugin.id === id);
	if (!entry) return Response.json({ error: "Plugin is not listed" }, { status: 404 });
	try { return Response.json(await readPluginConversation(entry.issueNumber), { headers: { "Cache-Control": "no-store" } }); }
	catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub comments unavailable" }, { status: 503 }); }
}
export async function POST(_request: Request, context: Context) {
	const { id } = await context.params;
	// Never use a stale or bundled catalog as authority for network code installation.
	const { catalog, stale } = await readPluginCatalog(true);
	if (stale) return Response.json({ error: "A current reviewed catalog is required to install a plugin" }, { status: 503 });
	const entry = catalog.plugins.find(plugin => plugin.id === id);
	if (!entry) return Response.json({ error: "Plugin is not listed" }, { status: 404 });
	try { await installCatalogPlugin(entry); return Response.json({ installed: id, version: entry.version }); }
	catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Installation failed" }, { status: 400 }); }
}
