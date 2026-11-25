import { PluginViewScreen } from "@/components/plugin-view";

export default async function PluginPage({ params }: { params: Promise<{ pluginId: string; viewId: string }> }) {
	const { pluginId, viewId } = await params;
	return <PluginViewScreen pluginId={pluginId} viewId={viewId} />;
}
