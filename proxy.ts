import { NextResponse, type NextRequest } from "next/server";
import { apiRequestRefusal } from "./src/server/desktop-access.ts";

/** Protects API methods, including SSE and spending/settings routes. The one
 * streamed document route enforces the identical all-method request policy
 * inside its handler, avoiding Next's silently truncated Proxy body clone.
 * No public callback or worker bypass: legitimate self-HTTP still needs the capability. */
export function proxy(request: NextRequest) {
	const refusal = apiRequestRefusal(request);
	if (refusal) {
		return NextResponse.json(
			{ error: refusal },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = {
	// Keep /api itself covered; exempt only the exact streamed endpoint, not
	// the documents subtree or other plugin routes. Must remain static literals.
	matcher: ["/api", "/api/((?!plugins/[^/]+/documents/markdown/?$).*)"],
};
