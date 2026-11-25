import { claudeCodeInstallationResponse } from "@/src/server";

/** Installation/version only; never reads auth status or makes a model request. */
export async function GET(request: Request) {
	return claudeCodeInstallationResponse(request);
}
