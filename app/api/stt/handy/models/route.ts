import { listHandyModels } from "@/src/server";

export async function GET() {
	const result = await listHandyModels();
	return Response.json(result);
}
