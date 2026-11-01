/** GET /login — the server-mode sign-in page (src/server/remote-access.ts). */
import { loginPageResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
	return loginPageResponse(request);
}
