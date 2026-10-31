import { withUser } from "@/src/server/auth/context.ts";
import { claudeCodeInstallationResponse } from "@/src/server";

/** Installation/version only; never reads auth status or makes a model request. */
export const GET = withUser(async function GET(request: Request){
	return claudeCodeInstallationResponse(request);
});
