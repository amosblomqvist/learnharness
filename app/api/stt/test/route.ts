import { localDictationTestPost } from "@/src/server";

export const runtime = "nodejs";
export function POST(request: Request) {
	return localDictationTestPost(request);
}
