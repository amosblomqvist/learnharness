import { parseDocumentFile, type DocumentCategory } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	try {
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
			parsedDocs.push(parsed);
		}

		return Response.json({ documents: parsedDocs });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}
