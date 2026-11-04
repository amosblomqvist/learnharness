import { speechResponse } from "@/src/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return speechResponse(request, "status"); }
