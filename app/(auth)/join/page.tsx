import { redirect } from "next/navigation";
import { JoinForm } from "@/components/auth/forms";
import { pendingInvite, countUsers } from "@/src/store/users.ts";

export const dynamic = "force-dynamic";

export default async function JoinPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
	if (countUsers() === 0) redirect("/setup");
	const { code } = await searchParams;
	const invite = typeof code === "string" ? pendingInvite(code) : null;
	if (typeof code !== "string" || !code) {
		return <p className="text-sm text-muted-foreground">This invite link is incomplete — ask your admin for a new one.</p>;
	}
	if (!invite) {
		return (
			<div className="rounded-xl border border-border bg-card/70 p-6 text-sm text-muted-foreground">
				This invite is invalid or has expired. Ask your admin to send a fresh link.
			</div>
		);
	}
	return <JoinForm code={code} email={invite.email} />;
}
