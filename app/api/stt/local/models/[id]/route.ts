import { localModelActionResponse } from "@/src/server";

/** One on-device model: POST starts or resumes its download (`{ "action": "cancel" }` stops it),
 * DELETE removes it. Logic and trust model: src/server/local-stt/http.ts. */
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return localModelActionResponse(request, (await params).id);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return localModelActionResponse(request, (await params).id);
}
