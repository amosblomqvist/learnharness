import { antigravityInstallationResponse } from "@/src/server";

export async function GET(request: Request) {
	return antigravityInstallationResponse(request);
}
