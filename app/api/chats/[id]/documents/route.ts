import {
	getDocuments,
	parseDocumentFile,
	saveDocument,
	deleteDocument,
	stores,
	type DocumentCategory,
} from "@/src/server";
import { newDocumentContextMessage } from "@/src/core";

export const dynamic = "force-dynamic";

export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const docs = await getDocuments(id);
	return Response.json({ documents: docs });
}

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const { id } = await params;
		const form = await req.formData();
		const files = form.getAll("files").filter((f): f is File => f instanceof File);
		const rawCategory = form.get("category");
		const category: DocumentCategory = rawCategory === "exam" ? "exam" : "lecture";

		if (files.length === 0) {
			return Response.json({ error: "No files provided" }, { status: 400 });
		}

		const parsedDocs = [];
		for (const file of files) {
			const docId = `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
			const arrayBuf = await file.arrayBuffer();
			const buffer = Buffer.from(arrayBuf);
			const parsed = await parseDocumentFile(docId, file.name, buffer, category);
			await saveDocument(id, parsed, buffer);
			parsedDocs.push(parsed);
		}

		// Append or update document context message while keeping existing conversation messages
		if (parsedDocs.length > 0) {
			const allDocs = await getDocuments(id);
			const chat = stores.chatStore.getChat(id);
			if (chat) {
				const nonDocMessages = chat.messages.filter(
					(m) => !(m.role === "custom" && (m as { customType?: string }).customType === "document-context"),
				);
				stores.chatStore.saveMessages(id, [newDocumentContextMessage(allDocs), ...nonDocMessages]);
			}
		}

		return Response.json({ documents: parsedDocs });
	} catch (err) {
		console.error("[documents-route] POST error:", err);
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}

export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const { id } = await params;
		const { searchParams } = new URL(req.url);
		const docId = searchParams.get("docId");
		if (!docId) {
			return Response.json({ error: "Missing docId" }, { status: 400 });
		}

		await deleteDocument(id, docId);
		const allDocs = await getDocuments(id);
		const chat = stores.chatStore.getChat(id);
		if (chat) {
			const nonDocMessages = chat.messages.filter(
				(m) => !(m.role === "custom" && (m as { customType?: string }).customType === "document-context"),
			);
			if (allDocs.length > 0) {
				stores.chatStore.saveMessages(id, [newDocumentContextMessage(allDocs), ...nonDocMessages]);
			} else {
				stores.chatStore.saveMessages(id, nonDocMessages);
			}
		}

		return Response.json({ ok: true });
	} catch (err) {
		console.error("[documents-route] DELETE error:", err);
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}
