import { handleChatRequest, withUser } from "@/src/server";

async function handlePOST(req: Request) {
	return handleChatRequest(req);
}

export const POST = withUser(handlePOST);
