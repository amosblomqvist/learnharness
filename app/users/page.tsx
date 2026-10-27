import { redirect } from "next/navigation";
import { UserSelect } from "@/components/user-select";
import { usersSnapshot } from "@/src/server";
import { pageUserId } from "../_lib/user";

export const dynamic = "force-dynamic";

/** The select screen (and, on an unclaimed install, the claim). A browser
 *  that already has a profile open goes back into the app — Change user
 *  ends the session before landing here. */
export default async function UsersPage() {
	if (await pageUserId()) redirect("/");
	return <UserSelect snapshot={usersSnapshot(undefined)} />;
}
