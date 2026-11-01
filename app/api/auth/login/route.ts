/** POST /api/auth/login — password in, session cookie out (server mode only). */
import { loginResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
	return loginResponse(request);
}
