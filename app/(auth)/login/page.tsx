import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/forms";
import { resolveScope } from "@/src/server/auth/context.ts";
import { countUsers } from "@/src/store/users.ts";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
	if (countUsers() === 0) redirect("/setup");
	const scope = await resolveScope();
	if (scope) redirect("/");
	const { next } = await searchParams;
	// Only same-origin relative paths: an open redirect on the login bounce is
	// exactly the phish a tunnel-exposed app cannot afford.
	const target = typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/";
	return <LoginForm next={target} />;
}
