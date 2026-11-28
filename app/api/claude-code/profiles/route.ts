import { claudeCodeProfilesResponse } from "@/src/server";

export const dynamic = "force-dynamic";

/** Non-secret Claude Code config directory discovery only. */
export async function GET(request: Request) {
	return claudeCodeProfilesResponse(request);
}
