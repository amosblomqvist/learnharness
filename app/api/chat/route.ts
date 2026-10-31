import { withUser } from "@/src/server/auth/context.ts";
import { handleChatRequest } from "@/src/server";

export const POST = withUser(async function POST(req: Request) {
	return handleChatRequest(req);
});
