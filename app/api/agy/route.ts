import { agyInstallationResponse } from "@/src/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
	return agyInstallationResponse(request);
}
