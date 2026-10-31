"use client";

/**
 * Auth forms (mobile-web, 2026-10-29): first-run setup, login and invite
 * acceptance. One client module so the three pages share validation copy and
 * the same touch-friendly field chrome.
 */

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LhMark } from "@/components/lh-mark";

function Card({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
	return (
		<div className="rounded-xl border border-border bg-card/70 p-6 shadow-sm">
			<div className="mb-5 flex items-center gap-2">
				<LhMark className="size-5" />
				<span className="font-title text-sm tracking-tight text-foreground">Learning Harness</span>
			</div>
			<h1 className="font-title text-2xl tracking-tight text-foreground">{title}</h1>
			<p className="mt-1 mb-5 text-sm text-muted-foreground">{subtitle}</p>
			{children}
		</div>
	);
}

function Field({
	label,
	name,
	type = "text",
	autoComplete,
	defaultValue,
	required = true,
	minLength,
}: {
	label: string;
	name: string;
	type?: string;
	autoComplete?: string;
	defaultValue?: string;
	required?: boolean;
	minLength?: number;
}) {
	return (
		<label className="mb-3 block">
			<span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
			<Input
				className="h-11 text-base md:text-base"
				name={name}
				type={type}
				autoComplete={autoComplete}
				defaultValue={defaultValue}
				required={required}
				minLength={minLength}
				autoCapitalize="none"
				autoCorrect="off"
			/>
		</label>
	);
}

function ErrorNote({ message }: { message: string | null }) {
	if (!message) return null;
	return (
		<p role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{message}
		</p>
	);
}

async function post(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (res.ok) return { ok: true };
		const data = (await res.json().catch(() => ({}))) as { error?: string };
		return { ok: false, message: data.error ?? "Something went wrong. Try again." };
	} catch {
		return { ok: false, message: "Could not reach the server." };
	}
}

function useSubmit(action: (body: Record<string, unknown>) => Promise<{ ok: boolean; message?: string }>, next: string) {
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const submit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setError(null);
		const data = new FormData(event.currentTarget);
		const body: Record<string, unknown> = {};
		data.forEach((value, key) => {
			body[key] = value;
		});
		const result = await action(body);
		if (result.ok) {
			router.replace(next);
			router.refresh();
			return;
		}
		setBusy(false);
		setError(result.message ?? "Something went wrong. Try again.");
	};
	return { submit, error, busy };
}

export function SetupForm() {
	const { submit, error, busy } = useSubmit((body) => post("/api/auth/setup", body), "/");
	return (
		<Card title="Create your account" subtitle="This server is new. The first account is the admin and can invite everyone else.">
			<form onSubmit={submit}>
				<Field label="Name" name="name" autoComplete="name" />
				<Field label="Email" name="email" type="email" autoComplete="username" />
				<Field label="Password" name="password" type="password" autoComplete="new-password" minLength={10} />
				<ErrorNote message={error} />
				<Button type="submit" size="lg" className="h-11 w-full" disabled={busy}>
					{busy ? "Creating…" : "Create account"}
				</Button>
			</form>
		</Card>
	);
}

export function LoginForm({ next, hasAccounts = true }: { next: string; hasAccounts?: boolean }) {
	const { submit, error, busy } = useSubmit((body) => post("/api/auth/login", body), next);
	return (
		<Card title="Sign in" subtitle={hasAccounts ? "Use the account your admin created for you." : "Sign in to continue."}>
			<form onSubmit={submit}>
				<Field label="Email" name="email" type="email" autoComplete="username" />
				<Field label="Password" name="password" type="password" autoComplete="current-password" />
				<ErrorNote message={error} />
				<Button type="submit" size="lg" className="h-11 w-full" disabled={busy}>
					{busy ? "Signing in…" : "Sign in"}
				</Button>
			</form>
		</Card>
	);
}

export function JoinForm({ code, email }: { code: string; email?: string }) {
	const { submit, error, busy } = useSubmit((body) => post("/api/auth/join", { ...body, code }), "/");
	return (
		<Card title="You're invited" subtitle="Pick a name and a password to join this Learning Harness.">
			<form onSubmit={submit}>
				<Field label="Name" name="name" autoComplete="name" />
				{email ? (
					<input type="hidden" name="email" value={email} />
				) : (
					<Field label="Email" name="email" type="email" autoComplete="username" />
				)}
				<Field label="Password" name="password" type="password" autoComplete="new-password" minLength={10} />
				<ErrorNote message={error} />
				<Button type="submit" size="lg" className="h-11 w-full" disabled={busy}>
					{busy ? "Joining…" : "Join"}
				</Button>
			</form>
		</Card>
	);
}
