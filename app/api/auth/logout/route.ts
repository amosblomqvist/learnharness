/** POST /api/auth/logout — clears this device's session cookie. */
import { logoutResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export function POST(): Response {
	return logoutResponse();
}
