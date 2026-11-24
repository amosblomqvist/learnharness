import { handleChatRequest } from "@/src/server";

export async function POST(req: Request) {
	return handleChatRequest(req);
}
