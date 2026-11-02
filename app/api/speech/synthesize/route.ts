import { speechResponse } from "@/src/server";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return speechResponse(request, "synthesize"); }
