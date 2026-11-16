import { antigravityInstallResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	return antigravityInstallResponse(request);
}

export async function DELETE(request: Request) {
	return antigravityInstallResponse(request);
}
