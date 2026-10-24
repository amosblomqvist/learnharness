import { parseXaiSignInCommand } from "@/src/core";
import { xaiSignIn } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(await xaiSignIn({ type: "status" }));
}

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "body must be JSON" }, { status: 400 });
	}
	const command = parseXaiSignInCommand(body);
	if (!command) {
		return Response.json({ error: "body must be {type: start, cancel, or sign-out}" }, { status: 400 });
	}
	return Response.json(await xaiSignIn(command));
}
