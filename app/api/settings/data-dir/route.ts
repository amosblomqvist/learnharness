import {
	DataDirectoryBusyError,
	DataDirectoryInputError,
	getDataDirectoryStatus,
	mutateDataDirectory,
} from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(getDataDirectoryStatus(), {
		headers: { "Cache-Control": "no-store" },
	});
}

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Expected a JSON object." }, { status: 400 });
	}
	try {
		return Response.json(await mutateDataDirectory(body));
	} catch (error) {
		if (error instanceof DataDirectoryBusyError || (error instanceof Error && error.name === "DataDirectoryBusyError")) {
			return Response.json({ error: error.message }, { status: 409 });
		}
		if (error instanceof DataDirectoryInputError) {
			return Response.json({ error: error.message }, { status: 400 });
		}
		return Response.json({ error: error instanceof Error ? error.message : "Could not change data directory." }, { status: 500 });
	}
}
