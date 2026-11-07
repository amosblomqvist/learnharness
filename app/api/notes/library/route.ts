import { noteIndex, readTagsLibrary } from "@/src/server";
export function GET(request: Request) {
	const node = new URL(request.url).searchParams.get("node");
	return Response.json(node ? noteIndex(node) : readTagsLibrary());
}
