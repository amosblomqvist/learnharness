import { deleteSources, readOrganizationAction, sourceDirectory, SourceDeletionError, SourceOrganizationInputError } from "@/src/server";
import { emit } from "@/src/core";
import { tr } from "@/src/core";

export const dynamic = "force-dynamic";

export async function GET() {
	try { return Response.json(sourceDirectory.read()); }
	catch { return Response.json({ error: tr("无法读取来源分类。", "Could not read source organization.") }, { status: 500 }); }
}

export async function DELETE(request: Request) {
	try { return Response.json(deleteSources(await readOrganizationAction(request))); }
	catch (error) {
		if (error instanceof SourceDeletionError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
		if (error instanceof SourceOrganizationInputError) return Response.json({ error: error.message }, { status: 400 });
		return Response.json({ error: tr("未能完成来源删除。部分条目可能已被移除，请刷新或重试。", "Could not finish source deletion. Some entries may already have been removed; refresh or retry.") }, { status: 500 });
	} finally {
		emit("sources-changed", {}); emit("chats-changed", {}); emit("activity-changed", {});
	}
}

export async function POST(request: Request) {
	try { return Response.json(sourceDirectory.change(await readOrganizationAction(request))); }
	catch (error) {
		const input = error instanceof SourceOrganizationInputError;
		return Response.json({ error: input ? error.message : tr("无法保存来源分类。", "Could not save source organization.") }, { status: input ? 400 : 500 });
	}
}
