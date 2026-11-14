import { codexInstallationResponse } from "@/src/server";

/** Installation/version only; never reads auth status or makes a model request. */
export async function GET(request: Request) {
	return codexInstallationResponse(request);
}
