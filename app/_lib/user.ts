import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, registryExists, sessionProfileId } from "@/src/server";

/** The signed-in profile on this browser, or null. */
export async function pageUserId(): Promise<string | null> {
	if (!registryExists()) return null;
	return sessionProfileId((await cookies()).get(SESSION_COOKIE)?.value);
}

/** Pages behind a profile: an unclaimed install or a missing session
 *  lands on the select screen. */
export async function requirePageUser(): Promise<string> {
	const userId = await pageUserId();
	if (!userId) redirect("/users");
	return userId;
}
