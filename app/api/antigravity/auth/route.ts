import { antigravityAuthResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	return antigravityAuthResponse(request);
}

export async function DELETE(request: Request) {
	return antigravityAuthResponse(request);
}
