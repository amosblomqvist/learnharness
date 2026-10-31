import { redirect } from "next/navigation";
import { SetupForm } from "@/components/auth/forms";
import { countUsers } from "@/src/store/users.ts";

export const dynamic = "force-dynamic";

export default function SetupPage() {
	// First-run only: once an account exists this page is a dead end.
	if (countUsers() > 0) redirect("/login");
	return <SetupForm />;
}
